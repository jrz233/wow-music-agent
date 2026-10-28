/**
 * QQ 音乐扫码登录与 musicu.fcg 传输层。
 *
 * 登录链路（与官方 Android 客户端一致，参考 wow-origin 的 `qq-login.js`）：
 *
 *   xlogin → ptqrshow（二维码）
 *     → ptqrlogin（轮询）
 *       → check_sig（换取 graph.qq.com 的 p_skey）
 *         → graph.qq.com/oauth2.0/authorize（拿到一次性 code）
 *           → QQConnectLogin.LoginServer / QQLogin（用 code 换 **musickey**）
 *
 * **关键**：只有 `QQLogin` 会把 code 换成 `str_musicid` + `musickey`，最终 Cookie 是
 * `uin=<musicid>; qm_keyst=<musickey>`。以前这里跟 302 链抓网页版 Cookie
 * （`qqmusic_key`），那条路的 `uin` 是空的，数据接口会一律回 `500003` / `1000`
 * —— 面板表现为「QQ 在线但歌单/每日/漫游都拿不到」。
 *
 * QQ 的私有接口会随客户端版本变化，因此所有读取都走一个宽松的 `call()`：
 * 只要求 `code === 0`，字段映射在 `api.ts` 里做多路兼容。
 */

import {
  applySetCookieLines,
  cookiesForHost,
  cookieValue,
  mergeCookies,
  parseCookies,
  platformFetch,
  serializeCookies,
  setCookies,
} from "../shared/http";
import { unavailable } from "../shared/errors";
import { imageDataUrl, sniffImageMime } from "../shared/image";

const LOGIN_JUMP = "https://graph.qq.com/oauth2.0/login_jump";
const GRAPH_AUTHORIZE = "https://graph.qq.com/oauth2.0/authorize";
const REDIRECT_URI =
  "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/";
const MUSICU = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const PROFILE = "https://c6.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg";
const REFERER = "https://y.qq.com/";
const APPID = "716027609";
const DAID = "383";
const PT_3RD_AID = "100497308";
/** 与客户端一致的 Android 身份；`QQLogin` 只认这套 comm。 */
const ANDROID_UA = "QQMusic 14090008(android 15)";
const ANDROID_CV = 14090008;
const ANDROID_CHID = "10003505";

/**
 * ptlogin 的两个入口。
 *
 * 主机与路径必须配对：`ssl.ptlogin2.qq.com` 配 `/ptqrshow`，`xui.ptlogin2.qq.com`
 * 配 `/ssl/ptqrshow`，交叉搭配会 302 到别处去（拿不到图）。
 *
 * 两个入口返回的都是 PNG，但**都不带 content-type 头**，只能靠魔数识别。
 * `xui` 这一路先访问一次 `/cgi-bin/xlogin`，它会下发 `pt_login_sig`、`uikey` 等
 * Cookie；轮询 `ptqrlogin` 时要带上 `pt_login_sig`，缺失会影响扫码成功后的换票。
 */
interface QQEndpoint {
  /** 入口标识：二维码会话要记下来，轮询必须回到同一台机器。 */
  id: "xui" | "ssl";
  base: string;
  show: string;
  poll: string;
  referer: string;
  needsXLogin: boolean;
}

const QQ_ENDPOINTS: QQEndpoint[] = [
  {
    id: "xui",
    base: "https://xui.ptlogin2.qq.com",
    show: "/ssl/ptqrshow",
    poll: "/ssl/ptqrlogin",
    referer: "https://xui.ptlogin2.qq.com/cgi-bin/xlogin",
    needsXLogin: true,
  },
  {
    id: "ssl",
    base: "https://ssl.ptlogin2.qq.com",
    show: "/ptqrshow",
    poll: "/ptqrlogin",
    referer: "https://y.qq.com/",
    needsXLogin: false,
  },
];

const MUSIC_HEADERS = {
  "Content-Type": "application/json",
  Referer: REFERER,
  Origin: "https://y.qq.com",
};

/**
 * 登录链路专用的浏览器形态。
 *
 * 与参考实现（wow-origin `platforms/qqmusic/util/login-http.js`）一致：Windows +
 * Chrome + 中文 Accept-Language。ptlogin 对「不像网页的请求」会直接回异常状态码，
 * 表现就是扫码状态不推进。
 */
const LOGIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/141.0.0.0 Safari/537.36";
const LOGIN_LANGUAGE = "zh-CN,zh;q=0.9";

/** 设备指纹。`QQLogin` 要求同一个身份贯穿 GetSession 与换票；刷新时也要复用。 */
interface QQDevice {
  androidId: string;
  openUdid: string;
}

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
  /** 真正吐出二维码的那个入口；轮询必须回到同一台机器，否则 qrsig 对不上。 */
  private endpoint: QQEndpoint;

  constructor(cookie = "", endpointId: "xui" | "ssl" = "xui") {
    this.cookie = cookie;
    this.endpoint =
      QQ_ENDPOINTS.find((endpoint) => endpoint.id === endpointId) ??
      (QQ_ENDPOINTS[0] as QQEndpoint);
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
   * 二维码图片 + qrsig Cookie。
   *
   * ptqrshow 回的 PNG **不带 content-type 头**，所以这里只认魔数；
   * 拿不到图就换另一个入口（主机与路径要配对，见 QQ_ENDPOINTS）。
   */
  async createQR(): Promise<{ imageDataUrl: string; cookie: string; endpoint: "xui" | "ssl" }> {
    const query = new URLSearchParams({
      appid: APPID,
      e: "2",
      l: "M",
      s: "3",
      d: "72",
      v: "4",
      t: `${Math.random()}`,
      daid: DAID,
      pt_3rd_aid: PT_3RD_AID,
      u1: LOGIN_JUMP,
    });
    let failure: Error | null = null;
    for (const endpoint of QQ_ENDPOINTS) {
      try {
        if (endpoint.needsXLogin) {
          await this.xlogin(endpoint);
        }
        const response = await platformFetch(`${endpoint.base}${endpoint.show}?${query.toString()}`, {
          headers: {
            Referer: endpoint.referer,
            Accept: "image/*",
            "User-Agent": LOGIN_UA,
            "Accept-Language": LOGIN_LANGUAGE,
          },
          redirect: "manual",
        });
        this.cookie = mergeCookies(this.cookie, response);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const mime = sniffImageMime(bytes);
        if (!response.ok || !mime) {
          failure = unavailable("QQ 二维码获取失败");
          continue;
        }
        if (!cookieValue(this.cookie, "qrsig")) {
          failure = unavailable("QQ 二维码响应缺少 qrsig");
          continue;
        }
        this.endpoint = endpoint;
        return { imageDataUrl: imageDataUrl(bytes, mime), cookie: this.cookie, endpoint: endpoint.id };
      } catch (error) {
        failure = error as Error;
      }
    }
    throw failure ?? unavailable("QQ 二维码获取失败");
  }

  /** 访问一次登录页，拿到 `pt_login_sig` / `uikey` 等 Cookie。 */
  private async xlogin(endpoint: QQEndpoint): Promise<void> {
    const url = new URL("/cgi-bin/xlogin", endpoint.base);
    url.search = new URLSearchParams({
      appid: APPID,
      daid: DAID,
      style: "33",
      hide_title_bar: "1",
      hide_border: "1",
      target: "self",
      s_url: LOGIN_JUMP,
      pt_3rd_aid: PT_3RD_AID,
    }).toString();
    const response = await platformFetch(url.toString(), {
      headers: {
        Referer: `${endpoint.base}/`,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "User-Agent": LOGIN_UA,
        "Accept-Language": LOGIN_LANGUAGE,
      },
      redirect: "manual",
    });
    this.cookie = mergeCookies(this.cookie, response);
    await response.arrayBuffer().catch(() => undefined);
  }

  /** 轮询扫码状态。成功时返回登录后的凭据与账号信息。 */
  async checkQR(): Promise<QQLoginState> {
    const qrsig = cookieValue(this.cookie, "qrsig");
    if (!qrsig) {
      throw unavailable("QQ 二维码会话已失效");
    }
    const query = new URLSearchParams({
      u1: LOGIN_JUMP,
      ptqrtoken: String(hash33(qrsig)),
      ptredirect: "0",
      h: "1",
      t: "1",
      g: "1",
      from_ui: "1",
      ptlang: "2052",
      action: `0-0-${Date.now()}`,
      js_ver: "25100115",
      js_type: "1",
      login_sig: cookieValue(this.cookie, "pt_login_sig"),
      pt_uistyle: "40",
      aid: APPID,
      daid: DAID,
      pt_3rd_aid: PT_3RD_AID,
      // 与参考实现一致：缺这个参数上游会按旧版页面处理，扫码状态可能不推进。
      pt_js_version: "28d22679",
    });
    const response = await platformFetch(`${this.endpoint.base}${this.endpoint.poll}?${query.toString()}`, {
      headers: {
        Referer: this.endpoint.referer,
        Cookie: this.cookie,
        Accept: "*/*",
        "User-Agent": LOGIN_UA,
        "Accept-Language": LOGIN_LANGUAGE,
      },
      redirect: "manual",
    });
    // 这一跳下发的 Cookie 要按域名挑：扫码成功后 `check_sig` 只该收到浏览器会带过去的那部分。
    const loginSetCookies = setCookies(response);
    this.cookie = mergeCookies(this.cookie, response);
    const body = await response.text();
    const parsed = parsePtuiCB(body);
    if (!parsed) {
      return { state: "waiting" };
    }
    if (parsed.code === "65" || parsed.code === "68") {
      return { state: "expired" };
    }
    if (parsed.code === "67") {
      return { state: "scanned" };
    }
    if (parsed.code !== "0" || !parsed.url) {
      return { state: "waiting" };
    }
    const credential = await this.followLogin(parsed.url, loginSetCookies);
    const uin = cookieValue(credential, "uin").replace(/^o/u, "");
    return {
      state: "success",
      result: {
        credential,
        account: {
          userId: uin,
          nickname: parsed.nickname || uin,
          avatarUrl: avatarFor(uin),
        },
      },
    };
  }

  /**
   * 扫码成功后把一次性 code 换成 **musickey** 凭据。
   *
   * 两步：先走 graph.qq.com 授权拿 `code`，再调 Android 的 `QQLogin` 换票。
   * 之前这里只是跟着 302 抓网页版 Cookie，`uin` 是空的，数据接口全部返回
   * `500003`（未登录）/ `1000`（凭据过期）——这就是「QQ 显示已登录但什么都拿不到」。
   */
  private async followLogin(jumpUrl: string, loginSetCookies: string[]): Promise<string> {
    const code = await this.authorize(jumpUrl, loginSetCookies);
    const device = newDevice();
    const data = await this.qqLogin(code, device);
    return credentialCookies(data, device);
  }

  /** check_sig → graph.qq.com/oauth2.0/authorize → `code`。 */
  private async authorize(jumpUrl: string, loginSetCookies: string[]): Promise<string> {
    const jump = new URL(jumpUrl);
    // 跳转地址由 QQ 自己给出，但 Worker 会真的去请求它；限定 https + qq.com。
    if (jump.protocol !== "https:" || !isQQHost(jump.hostname)) {
      throw unavailable("QQ 登录跳转地址异常");
    }
    if (!jump.searchParams.get("uin") || !jump.searchParams.get("ptsigx")) {
      throw unavailable("QQ 登录跳转缺少 uin 或 ptsigx");
    }

    const { pSkey, cookies: sigCookies } = await this.checkSig(jump, loginSetCookies);

    const ui = crypto.randomUUID().replace(/-/gu, "").toUpperCase();
    const body = new URLSearchParams({
      response_type: "code",
      client_id: PT_3RD_AID,
      redirect_uri: REDIRECT_URI,
      scope: "get_user_info,get_app_friends",
      state: Math.random().toString(36).slice(2),
      switch: "",
      from_ptlogin: "1",
      src: "1",
      update_auth: "1",
      openapi: "1010_1030",
      // g_tk = hash33(p_skey, 5381)；这个种子与 ptlogin 不同，别混用。
      g_tk: String(hash33(pSkey, 5381)),
      auth_time: String(Date.now()),
      ui,
    });
    // 授权只用 check_sig 下发的那套 Cookie（p_skey / p_uin / pt4_token…），
    // 和浏览器在这一步的行为一致；二维码阶段的 Cookie 不带过去。
    const graphCookies = new Map(sigCookies);
    graphCookies.set("ui", ui);
    const response = await platformFetch(GRAPH_AUTHORIZE, {
      method: "POST",
      headers: {
        Origin: "https://graph.qq.com",
        Referer: this.endpoint.referer,
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: serializeCookies(graphCookies),
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "User-Agent": LOGIN_UA,
        "Accept-Language": LOGIN_LANGUAGE,
        "Upgrade-Insecure-Requests": "1",
      },
      body: body.toString(),
      redirect: "manual",
    });
    const location = response.headers.get("location") ?? "";
    await response.arrayBuffer().catch(() => undefined);
    const code = codeFrom(location);
    if (!code) {
      throw unavailable("QQ 授权未返回 code");
    }
    return code;
  }

  /**
   * 走 `check_sig` 换回 `p_skey`。
   *
   * 线上验证过的做法是两次尝试：
   *
   *   1. 自己拼参数、**不带 Cookie** 请求 check_sig（qqmusic-api-python 的方式）；
   *   2. 没拿到 `p_skey` 时按浏览器的方式重试一次：打开 ptlogin 给出的原始地址，
   *      只带扫码成功响应里、域名匹配 check_sig 主机的 Cookie。
   *
   * 直接把整只扁平 Cookie jar 发过去，QQ 会回 `p_skey=`（空）并下发
   * `p_skey_forbid`，表现就是「扫码成功却登录失败」。
   *
   * 返回值除了 `p_skey`，还有这一跳下发的全部 Cookie——授权那一步要用它们。
   */
  private async checkSig(
    jump: URL,
    loginSetCookies: string[],
  ): Promise<{ pSkey: string; cookies: Map<string, string> }> {
    const url = new URL("https://ssl.ptlogin2.graph.qq.com/check_sig");
    url.search = new URLSearchParams({
      uin: jump.searchParams.get("uin") ?? "",
      pttype: "1",
      service: "ptqrlogin",
      nodirect: "0",
      ptsigx: jump.searchParams.get("ptsigx") ?? "",
      s_url: LOGIN_JUMP,
      ptlang: "2052",
      ptredirect: "100",
      aid: APPID,
      daid: DAID,
      j_later: "0",
      low_login_hour: "0",
      regmaster: "0",
      pt_login_type: "3",
      pt_aid: "0",
      pt_aaid: "16",
      pt_light: "0",
      pt_3rd_aid: PT_3RD_AID,
    }).toString();

    const attempts: string[] = [];
    let cookies = await this.requestCheckSig(url.toString(), "", attempts);
    let pSkey = pickPSkey(cookies);
    if (!pSkey) {
      // 浏览器不会把 ptlogin 的主机独占 Cookie 带去 check_sig，只带 Domain 匹配的那些。
      const browserCookies = cookiesForHost(loginSetCookies, jump.hostname);
      cookies = await this.requestCheckSig(jump.toString(), serializeCookies(browserCookies), attempts);
      pSkey = pickPSkey(cookies);
    }

    // check_sig 下发的 Cookie 留在 jar 里，供后续排查 / 授权使用。
    const jar = applySetCookieLines(parseCookies(this.cookie), [...cookies].map(([key, value]) => `${key}=${value}`));
    this.cookie = serializeCookies(jar);

    if (!pSkey) {
      // 只记状态码、跳转的域名与路径、Cookie 名字——参数与值都可能带凭据。
      throw unavailable(`QQ 会话校验未返回 p_skey（${attempts.join("；重试：")}）`);
    }
    return { pSkey, cookies };
  }

  /** 请求一次 check_sig；`cookieHeader` 为空表示不带 Cookie。 */
  private async requestCheckSig(
    url: string,
    cookieHeader: string,
    attempts: string[],
  ): Promise<Map<string, string>> {
    const response = await platformFetch(url, {
      headers: {
        Referer: "https://xui.ptlogin2.qq.com/",
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/*,*/*;q=0.8",
        "User-Agent": LOGIN_UA,
        "Accept-Language": LOGIN_LANGUAGE,
        "Upgrade-Insecure-Requests": "1",
      },
      redirect: "manual",
    });
    const lines = setCookies(response);
    await response.arrayBuffer().catch(() => undefined);

    const location = response.headers.get("location");
    let redirect = "";
    if (location) {
      try {
        const next = new URL(location, url);
        redirect = ` 跳转 ${next.host}${next.pathname}`;
      } catch {
        redirect = " 跳转 无效地址";
      }
    }
    const names = lines
      .map((line) => (line.split(";")[0] ?? "").split("=")[0]?.trim() ?? "")
      .filter((name) => name !== "")
      .sort()
      .join(",");
    attempts.push(`HTTP ${response.status}${redirect}（下发 ${names || "无 Cookie"}）`);

    return applySetCookieLines(new Map(), lines);
  }

  /** `QQConnectLogin.LoginServer/QQLogin`：用一次性 code 换 musickey。 */
  private async qqLogin(code: string, device: QQDevice): Promise<Record<string, unknown>> {
    const session = await this.androidCall(
      "music.getSession.session",
      "GetSession",
      { uid: "", vkey: 0, caller: 2 },
      {},
      device,
    );
    const value = asRecord(session.session) ?? {};
    const uid = text(value.uid);
    const sid = text(value.sid);
    if (!uid || !sid) {
      throw unavailable("QQ 音乐未返回 Android 会话");
    }
    const data = await this.androidCall(
      "QQConnectLogin.LoginServer",
      "QQLogin",
      { code },
      { uid, sid, tmeLoginType: 2 },
      device,
    );
    const musicid = text(data.str_musicid) || text(data.musicid);
    const musickey = text(data.musickey);
    if (!/^[1-9]\d*$/u.test(musicid) || !musickey) {
      throw unavailable("QQ 音乐未返回有效登录凭证");
    }
    return data;
  }

  /** Android 身份的 CGI 调用；comm 里所有值都转成字符串（换票接口只认字符串）。 */
  private async androidCall(
    module: string,
    method: string,
    param: Record<string, unknown>,
    extra: Record<string, unknown>,
    device: QQDevice,
  ): Promise<Record<string, unknown>> {
    const comm = {
      ct: 11,
      cv: ANDROID_CV,
      v: ANDROID_CV,
      chid: ANDROID_CHID,
      tmeAppID: "qqmusic",
      OpenUDID: device.openUdid,
      udid: device.openUdid,
      OpenUDID2: device.openUdid,
      aid: device.androidId,
      os_ver: "15",
      phonetype: "V2408A",
      ...extra,
    };
    const body = JSON.stringify({
      comm: Object.fromEntries(Object.entries(comm).map(([key, value]) => [key, String(value)])),
      req_0: { module, method, param },
    });
    const response = await platformFetch(MUSICU, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": ANDROID_UA },
      body,
    });
    const payload = await jsonOf(response);
    const request = asRecord(payload.req_0) ?? {};
    const result = asRecord(request.data) ?? {};
    const code = Number(request.code ?? -1);
    if (code !== 0) {
      throw unavailable(`QQ 音乐登录失败 (${method} ${code})`);
    }
    return result;
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
    const refreshToken = cookieValue(this.cookie, "refresh_token");
    const refreshKey = cookieValue(this.cookie, "refresh_key");
    if (refreshToken && refreshKey) {
      const data = await this.androidCall(
        "music.login.LoginServer",
        "Login",
        {
          openid: cookieValue(this.cookie, "openid"),
          refresh_token: refreshToken,
          refresh_key: refreshKey,
          musickey,
          loginMode: 2,
          access_token: cookieValue(this.cookie, "access_token"),
          expired_in: Number(cookieValue(this.cookie, "expired_at")) || 0,
          musicid: Number(musicid),
        },
        { musicid, musickey, loginType: 2, tmeLoginType: 2 },
        device,
      ).catch(() => null);
      if (data) {
        const credential = credentialCookies(data, device);
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

export function parsePtuiCB(
  body: string,
): { code: string; subcode: string; url: string; message: string; nickname: string } | null {
  // ptuiCB('0','0','https://…','0','登录成功', '昵称');
  const match = body.match(/ptuiCB\(([^)]*)\)/u);
  if (!match) return null;
  const args = [...(match[1] ?? "").matchAll(/'([^']*)'/gu)].map((item) => item[1] ?? "");
  if (args.length < 5) return null;
  return {
    code: args[0] ?? "",
    subcode: args[1] ?? "",
    url: (args[2] ?? "").replace(/&amp;/gu, "&"),
    message: decodeNickname(args[4] ?? ""),
    nickname: decodeNickname(args[5] ?? ""),
  };
}

function decodeNickname(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function cookiesFrom(response: Response): string[] {
  return setCookies(response);
}

export function cookieJar(raw: string): Map<string, string> {
  return parseCookies(raw);
}

/* ───────────────────────────── 内部工具 ───────────────────────────── */

/** 授权回跳里的 `code`；可能在 query，也可能在 `#` 后面（微信/QQ 两套写法都有）。 */
function codeFrom(location: string): string {
  if (!location) return "";
  try {
    const url = new URL(location, "https://graph.qq.com/");
    const fromQuery = url.searchParams.get("code");
    if (fromQuery) return fromQuery;
    return new URLSearchParams(url.hash.replace(/^#/u, "")).get("code") ?? "";
  } catch {
    return "";
  }
}

function isQQHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "qq.com" || host.endsWith(".qq.com");
}

/** QQ 在不同版本里用过这几种写法；取第一个非空值。 */
function pickPSkey(cookies: Map<string, string>): string {
  for (const key of ["p_skey", "p_sKey", "skey", "pskey"]) {
    const value = cookies.get(key) ?? "";
    if (value !== "") {
      return value;
    }
  }
  return "";
}

/**
 * 把 `QQLogin` 的返回整理成 Cookie 串。
 *
 * `uin` + `qm_keyst` 是数据接口唯一认的两项；其余（`refresh_*`、`openid` 等）
 * 用于续期。它们与平台密码同级，只会落在 DO 的 AES-GCM 密文里。
 */
function credentialCookies(data: Record<string, unknown>, device: QQDevice): string {
  const musicid = text(data.str_musicid) || text(data.musicid);
  const musickey = text(data.musickey);
  if (!/^[1-9]\d*$/u.test(musicid) || !musickey) {
    throw unavailable("QQ 音乐未返回有效登录凭证");
  }
  const jar: [string, string][] = [
    ["uin", musicid],
    ["qm_keyst", musickey],
    ["musicid", musicid],
    ["loginType", "2"],
    ["android_id", device.androidId],
    ["open_udid", device.openUdid],
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
  ]) {
    const value = text(data[key]);
    if (value !== "") {
      jar.push([key, value]);
    }
  }
  return jar.map(([key, value]) => `${key}=${value}`).join("; ");
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function newDevice(): QQDevice {
  return { androidId: randomHex(8), openUdid: randomHex(16) };
}

/** 续期必须复用登录时的设备身份；缺失时现生成一个（仅影响风控，不影响正确性）。 */
function deviceFrom(cookie: string): QQDevice {
  const androidId = cookieValue(cookie, "android_id");
  const openUdid = cookieValue(cookie, "open_udid");
  if (/^[0-9a-f]{16}$/u.test(androidId) && /^[0-9a-f]{32}$/u.test(openUdid)) {
    return { androidId, openUdid };
  }
  return newDevice();
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
