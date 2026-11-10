/**
 * QQ 音乐扫码登录与 musicu.fcg 传输层。
 *
 * 登录只保留 **QQ 音乐 App 扫码**：`music.login.LoginServer/CreateQRCode` 出图，
 * 扫码结果由 App 通过 MQTT over WebSocket 推送（见 `mqtt.ts`），确认后再调
 * `music.login.LoginServer/Login` 换票。App 里登录的是 QQ 还是微信账号都可以，
 * 也不需要开放平台 AppSecret。
 *
 * 换回来的 Cookie 形如 `uin=<musicid>; qm_keyst=<musickey>`（外加 refresh_token
 * 等续期材料）。QQ 的私有接口会随客户端版本变化，因此所有读取都走一个宽松的
 * `call()`：只要求 `code === 0`，字段映射在 `api.ts` 里做多路兼容。
 */

import {
  applySetCookieLines,
  cookieValue,
  mergeCookies,
  parseCookies,
  PlatformNetworkError,
  platformFetch,
  serializeCookies,
} from "../shared/http";
import { unavailable } from "../shared/errors";
import {
  contextFor,
  deviceCookie,
  deviceFrom,
  identityCookie,
  identityFrom,
  newDevice,
  RawNumber,
  type AndroidIdentity,
  type QQCgiResult,
  type QQDevice,
} from "./android";
import { MobileQRSocket } from "./mqtt";

const MUSICU = "https://u.y.qq.com/cgi-bin/musicu.fcg";
/**
 * 旧版歌单详情 CGI（返回 `cdlist` 结构）。
 *
 * 平台给每个账号生成的「今日私享 / 每日30首」歌单，`music.srfDissInfo` 的两个
 * 模块都会回 10006；这个旧 CGI 仍能读到，客户端自己的日推也走它。
 */
const CDLIST = "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg";
const PROFILE = "https://c6.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg";
const REFERER = "https://y.qq.com/";

const MUSIC_HEADERS = {
  "Content-Type": "application/json",
  Referer: REFERER,
  Origin: "https://y.qq.com",
};

export interface QQAccount {
  userId: string;
  nickname: string;
  avatarUrl: string;
}

export interface QQLoginResult {
  credential: string;
  account: QQAccount;
  /** 上游给出 `musickeyCreateTime + keyExpiresIn` 时是真实到期时间（秒），否则 0。 */
  expiresAt: number;
}

export interface QQConflict {
  state: "waiting" | "scanned" | "expired";
}

export type QQLoginState = QQConflict | { state: "success"; result: QQLoginResult };

export interface QQRefreshResult {
  credential: string;
  nickname: string;
  avatarUrl: string;
  /** 0 表示上游没给有效期，调用方需要自己兜底。 */
  expiresAt: number;
}

/**
 * 距真实到期不到这个时间才去调续期接口。
 *
 * 以前每 30 分钟无条件滚一次 refresh token：既可能触发风控 / 限流（104604），
 * 也会在续期失败时被「资料接口还能读」掩盖，直到 musickey 真正过期才掉线。
 * 现在 30 分钟的定时只做普通资料探活，临近到期才消耗一次 refresh 材料。
 */
const REFRESH_AHEAD_SECONDS = 6 * 60 * 60;
/**
 * 两次续期之间的最长间隔。
 *
 * 即使 key 的有效期还很长，refresh_token / refresh_key 也可能有自己的寿命
 * （登录响应里的 `needRefreshKeyIn` 就是在提示这一点）。按天轮换一次，既能
 * 保持续期材料新鲜（与参考实现一致），又不会像以前那样每 30 分钟打一次。
 */
const MAX_ROTATE_SECONDS = 24 * 60 * 60;

export class QQClient {
  cookie: string;

  constructor(cookie = "") {
    this.cookie = cookie;
  }

  /** 登录后凭据里的 QQ 号（纯数字）。`uin`/`musicid` 都可能是它。 */
  get uin(): string {
    for (const key of ["qqmusic_uin", "uin", "musicid", "str_musicid"]) {
      const raw = cookieValue(this.cookie, key).replace(/^o/u, "");
      if (/^[1-9]\d*$/u.test(raw)) {
        return raw;
      }
    }
    return "";
  }

  /** 换票用的一次性密钥 `qm_keyst`（长周期，登录后一直用它）。 */
  get musickey(): string {
    return cookieValue(this.cookie, "qm_keyst") || cookieValue(this.cookie, "musickey");
  }

  /**
   * QQ 音乐 App 扫码二维码。
   *
   * 二维码由 QQ 音乐自己的 `CreateQRCode` 下发（base64 图片），App 里当前
   * 登录的是 QQ 还是微信账号都能扫。
   */
  async createMobileQR(): Promise<{ imageDataUrl: string; qrcodeID: string; cookie: string }> {
    const device = newDevice();
    // CreateQRCode 与普通登录族 CGI 的 ct/cv 不同，但设备指纹、QIMEI、匿名会话
    // 都走同一套：确认后换票时上游要能认出是同一台设备。
    const { code, data } = await contextFor(device).call(
      "music.login.LoginServer",
      "CreateQRCode",
      { tmeAppID: "qqmusic", ct: 11, cv: 14090008 },
      { ct: 23, cv: 0 },
    );
    if (code !== 0) {
      throw unavailable(`QQ 音乐二维码获取失败 (${code})`);
    }
    const image = text(data.qrcode);
    const qrcodeID = text(data.qrcodeID);
    if (!qrcodeID || !/^data:image\//u.test(image)) {
      throw unavailable("QQ 音乐二维码获取失败");
    }
    // 设备身份要跟着二维码会话走：轮询与最终凭据必须复用同一套 OpenUDID/aid。
    // QIMEI 与匿名会话也一起带上，Durable Object 中途被回收后还能恢复同一台设备。
    this.cookie = joinCookies(deviceCookie(device), identityCookie(contextFor(device).snapshot()));
    return { imageDataUrl: image, qrcodeID, cookie: this.cookie };
  }

  /**
   * 等 QQ 音乐 App 的扫码结果。
   *
   * 扫码 / 确认状态由 App 经 MQTT 推送：`scanned` 只更新提示，`cookies` 里带着
   * 换票用的 musicid 与 token，再用 `Login` 换正式凭据。`CheckQRCode` 只能看到
   * 「等待 / 已扫 / 过期」，确认之后也拿不到凭据，所以这里不再用它。
   *
   * 面板每 2 秒轮询一次，服务端在这里最多挂住 `waitMs`（长轮询），把连接
   * 空档压到最短；超时返回 waiting，让浏览器发起下一轮。
   */
  async checkMobileQR(
    qrcodeID: string,
    waitMs = 20_000,
    existing?: MobileQRSocket,
  ): Promise<QQLoginState> {
    if (!qrcodeID) {
      throw unavailable("QQ 音乐二维码会话已失效");
    }
    const device = deviceFrom(this.cookie);
    // 二维码阶段申请的 QIMEI / 匿名会话如果已经写进 Cookie，就原样恢复，
    // 换票时上游看到的仍是同一台设备。
    const context = contextFor(device, identityFrom(this.cookie));
    const socket = existing ?? new MobileQRSocket(qrcodeID);
    // 传进来的连接由会话池持有：等待超时或已扫码时不能关，否则会漏掉后续
    // 的 `cookies` 推送。只有终态（成功 / 过期 / 失败）才释放。
    let keep = existing !== undefined;
    try {
      const event = await socket.wait(waitMs);
      if (!event) {
        return { state: "waiting" };
      }
      if (event.kind === "scanned") {
        return { state: "scanned" };
      }

      keep = false;
      if (event.kind === "canceled" || event.kind === "timeout") {
        return { state: "expired" };
      }
      if (event.kind === "failed") {
        throw unavailable("QQ 音乐扫码登录失败");
      }
      if (event.kind === "closed") {
        // 建连失败 / 对端断开不是业务失败：二维码还有效，交给下一轮重连。
        // 退一秒再回，避免前端在持续失败时空转。
        console.warn("qq mobile mqtt closed", { qrcodeID, reason: event.reason });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return { state: "waiting" };
      }

      // 微信账号的 musicid 最长 19 位，超过 JS 的安全整数范围。这里必须把
      // 原始数字**原样**写进 JSON：先 `Number()` 再序列化会四舍五入，上游拿
      // 到的 musicid 与 token 不匹配，只会回一个笼统的 50006。
      const musicid = /^[1-9]\d*$/u.test(event.uin) ? event.uin : "";
      console.log("qq mobile login exchange", {
        uinLength: event.uin.length,
        uinNumeric: musicid !== "",
        uinSafe: Number.isSafeInteger(Number(event.uin)),
      });
      try {
        const { code, data, cookies, topCode, topMsg } = await context.call(
          "music.login.LoginServer",
          "Login",
          { musicid: musicid ? new RawNumber(musicid) : 0, qrCodeID: qrcodeID, token: event.key },
          { tmeLoginType: 6 },
        );
        if (code !== 0) {
          // 失败原因要能在日志里定位；token / cookies 一律不打印。
          console.warn("qq mobile login rejected", {
            code,
            topCode,
            topMsg: topMsg.slice(0, 120),
            errtip: text(data.errtip).slice(0, 120),
            errMsg: text(data.errMsg).slice(0, 120),
            uinLength: event.uin.length,
          });
          throw unavailable(`QQ 音乐扫码登录失败 (${code})`);
        }
        const result = this.loginSuccess(data, device, 6, cookies);
        socket.loginSucceeded();
        return result;
      } catch (error) {
        // 换票失败才允许服务端的下一次 `cookies` 推送重试。
        socket.loginFailed();
        throw error;
      }
    } finally {
      if (!keep) {
        socket.close();
      }
    }
  }

  /** 把一次成功的换票响应整理成 `QQLoginState`。 */
  private loginSuccess(
    data: Record<string, unknown>,
    device: QQDevice,
    fallbackLoginType: number,
    cookieLines: string[],
  ): QQLoginState {
    const loginType = loginTypeOf(data, fallbackLoginType);
    const credential = credentialCookies(
      data,
      device,
      loginType,
      applySetCookieLines(new Map(), cookieLines),
      this.cookie,
      contextFor(device).snapshot(),
    );
    const musicid = cookieValue(credential, "uin");
    return {
      state: "success",
      result: {
        credential,
        account: {
          userId: musicid,
          nickname: text(data.nick) || musicid,
          avatarUrl: avatarFor(musicid),
        },
        expiresAt: credentialExpiry(credential),
      },
    };
  }

  /**
   * 探活 / 续期。
   *
   * 每 30 分钟一次的定时任务会走到这里，但**不会**每次都调续期接口：
   * 只有凭据临近真实到期（或拿不到有效期）时，才消耗一次 refresh_token。
   * 其余时候只读一次资料接口确认登录态，避免把续期额度耗在无意义的轮换上。
   *
   * 返回 null 表示凭据已失效（需要重新扫码）；网络错误向上抛（上层标记
   * degraded 稍后重试），不会被误当成「已掉线」。
   */
  async refresh(): Promise<QQRefreshResult | null> {
    const musicid = this.uin;
    const musickey = this.musickey;
    if (!musicid || !musickey) {
      return null;
    }
    const now = Math.floor(Date.now() / 1000);
    const device = deviceFrom(this.cookie);
    const identity = identityFrom(this.cookie);
    const context = contextFor(device, identity);
    // 续期参数按登录方式区分（QQ=2、微信=1、App=6）。面板现在只发 App 凭据，
    // 但旧部署里可能还有 QQ / 微信登录的凭据，没有 loginType 时继续按 QQ 处理。
    const loginType = Number(cookieValue(this.cookie, "loginType")) || 2;
    const refreshToken = cookieValue(this.cookie, "refresh_token");
    const refreshKey = cookieValue(this.cookie, "refresh_key");
    const expiresAt = credentialExpiry(this.cookie);
    // `refresh_after` 是登录 / 上一次续期时算好的下次轮换时间；老凭据没有这个
    // 字段时退回「临期才续」。两者都没有（拿不到有效期）就按天续一次。
    const rotateAt = numberValue(cookieValue(this.cookie, "refresh_after"));
    const nearExpiry =
      rotateAt > 0
        ? now >= rotateAt
        : expiresAt === 0 || expiresAt - REFRESH_AHEAD_SECONDS <= now;
    let refreshRejected = false;
    if (refreshToken && refreshKey && nearExpiry) {
      const openid = cookieValue(this.cookie, "openid");
      const accessToken = cookieValue(this.cookie, "access_token");
      const expiredIn = Number(cookieValue(this.cookie, "expired_at")) || 0;
      const common = { openid, refresh_token: refreshToken, refresh_key: refreshKey, musickey, loginMode: 2 };
      // 与 L-1124/QQMusicApi 的 refresh_credential 对齐：微信只带 refresh 三件套 +
      // str_musicid/unionid；QQ 还要 access_token/musicid；App 登录把全部字段都带上。
      const param =
        loginType === 1
          ? {
              ...common,
              str_musicid: musicid,
              unionid: cookieValue(this.cookie, "unionid"),
            }
          : loginType === 2
            ? {
                ...common,
                access_token: accessToken,
                expired_in: expiredIn,
                musicid: new RawNumber(musicid),
              }
            : {
                ...common,
                access_token: accessToken,
                expired_in: expiredIn,
                str_musicid: musicid,
                musicid: new RawNumber(musicid),
                unionid: cookieValue(this.cookie, "unionid"),
              };
      let result: QQCgiResult | undefined;
      try {
        result = await context.call(
          "music.login.LoginServer",
          "Login",
          param,
          { tmeLoginType: loginType },
          { musicid, musickey, loginType },
        );
      } catch (error) {
        // 网络问题要冒泡给上层标记 degraded；返回 HTML / 非 JSON 这类瞬时异常
        // 只记一笔，继续用资料接口探活，不能直接判定「登录已失效」。
        if (error instanceof PlatformNetworkError) {
          throw error;
        }
        refreshRejected = true;
        console.warn("qq refresh failed", { message: (error as Error).message });
      }
      if (result && result.code === 0) {
        const data = result.data;
        const credential = credentialCookies(
          data,
          device,
          loginTypeOf(data, loginType),
          applySetCookieLines(new Map(), result.cookies),
          this.cookie,
          context.snapshot(),
        );
        const refreshedExpiry = credentialExpiry(credential);
        // 只打安全元数据：token / cookie 本身一律不进日志。
        console.log("qq refresh ok", {
          loginType,
          rotated: cookieValue(credential, "qm_keyst") !== musickey,
          keyExpiresIn: numberValue(cookieValue(credential, "keyExpiresIn")),
          hasRefreshToken: cookieValue(credential, "refresh_token") !== "",
          hasRefreshKey: cookieValue(credential, "refresh_key") !== "",
          expiresInSeconds: refreshedExpiry > 0 ? refreshedExpiry - now : 0,
        });
        return {
          credential,
          nickname: text(data.nick),
          avatarUrl: avatarFor(musicid),
          expiresAt: refreshedExpiry,
        };
      }
      if (result) {
        refreshRejected = true;
        // 20279=设备数超限、104604=限流、1000/104400/104401=已过期。旧凭据可能
        // 仍然可用，交给下面的资料探活判断；这里只记录可定位的元数据。
        console.warn("qq refresh rejected", {
          loginType,
          code: result.code,
          topCode: result.topCode,
          topMsg: result.topMsg.slice(0, 120),
          expiresInSeconds: expiresAt > 0 ? expiresAt - now : 0,
        });
      }
    }
    const profile = await this.profile();
    if (!profile) {
      return null;
    }
    // 探活通过：把这次实际使用的设备身份写回凭据。旧凭据缺 android_id 时，
    // `deviceFrom` 会临时生成一个，如果不写回，下一轮又会变成另一台设备。
    // 续期被拒时顺便退避，避免 key 还没到期就每 30 分钟撞一次限流 / 设备上限；
    // 已经进入临期窗口的仍按 30 分钟重试，不会错过真正的到期时间。
    const retryAt =
      expiresAt > 0
        ? Math.min(now + 6 * 60 * 60, expiresAt - REFRESH_AHEAD_SECONDS)
        : now + 6 * 60 * 60;
    const credential = mergeCookieText(
      this.cookie,
      joinCookies(
        deviceCookie(device),
        identityCookie(context.snapshot()),
        refreshRejected ? `refresh_after=${Math.max(retryAt, now + 30 * 60)}` : "",
      ),
    );
    return {
      credential,
      nickname: profile.nickname,
      avatarUrl: avatarFor(musicid),
      expiresAt: credentialExpiry(credential),
    };
  }

  /** 用「读自己的资料」探活；返回 null 表示凭据无效。 */
  async profile(): Promise<{ nickname: string } | null> {
    const musicid = this.uin;
    const musickey = this.musickey;
    if (!musicid || !musickey) {
      return null;
    }
    const url = new URL(PROFILE);
    url.search = new URLSearchParams({
      g_tk: String(hash33(musickey, 5381)),
      format: "json",
      inCharset: "utf-8",
      outCharset: "utf-8",
      notice: "0",
      cid: "205360838",
      needNewCode: "0",
      loginUin: musicid,
      hostUin: "0",
      userid: musicid,
      reqfrom: "1",
    }).toString();
    const response = await platformFetch(url.toString(), {
      headers: { Referer: REFERER, Cookie: this.credentialCookie() },
    });
    const payload = await jsonOf(response).catch(() => null);
    if (!payload || Number(payload.code ?? -1) !== 0) {
      return null;
    }
    const data = asRecord(payload.data) ?? {};
    const creator = asRecord(data.creator) ?? {};
    return { nickname: text(creator.nick) };
  }

  /** 只要换票后的凭据；不要把二维码阶段的 Cookie 一起发给数据接口。 */
  private credentialCookie(): string {
    const jar = parseCookies(this.cookie);
    // 网页版 / musicu 的 `uin` 必须带 `o` 前缀（`uin=o123456`）：不带前缀时
    // 上游不认这个身份，响应里的 `login_uin` 是 0，歌单详情一类需要登录态的
    // 模块会回 `-100006 get diss info from tmem error`（HTTP 仍是 200）。
    return [`uin=o${this.uin}`, `qm_keyst=${this.musickey}`]
      .concat([...jar.entries()].filter(([key]) => key.startsWith("qq_")).map(([k, v]) => `${k}=${v}`))
      .join("; ");
  }

  /** 调一个 musicu 模块；返回 `req_0.data`。 */
  async call(module: string, method: string, param: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = JSON.stringify({
      comm: {
        ct: "11",
        cv: "1003006",
        v: "1003006",
        uin: this.uin || "0",
        format: "json",
        tmeAppID: "qqmusic",
      },
      req_0: { module, method, param },
    });
    const response = await platformFetch(MUSICU, {
      method: "POST",
      headers: { ...MUSIC_HEADERS, Cookie: this.credentialCookie() },
      body,
    });
    this.cookie = mergeCookies(this.cookie, response);
    const payload = await jsonOf(response);
    const request = asRecord(payload.req_0) ?? {};
    if (Number(request.code ?? -1) !== 0) {
      // 带上上游 code：没有它就只能看到「返回错误」，无从区分「没登录」与
      // 「参数写错了」。code 不是凭据，可以出现在错误信息里（会进 last_error 与
      // wow-server 的调试日志），body 与 Cookie 一律不出现。
      throw unavailable(`QQ 音乐接口返回错误 (${method} ${Number(request.code ?? -1)})`);
    }
    const data = asRecord(request.data) ?? {};
    // 有些模块（例如 srfDissInfo）即使业务失败也回 `req_0.code = 0`，真正的
    // 错误码藏在 `data.code`（如 -100006），同时 data 里是空壳。不查这一层的话，
    // 上层会把「登录态没被识别」当成「这个歌单是空的」。
    const innerCode = Number(data.code ?? 0);
    if (Number.isFinite(innerCode) && innerCode !== 0) {
      throw unavailable(`QQ 音乐接口返回错误 (${method} ${innerCode})`);
    }
    return data;
  }

  /**
   * 旧版歌单详情：`fcg_ucc_getcdinfo_byids_cp`，返回 `cdlist[0]`。
   *
   * 只用于 `music.srfDissInfo` 读不了的歌单（目前是「每日30首 / 今日私享」）。
   * 上游按 `song_begin` 返回从该位置到末尾的曲目，`song_num` 不生效；调用方
   * 按需自己截断。没有 `cdlist` 时返回 null，让上层回退到普通歌单/排行榜逻辑。
   */
  async cdlist(id: string, begin = 0): Promise<Record<string, unknown> | null> {
    const url = new URL(CDLIST);
    url.search = new URLSearchParams({
      format: "json",
      disstid: id,
      type: "1",
      utf8: "1",
      new_format: "1",
      song_begin: String(begin),
    }).toString();
    const response = await platformFetch(url.toString(), {
      headers: { Referer: REFERER, Cookie: this.credentialCookie() },
    });
    const payload = await jsonOf(response);
    const code = Number(payload.code ?? -1);
    if (code !== 0) {
      throw unavailable(`QQ 音乐接口返回错误 (fcg_ucc_getcdinfo_byids_cp ${code})`);
    }
    const list = Array.isArray(payload.cdlist) ? payload.cdlist : [];
    return asRecord(list[0]) ?? null;
  }

  /** 探活：资料接口能读即视为凭据仍有效。 */
  async alive(): Promise<boolean> {
    try {
      return (await this.profile()) !== null;
    } catch {
      return false;
    }
  }
}

/** QQ 的 ptqrtoken / g_tk 算法：hash33。`seed` 只有 g_tk 用 5381。 */
export function hash33(value: string, seed = 0): number {
  let hash = seed;
  for (const character of value) {
    hash = (hash * 33 + character.charCodeAt(0)) & 0x7fffffff;
  }
  return hash;
}

/**
 * 把一次换票响应整理成 Cookie 串。
 *
 * `uin` + `qm_keyst` 是数据接口唯一认的两项；其余（`refresh_*`、`openid` 等）
 * 用于续期。字段名不完全一致（有的在 JSON 里、有的只在 `Set-Cookie` 里），
 * 所以统一从两处取。它们与平台密码同级，只会落在
 * DO 的 AES-GCM 密文里。
 */
function credentialCookies(
  data: Record<string, unknown>,
  device: QQDevice,
  loginType: number,
  cookies: Map<string, string> = new Map(),
  previous = "",
  identity: AndroidIdentity | null = null,
): string {
  const merged = new Map(cookies);
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string" && value !== "") {
      merged.set(key, value);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      merged.set(key, String(value));
    }
  }
  const previousJar = parseCookies(previous);
  /** 响应里没有的字段沿用旧凭据：续期响应不总会把 refresh 材料再发一遍。 */
  const mergedValue = (key: string): string => {
    const value = merged.get(key);
    if (value !== undefined && value !== "") {
      return value;
    }
    return previousJar.get(key) ?? "";
  };
  const musicid = (
    // 微信账号的 musicid 有 19 位：JSON number 会丢精度，优先字符串字段，
    // 其次用旧凭据里保存的原始值，最后才退回响应里的数字。
    text(data.str_musicid) ||
    previousJar.get("uin") ||
    previousJar.get("musicid") ||
    text(data.musicid) ||
    text(data.uin) ||
    merged.get("uin") ||
    merged.get("qqmusic_uin") ||
    merged.get("musicid") ||
    ""
  ).replace(/^o/u, "");
  const musickey =
    text(data.musickey) ||
    text(data.qm_keyst) ||
    merged.get("qm_keyst") ||
    merged.get("qqmusic_key") ||
    merged.get("musickey") ||
    "";
  if (!/^[1-9]\d*$/u.test(musicid) || !musickey) {
    throw unavailable("QQ 音乐未返回有效登录凭证");
  }
  const jar: [string, string][] = [
    ["uin", musicid],
    ["qm_keyst", musickey],
    ["musicid", musicid],
    ["loginType", String(loginType)],
    ["android_id", device.androidId],
    ["open_udid", device.openUdid],
    ["open_udid2", device.openUdid2],
    ["imei", device.imei],
  ];
  // 有效期的两个字段要成对处理：响应里给了新的 keyExpiresIn 却没给
  // musickeyCreateTime 时，有效期是从**这次响应**算起，不能沿用旧 key 的创建时间。
  const rawTtl = merged.get("keyExpiresIn") ?? "";
  const rawCreated = merged.get("musickeyCreateTime") ?? "";
  const ttl = numberValue(rawTtl !== "" ? rawTtl : (previousJar.get("keyExpiresIn") ?? ""));
  let created = numberValue(
    rawCreated !== "" ? rawCreated : (previousJar.get("musickeyCreateTime") ?? ""),
  );
  if (ttl > 0 && rawCreated === "" && rawTtl !== "") {
    created = Math.floor(Date.now() / 1000);
  }
  if (ttl > 0 && created <= 0) {
    created = Math.floor(Date.now() / 1000);
  }
  const refreshedAt = Math.floor(Date.now() / 1000);
  const expiry = expiryFrom(created, ttl);
  const refreshAfter =
    expiry > 0
      ? Math.min(expiry - REFRESH_AHEAD_SECONDS, refreshedAt + MAX_ROTATE_SECONDS)
      : refreshedAt + MAX_ROTATE_SECONDS;
  jar.push(["refresh_after", String(Math.max(refreshAfter, refreshedAt))]);
  for (const key of [
    "openid",
    "unionid",
    "access_token",
    "refresh_token",
    "refresh_key",
    "expired_at",
    "musickeyCreateTime",
    "keyExpiresIn",
    "encryptUin",
    "str_musicid",
    "firstLogin",
    "bindAccountType",
    "needRefreshKeyIn",
  ]) {
    const value =
      key === "keyExpiresIn"
        ? ttl > 0
          ? String(ttl)
          : ""
        : key === "musickeyCreateTime"
          ? created > 0
            ? String(created)
            : ""
          : mergedValue(key);
    // 空值 / 0 没有意义；把 0 存进去只会让续期参数变成 0。
    if (value !== "" && value !== "0") {
      jar.push([key, value]);
    }
  }
  // 设备身份（QIMEI / 匿名会话）跟凭据一起存，冷启动后不用重新申请。
  const persisted = identity ?? identityFrom(previous);
  const deviceIdentity = identityCookie(persisted);
  if (deviceIdentity) {
    for (const [key, value] of parseCookies(deviceIdentity)) {
      jar.push([key, value]);
    }
  }
  return jar.map(([key, value]) => `${key}=${value}`).join("; ");
}

/**
 * 本地计算 musickey 到期时间（秒）。
 *
 * 上游返回 `musickeyCreateTime`（秒）与 `keyExpiresIn`（时长，秒）；
 * 之前把有效期硬编码成 30 天，既可能比真实值长（过期了还以为有效），
 * 也可能触发无谓的频繁续期。拿不到时返回 0，由调用方兜底。
 */
export function credentialExpiry(cookie: string): number {
  return expiryFrom(
    numberValue(cookieValue(cookie, "musickeyCreateTime")),
    numberValue(cookieValue(cookie, "keyExpiresIn")),
  );
}

function expiryFrom(created: number, ttl: number): number {
  if (created <= 0 || ttl <= 0) {
    return 0;
  }
  // 少数接口用毫秒返回创建时间。
  const createdAt = created > 1e12 ? Math.floor(created / 1000) : created;
  return Math.floor(createdAt + ttl);
}

/** 合并两段 Cookie 文本；后一段的非空值覆盖前一段。 */
function mergeCookieText(current: string, addition: string): string {
  const jar = parseCookies(current);
  for (const [key, value] of parseCookies(addition)) {
    if (value !== "") {
      jar.set(key, value);
    }
  }
  return serializeCookies(jar);
}

function joinCookies(...parts: string[]): string {
  return parts.filter((part) => part !== "").join("; ");
}

function numberValue(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 换票响应里通常带 `loginType`（QQ=2、微信=1、App=6）；缺失时用入口的默认值。 */
function loginTypeOf(data: Record<string, unknown>, fallback: number): number {
  const value = Number(data.loginType ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function avatarFor(uin: string): string {
  return uin ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=140` : "";
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw unavailable("QQ 音乐返回的不是 JSON");
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value) && value !== 0) return String(value);
  return "";
}
