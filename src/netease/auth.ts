/**
 * 网易云扫码登录。
 *
 * 二维码由 Worker 抓取后内联成 data URL：管理页的 CSP 不必放行 `music.163.com`，
 * 用户的 IP 也不会直接暴露给二维码图片域。
 */

import type { PlatformCredentials } from "../agent/store";
import { PlatformNetworkError } from "../shared/http";
import type { QRState } from "./client";
import { NeteaseClient } from "./client";

export interface NeteaseQRCode {
  key: string;
  imageDataUrl: string;
  /** 登录轮询必须带上的 Cookie（uniapp 会话）。 */
  cookie: string;
}

export type NeteaseLoginState =
  | { state: "waiting"; cookie: string }
  | { state: "scanned"; cookie: string }
  | { state: "expired"; cookie: string }
  | { state: "success"; credentials: PlatformCredentials };

export async function beginNeteaseLogin(): Promise<NeteaseQRCode> {
  const client = new NeteaseClient();
  const qr = await client.createQR();
  return { key: qr.key, imageDataUrl: qr.imageDataUrl, cookie: client.cookie };
}

export async function pollNeteaseLogin(key: string, cookie: string): Promise<NeteaseLoginState> {
  const client = new NeteaseClient(cookie);
  const result: QRState = await client.checkQR(key);
  if (result.state === "success") {
    // 昵称是次要的：扫码成功就意味着 MUSIC_U 已经拿到了，读账号信息失败不该把
    // 这次登录判成失败（用户只能重新扫码，很烦）。留空由后面的刷新补。
    const account = await client.account().catch(() => null);
    // 先滚动一次有效期；失败不阻断登录（MUSIC_U 本身可能仍是有效的）。
    await client.refresh().catch(() => false);
    return {
      state: "success",
      credentials: {
        accountId: account?.userId ?? "",
        nickname: account?.nickname ?? "",
        avatarUrl: account?.avatarUrl ?? "",
        credential: client.cookie || result.cookies,
        expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      },
    };
  }
  // 轮询响应会带新的 Cookie（NMTID / __csrf 之类），必须回存：丢掉它，下次轮询
  // 就是一个「陌生客户端」，上游认不出这次扫码，状态会从「已扫码」退回「等待扫码」。
  return { state: result.state, cookie: result.cookie };
}

/** 用已保存的 Cookie 探活并刷新。返回新的凭据或 null（已登出）。 */
export async function refreshNetease(cookie: string): Promise<PlatformCredentials | null> {
  const client = new NeteaseClient(cookie);
  try {
    const ok = await client.refresh();
    if (!ok) {
      return null;
    }
    // 刷新成功就说明会话还在；读账号信息失败只影响昵称显示，不该把用户踢下线。
    const account = await client.account().catch(() => null);
    return {
      accountId: account?.userId ?? "",
      nickname: account?.nickname ?? "",
      avatarUrl: account?.avatarUrl ?? "",
      credential: client.cookie,
      expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    };
  } catch (error) {
    if (error instanceof PlatformNetworkError) {
      throw error;
    }
    return null;
  }
}
