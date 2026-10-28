/**
 * 网易云传输层：eapi（客户端接口）与 weapi（网页版接口）。
 *
 * 只负责：带 Cookie 的 POST、响应解包、Set-Cookie 合并、二维码登录三步。
 * 业务字段映射在 `api.ts`，不要在传输层做形状转换。
 *
 * 协议细节与 wow-origin（`platforms/netease/util/request.js`）保持一致：
 *
 *  - **eapi**：请求体里必须带 `header`（设备信息）与 `e_r: true`；**不带 `e_r` 时上游
 *    回的是明文 JSON**，按密文解就会报「密文无法解密」。带了 `e_r` 之后响应体是同一
 *    固定密钥的 ECB 密文，解密才是 JSON。
 *  - **weapi**：网页版接口，双层 AES-CBC + RSA，Cookie 里带 `MUSIC_U`。
 *  - 两种接口都要装成「客户端 / 浏览器」，否则风控会挡。
 */

import { mergeCookies, parseCookies, platformFetch, withCookie } from "../shared/http";
import { unavailable } from "../shared/errors";
import { checkToken } from "./checktoken";
import { eapiDecrypt, eapiParams, eapiPath, weapi } from "./crypto";
import { neteaseLoginURL, qrCodeDataUrl } from "./qr";

const MUSIC_BASE = "https://music.163.com";
const REFERER = "https://music.163.com/";

/** eapi 要装成网易云桌面客户端。 */
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.19.204510";

/** weapi 走网页版接口，用浏览器 UA。 */
const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";

/**
 * eapi 请求头里的设备信息。
 *
 * 这四件套是网易云客户端的固定指纹，缺一项上游会当成异常流量拒掉；值与
 * wow-origin 的 `DEFAULT_HEADER` 保持一致。
 */
const DEVICE_HEADER = {
  os: "pc",
  appver: "3.1.19.204510",
  requestId: 0,
  osver: "Microsoft-Windows-11-Home-China-build-22631-64bit",
} as const;

export interface NeteaseAccount {
  userId: string;
  nickname: string;
  avatarUrl: string;
}

export interface QRCode {
  key: string;
  imageDataUrl: string;
}

export type QRState =
  | { state: "waiting"; cookie: string }
  | { state: "scanned"; cookie: string }
  | { state: "expired"; cookie: string }
  | { state: "success"; cookies: string };

/**
 * 网易云客户端的设备标识。
 *
 * 参考实现（wow-origin `platforms/netease/NeteasePlatform.js`）在进程启动时生成一个
 * 52 位大写十六进制的 `deviceId`，**整个会话固定不变**，并同时放进 eapi 请求的
 * `header` 与 Cookie 头里。
 *
 * 这个值就是网易云眼里的「客户端身份」：二维码的 unikey 与发起扫码的客户端绑在一
 * 起，轮询时身份对不上，上游就当没扫过（一直 801），或者扫过之后又退回 801。少了
 * 它，扫码状态就飘。
 */
export function newDeviceId(): string {
  const bytes = new Uint8Array(26);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export interface RequestOptions {
  /** 带上 `x-anticheattoken`；只有少数接口（Personal FM）需要。 */
  antiCheat?: boolean;
}

export class NeteaseClient {
  cookie: string;
  private csrf: string;

  constructor(cookie = "") {
    this.cookie = cookie;
    this.csrf = parseCookies(cookie).get("__csrf") ?? "";
  }

  /**
   * eapi 请求：网易云的「客户端接口」。
   *
   * 登录链路必须走它——手机端把扫码结果写进 **eapi 会话**，weapi 的 key 在客户端侧
   * 没有对应记录，于是 `client/login` 永远停在 801。见 `crypto.ts` 的说明。
   *
   * 响应体是同一固定密钥的 ECB 密文；先解密再当 JSON 读。Cookie 一律回写：登录阶段
   * `Set-Cookie` 里的 `MUSIC_U` 就是扫码成功的凭证。
   */
  private async eapiRequest(
    path: string,
    payload: Record<string, unknown>,
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    const apiPath = path.startsWith("/api/") ? path : `/api/${path}`;
    const deviceHeader: Record<string, unknown> = { ...DEVICE_HEADER };
    const jar = parseCookies(this.cookie);
    // 设备标识：与参考实现一致，扫码的发起方与轮询方必须是同一个「客户端」。
    const deviceId = jar.get("deviceId");
    if (deviceId) {
      deviceHeader.deviceId = deviceId;
    }
    const musicU = jar.get("MUSIC_U");
    if (musicU) {
      // 请求头里的 MUSIC_U 用解码后的形式，Cookie 头里用原始形式——和上游一致。
      deviceHeader.MUSIC_U = decodeCookieValue(musicU);
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: REFERER,
      Origin: MUSIC_BASE,
      "User-Agent": DESKTOP_UA,
      Cookie: this.platformCookie(),
    };
    if (options.antiCheat) {
      const token = checkToken("eapi");
      headers["x-anticheattoken"] = token;
      deviceHeader["X-anticheattoken"] = token;
    }

    // `e_r: true` 是关键：它告诉上游「按密文回」，同时也带上设备指纹。
    const requestPayload: Record<string, unknown> = {
      ...payload,
      header: deviceHeader,
      e_r: true,
    };
    const body = new URLSearchParams({ params: eapiParams(apiPath, requestPayload) }).toString();
    const response = await platformFetch(eapiPath(apiPath), {
      method: "POST",
      headers,
      body,
    });
    this.cookie = mergeCookies(this.cookie, response);
    if (!response.ok) {
      throw unavailable(`网易云返回 HTTP ${response.status}`);
    }
    return parseEapiBody(new Uint8Array(await response.arrayBuffer()));
  }

  /** weapi 请求：网页版接口（账号信息、Personal FM）。 */
  private async weapiRequest(
    path: string,
    payload: Record<string, unknown>,
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    const encrypted = await weapi(payload);
    const body = new URLSearchParams({
      params: encrypted.params,
      encSecKey: encrypted.encSecKey,
    }).toString();
    const query = this.csrf ? `?csrf_token=${encodeURIComponent(this.csrf)}` : "";
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: REFERER,
      Origin: MUSIC_BASE,
      "User-Agent": WEB_UA,
      // weapi 与 eapi 用同一套 Cookie 形态（参考实现也是如此）：设备四件套 +
      // deviceId + 会话 Cookie 一起带上。
      Cookie: this.platformCookie(),
    };
    if (options.antiCheat) {
      headers["x-anticheattoken"] = checkToken("weapi");
    }
    const response = await platformFetch(`${MUSIC_BASE}/weapi/${path}${query}`, {
      method: "POST",
      headers,
      body,
    });
    this.cookie = mergeCookies(this.cookie, response);
    this.csrf = parseCookies(this.cookie).get("__csrf") ?? this.csrf;
    if (!response.ok) {
      throw unavailable(`网易云返回 HTTP ${response.status}`);
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw unavailable("网易云返回的不是 JSON");
    }
  }

  /** eapi 调用：绝大多数网易云模块都走它。 */
  async call(
    path: string,
    payload: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.eapiRequest(path, payload, options);
  }

  /** weapi 调用：网页版接口。 */
  async callWeb(
    path: string,
    payload: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.weapiRequest(path, payload, options);
  }

  async createQR(): Promise<QRCode> {
    // 设备标识要在**取 unikey 之前**就定下来：后面的每一次轮询都要用同一个。
    if (!parseCookies(this.cookie).get("deviceId")) {
      this.cookie = withCookie(this.cookie, "deviceId", newDeviceId());
    }
    const data = await this.eapiRequest("login/qrcode/unikey", { type: 3 });
    const key = String(data.unikey ?? "");
    if (!key) {
      throw unavailable("网易云没有返回二维码 key");
    }
    // 二维码本地渲染：内容与网易云网页版一致，手机扫到的行为也一样。
    return { key, imageDataUrl: qrCodeDataUrl(neteaseLoginURL(key)) };
  }

  async checkQR(key: string): Promise<QRState> {
    const data = await this.eapiRequest("login/qrcode/client/login", { key, type: 3 });
    const code = Number(data.code ?? 0);
    if (code === 803) {
      return { state: "success", cookies: this.cookie };
    }
    if (code === 802) {
      return { state: "scanned", cookie: this.cookie };
    }
    if (code === 800) {
      return { state: "expired", cookie: this.cookie };
    }
    return { state: "waiting", cookie: this.cookie };
  }

  /** 读取当前登录账号；失败抛错（Cookie 失效会返回 code 301）。 */
  async account(): Promise<NeteaseAccount> {
    const data = await this.weapiRequest("nuser/account/get", {});
    const profile = data.profile as Record<string, unknown> | undefined;
    if (!profile) {
      throw unavailable("网易云登录状态无效");
    }
    return {
      userId: String(profile.userId ?? ""),
      nickname: String(profile.nickname ?? ""),
      avatarUrl: String(profile.avatarUrl ?? ""),
    };
  }

  /**
   * 刷新会话。网易云的 MUSIC_U 是长周期 Cookie；调用刷新接口让服务端滚动有效期，
   * 失败就由上层标记 degraded/logged_out，用户重新扫码即可。
   */
  async refresh(): Promise<boolean> {
    const data = await this.eapiRequest("login/token/refresh", {});
    return Number(data.code ?? 0) === 200;
  }

  /**
   * 请求带出去的 Cookie。
   *
   * 设备四件套是网易云客户端的固定指纹；`deviceId` 是这台「客户端」的身份，
   * 扫码期间必须始终一致；`MUSIC_U` 用**原始**值（Cookie 头里必须是编码后的形式），
   * 其余自己攒的 Cookie（NMTID / __csrf）一起带上。
   */
  private platformCookie(): string {
    const jar = parseCookies(this.cookie);
    const parts = [
      `os=${DEVICE_HEADER.os}`,
      `appver=${DEVICE_HEADER.appver}`,
      `requestId=${DEVICE_HEADER.requestId}`,
      `osver=${encodeURIComponent(DEVICE_HEADER.osver)}`,
    ];
    for (const [key, value] of jar.entries()) {
      if (key === "os" || key === "appver" || key === "requestId" || key === "osver") {
        continue;
      }
      parts.push(`${key}=${value}`);
    }
    return parts.join("; ");
  }
}

/**
 * 解析 eapi 响应体。
 *
 * 带 `e_r` 的请求回的是 ECB 密文；万一是明文 JSON（老客户端路径）也要认，
 * 否则用户只会看到一句没头没尾的「密文无法解密」。
 */
function parseEapiBody(bytes: Uint8Array): Record<string, unknown> {
  try {
    return JSON.parse(eapiDecrypt(bytes)) as Record<string, unknown>;
  } catch {
    // 落到明文分支。
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    throw unavailable("网易云返回的密文无法解密");
  }
}

/** Cookie 值是 URL 编码的；解不开就原样用。 */
function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
