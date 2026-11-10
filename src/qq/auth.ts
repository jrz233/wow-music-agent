/**
 * QQ 音乐 App 扫码登录编排。
 *
 * 二维码由 QQ 音乐自己的 `music.login.LoginServer/CreateQRCode` 下发，扫码与
 * 确认结果通过 MQTT over WebSocket 推送（见 `mqtt.ts`），最后用推送里的
 * musicid + token 调 `Login` 换取正式凭据。App 里登录的是 QQ 还是微信账号
 * 都可以，不需要开放平台密钥。
 *
 * 凭据形如 `uin=<musicid>; qm_keyst=<musickey>`（外加 refresh_token/refresh_key
 * 等续期材料）。QQ 音乐没有公开的 refresh_token 协议文档，但有 refresh 材料时
 * 优先走 `music.login.LoginServer/Login` 滚动 musickey；没有材料就用一次资料
 * 请求探活。
 */

import type { PlatformCredentials } from "../agent/store";
import { PlatformNetworkError } from "../shared/http";
import { QQClient, type QQLoginState } from "./client";
import type { MobileQRSocket } from "./mqtt";

export interface QQLoginStart {
  imageDataUrl: string;
  /** 轮询时必须带上的 Cookie（设备身份必须全程一致）。 */
  cookie: string;
  /** 二维码会话：写进 `qr_sessions.key`，轮询时原样带回。 */
  session: string;
}

export type QQLoginPoll =
  | { state: "waiting"; cookie: string }
  | { state: "scanned"; cookie: string }
  | { state: "expired"; cookie: string }
  | { state: "success"; credentials: PlatformCredentials };

/**
 * 上游没给 `musickeyCreateTime + keyExpiresIn` 时的兜底有效期。
 *
 * 正常情况下到期时间由上游字段精确计算（见 `credentialExpiry`）；兜底只用于
 * 旧凭据或接口字段缺失，取一天，让下一轮探活能尽快补上真实值。
 */
const FALLBACK_TTL_SECONDS = 24 * 60 * 60;

export async function beginQQLogin(): Promise<QQLoginStart> {
  const qr = await new QQClient().createMobileQR();
  return { imageDataUrl: qr.imageDataUrl, cookie: qr.cookie, session: qr.qrcodeID };
}

/**
 * 轮询一次扫码状态。
 *
 * App 扫码走 MQTT 长轮询：`waitMs` 是服务端最多挂住的时间，由路由按二维码
 * 剩余有效期裁剪；`socket` 是会话池里跨请求保活的那条连接。
 */
export async function pollQQLogin(
  session: string,
  cookie: string,
  waitMs = 20_000,
  socket?: MobileQRSocket,
): Promise<QQLoginPoll> {
  const qrcodeID = normalizeSessionID(session);
  const client = new QQClient(cookie);
  const result = await client.checkMobileQR(qrcodeID, waitMs, socket);
  return loginPoll(result, client.cookie);
}

/**
 * 兼容部署切换时仍在轮询的旧会话：旧版本的 key 形如 `mobile:<qrcodeID>`。
 * 现在会话 key 就是 qrcodeID。
 */
export function normalizeSessionID(session: string): string {
  return session.startsWith("mobile:") ? session.slice("mobile:".length) : session;
}

/** 把 `QQClient` 的扫码状态转换成面板使用的形状。 */
function loginPoll(result: QQLoginState, cookie: string): QQLoginPoll {
  if (result.state === "success") {
    return {
      state: "success",
      credentials: {
        accountId: result.result.account.userId,
        nickname: result.result.account.nickname,
        avatarUrl: result.result.account.avatarUrl,
        credential: result.result.credential,
        expiresAt:
          result.result.expiresAt || Math.floor(Date.now() / 1000) + FALLBACK_TTL_SECONDS,
      },
    };
  }
  return { state: result.state, cookie };
}

/**
 * 探活 / 续期。凭据失效返回 null；网络错误向上抛（标记 degraded）。
 *
 * `needProfile` 让探活顺手补回昵称 / 头像（旧凭据可能只存了 musicid）。
 */
export async function refreshQQ(
  cookie: string,
  needProfile = false,
): Promise<PlatformCredentials | null> {
  const client = new QQClient(cookie);
  let result;
  try {
    result = await client.refresh(needProfile);
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
    expiresAt: result.expiresAt || Math.floor(Date.now() / 1000) + FALLBACK_TTL_SECONDS,
  };
}
