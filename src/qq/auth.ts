/**
 * QQ 音乐扫码登录编排。
 *
 * 只把「平台返回的 Cookie」当作凭据：QQ 音乐没有可用的 refresh_token 协议，
 * 长周期 Cookie（`qqmusic_key`/`skey`/`uin`）就是会话本身。因此这里不伪造刷新，
 * 而是定期用一次只读请求探活；探活失败就标记 `logged_out`，让用户重新扫码。
 */

import type { PlatformCredentials } from "../agent/store";
import { PlatformNetworkError } from "../shared/http";
import { QQClient, type QQLoginState } from "./client";

export interface QQLoginStart {
  imageDataUrl: string;
  /** 轮询时必须带上的 Cookie（至少包含 qrsig）。 */
  cookie: string;
}

export type QQLoginPoll =
  | { state: "waiting"; cookie: string }
  | { state: "scanned"; cookie: string }
  | { state: "expired"; cookie: string }
  | { state: "success"; credentials: PlatformCredentials };

/** Cookie 在平台侧的有效期没有公开承诺；这里按 30 天滚动探活。 */
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export async function beginQQLogin(): Promise<QQLoginStart> {
  const client = new QQClient();
  const qr = await client.createQR();
  return { imageDataUrl: qr.imageDataUrl, cookie: qr.cookie };
}

export async function pollQQLogin(cookie: string): Promise<QQLoginPoll> {
  const client = new QQClient(cookie);
  const result: QQLoginState = await client.checkQR();
  if (result.state === "success") {
    return {
      state: "success",
      credentials: {
        accountId: result.result.account.userId,
        nickname: result.result.account.nickname,
        avatarUrl: result.result.account.avatarUrl,
        credential: result.result.credential,
        expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
      },
    };
  }
  return { state: result.state, cookie: client.cookie };
}

/** 探活 + 滚动到期时间。凭据失效返回 null；网络错误向上抛（标记 degraded）。 */
export async function refreshQQ(cookie: string): Promise<PlatformCredentials | null> {
  const client = new QQClient(cookie);
  try {
    await client.call("music.musichallSongListServer", "GetUserMusicList", {
      uin: client.uin,
      offset: 0,
      limit: 1,
      order: 0,
    });
  } catch (error) {
    if (error instanceof PlatformNetworkError) {
      throw error;
    }
    return null;
  }
  return {
    accountId: client.uin,
    nickname: "",
    avatarUrl: "",
    credential: client.cookie,
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
}
