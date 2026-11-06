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
  platformFetch,
} from "../shared/http";
import { unavailable } from "../shared/errors";
import {
  contextFor,
  deviceCookie,
  deviceFrom,
  newDevice,
  RawNumber,
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
}

export interface QQConflict {
  state: "waiting" | "scanned" | "expired";
}

export type QQLoginState = QQConflict | { state: "success"; result: QQLoginResult };

export interface QQRefreshResult {
  credential: string;
  nickname: string;
  avatarUrl: string;
}

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
    this.cookie = deviceCookie(device);
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
    const context = contextFor(device);
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
      },
    };
  }

  /**
   * 用 refresh_token 续期；没有刷新材料时只做探活。
   *
   * 返回 null 表示凭据已失效（需要重新扫码）；抛 `PlatformNetworkError` 表示网络
   * 问题（上层标记 degraded 稍后重试）。
   */
  async refresh(): Promise<QQRefreshResult | null> {
    const musicid = this.uin;
    const musickey = this.musickey;
    if (!musicid || !musickey) {
      return null;
    }
    const device = deviceFrom(this.cookie);
    // 续期参数按登录方式区分（QQ=2、微信=1、App=6）。面板现在只发 App 凭据，
    // 但旧部署里可能还有 QQ / 微信登录的凭据，没有 loginType 时继续按 QQ 处理。
    const loginType = Number(cookieValue(this.cookie, "loginType")) || 2;
    const refreshToken = cookieValue(this.cookie, "refresh_token");
    const refreshKey = cookieValue(this.cookie, "refresh_key");
    if (refreshToken && refreshKey) {
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
      const result = await contextFor(device)
        .call(
          "music.login.LoginServer",
          "Login",
          param,
          { tmeLoginType: loginType },
          { musicid, musickey, loginType },
        )
        .catch(() => null);
      if (result && result.code === 0) {
        const data = result.data;
        const credential = credentialCookies(
          data,
          device,
          loginTypeOf(data, loginType),
          applySetCookieLines(new Map(), result.cookies),
        );
        return {
          credential,
          nickname: text(data.nick),
          avatarUrl: avatarFor(musicid),
        };
      }
    }
    const profile = await this.profile();
    if (!profile) {
      return null;
    }
    return {
      credential: this.cookie,
      nickname: profile.nickname,
      avatarUrl: avatarFor(musicid),
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
): string {
  const merged = new Map(cookies);
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string" && value !== "") {
      merged.set(key, value);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      merged.set(key, String(value));
    }
  }
  const musicid = (
    text(data.str_musicid) ||
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
  ]) {
    const value = merged.get(key) ?? "";
    // 空值 / 0 没有意义；把 0 存进去只会让续期参数变成 0。
    if (value !== "" && value !== "0") {
      jar.push([key, value]);
    }
  }
  return jar.map(([key, value]) => `${key}=${value}`).join("; ");
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
