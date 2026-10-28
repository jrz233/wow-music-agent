/**
 * 网易云 weapi 传输层。
 *
 * 只负责：带 Cookie 的 POST、响应解包、Set-Cookie 合并、二维码登录三步。
 * 业务字段映射在 `api.ts`，不要在传输层做形状转换。
 */

import { mergeCookies, parseCookies, platformFetch } from "../shared/http";
import { unavailable } from "../shared/errors";
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
    const image = await platformFetch(`${MUSIC_BASE}/login?codekey=${encodeURIComponent(key)}`, {
      headers: { Referer: REFERER, Accept: "image/*" },
    });
    const contentType = image.headers.get("content-type") ?? "";
    if (!image.ok || !contentType.startsWith("image/")) {
      throw unavailable("网易云二维码获取失败");
    }
    const bytes = new Uint8Array(await image.arrayBuffer());
    return { key, imageDataUrl: `data:${contentType.split(";")[0]};base64,${base64(bytes)}` };
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

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
