/**
 * 网易云 weapi 传输层。
 *
 * 只负责：带 Cookie 的 POST、响应解包、Set-Cookie 合并、二维码登录三步。
 * 业务字段映射在 `api.ts`，不要在传输层做形状转换。
 */

import { mergeCookies, parseCookies, platformFetch } from "../shared/http";
import { unavailable } from "../shared/errors";
import { imageDataUrl, sniffImageMime } from "../shared/image";
import { weapi } from "./crypto";

const MUSIC_BASE = "https://music.163.com";
const REFERER = "https://music.163.com/";
const API_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  Referer: REFERER,
  Origin: MUSIC_BASE,
};

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
  | { state: "waiting" }
  | { state: "scanned" }
  | { state: "expired" }
  | { state: "success"; cookies: string };

export class NeteaseClient {
  cookie: string;
  private csrf: string;

  constructor(cookie = "") {
    this.cookie = cookie;
    this.csrf = parseCookies(cookie).get("__csrf") ?? "";
  }

  private async request(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const encrypted = await weapi(payload);
    const body = new URLSearchParams({
      params: encrypted.params,
      encSecKey: encrypted.encSecKey,
    }).toString();
    const query = this.csrf ? `?csrf_token=${encodeURIComponent(this.csrf)}` : "";
    const response = await platformFetch(`${MUSIC_BASE}/weapi/${path}${query}`, {
      method: "POST",
      headers: {
        ...API_HEADERS,
        Cookie: this.cookie,
      },
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

  async createQR(): Promise<QRCode> {
    const data = await this.request("login/qrcode/unikey", { type: 1 });
    const key = String(data.unikey ?? "");
    if (!key) {
      throw unavailable("网易云没有返回二维码 key");
    }
    return { key, imageDataUrl: await this.fetchQRImage(key) };
  }

  /**
   * 取二维码图片。
   *
   * 旧做法是直接 GET `login?codekey=…` 指望它回一张 PNG——现在那个地址回的是
   * 网页版登录页的 HTML，二维码自然永远显示不出来。网页版自己也是先向
   * `/api/web/qrcode/get` 要一张渲染好的图，再去 CDN 取。
   *
   * 这里由 Worker 代取并内联成 data URL：既不把用户 IP 暴露给图片 CDN，
   * 管理页的 CSP 也不用为 `music.163.com` 开口子。
   */
  private async fetchQRImage(key: string): Promise<string> {
    const pageURL = `${MUSIC_BASE}/login?codekey=${encodeURIComponent(key)}`;
    const response = await platformFetch(`${MUSIC_BASE}/api/web/qrcode/get`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: REFERER,
      },
      body: new URLSearchParams({ url: pageURL, size: "180" }).toString(),
    });
    if (!response.ok) {
      throw unavailable("网易云二维码获取失败");
    }
    let payload: Record<string, unknown>;
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch {
      throw unavailable("网易云二维码获取失败");
    }
    const imageURL = String(payload.qrcodeImageUrl ?? "");
    if (!isNeteaseImageURL(imageURL)) {
      throw unavailable("网易云二维码获取失败");
    }
    const image = await platformFetch(imageURL, {
      headers: { Referer: REFERER, Accept: "image/*" },
    });
    const bytes = new Uint8Array(await image.arrayBuffer());
    const mime = sniffImageMime(bytes);
    if (!image.ok || !mime) {
      throw unavailable("网易云二维码获取失败");
    }
    return imageDataUrl(bytes, mime);
  }

  async checkQR(key: string): Promise<QRState> {
    const data = await this.request("login/qrcode/client/login", { key, type: 1 });
    const code = Number(data.code ?? 0);
    if (code === 803) {
      return { state: "success", cookies: this.cookie };
    }
    if (code === 802) {
      return { state: "scanned" };
    }
    if (code === 800) {
      return { state: "expired" };
    }
    return { state: "waiting" };
  }

  /** 读取当前登录账号；失败抛错（Cookie 失效会返回 code 301）。 */
  async account(): Promise<NeteaseAccount> {
    const data = await this.request("w/nuser/account/get", {});
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
    const data = await this.request("login/token/refresh", {});
    return Number(data.code ?? 0) === 200;
  }

  /** 内部读取接口；返回原始 `data` 字段或整个响应。 */
  async call(path: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.request(path, payload);
  }
}

/**
 * 只允许取网易云自家域名下的图片。
 *
 * URL 由网易云返回、不是用户给的，风险本来就低；但 Worker 会真的去请求它，
 * 顺手把范围收窄到网易云的域名，免得哪天上游回了个内网地址就被我们照着打。
 */
function isNeteaseImageURL(raw: string): boolean {
  if (!raw.startsWith("https://")) {
    return false;
  }
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "music.163.com" ||
    host.endsWith(".music.163.com") ||
    host.endsWith(".126.net")
  );
}
