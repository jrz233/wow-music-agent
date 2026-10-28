/**
 * QQ 音乐扫码登录编排。
 *
 * 凭据形如 `uin=<musicid>; qm_keyst=<musickey>`（外加 refresh_token/refresh_key
 * 等续期材料），由 `client.checkQR()` 通过 `QQConnectLogin.LoginServer/QQLogin`
 * 换得。QQ 音乐没有公开的 refresh_token 协议文档，但有 refresh 材料时优先走
 * `music.login.LoginServer/Login` 滚动 musickey；没有材料就用一次资料请求探活。
 */

import type { PlatformCredentials } from "../agent/store";
import { PlatformNetworkError } from "../shared/http";
import { QQClient, type QQLoginState } from "./client";

export interface QQLoginStart {
  imageDataUrl: string;
  /** 轮询时必须带上的 Cookie（至少包含 qrsig）。 */
  cookie: string;
  /** 吐出二维码的那个入口（xui / ssl）：轮询必须回到同一台机器。 */
  endpoint: "xui" | "ssl";
}

export type QQLoginPoll =
  | { state: "waiting"; cookie: string }
  | { state: "scanned"; cookie: string }
  | { state: "expired"; cookie: string }
  | { state: "success"; credentials: PlatformCredentials };

/** musickey 的公开有效期约 90 天；这里按到期前滚动探活、30 天续一次。 */
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export async function beginQQLogin(): Promise<QQLoginStart> {
  const client = new QQClient();
  const qr = await client.createQR();
  return { imageDataUrl: qr.imageDataUrl, cookie: qr.cookie, endpoint: qr.endpoint };
}

export async function pollQQLogin(cookie: string, endpoint: "xui" | "ssl" = "xui"): Promise<QQLoginPoll> {
  const client = new QQClient(cookie, endpoint);
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

/** 探活 / 续期。凭据失效返回 null；网络错误向上抛（标记 degraded）。 */
export async function refreshQQ(cookie: string): Promise<PlatformCredentials | null> {
  const client = new QQClient(cookie);
  let result;
  try {
    result = await client.refresh();
  } catch (error) {
    if (error instanceof PlatformNetworkError) {
      throw error;
    }
    return null;
  }
  if (!result) {
    return null;
  }
  return {
    accountId: client.uin,
    nickname: result.nickname || "",
    avatarUrl: result.avatarUrl || "",
    credential: result.credential,
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
}
