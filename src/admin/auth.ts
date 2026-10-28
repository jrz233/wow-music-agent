/**
 * 管理面鉴权。
 *
 * Agent 没有自己的密码：管理页的登录 = 用 wow-server 账号完成一次 OAuth 授权。
 * 只有 OAuth 回调成功、拿到绑定凭据之后，这里才签发管理会话。因此：
 *
 * - 没有可被爆破的本地密码，也没有本地登录限流要维护；
 * - 会话是随机 256-bit token，SQLite 只存 SHA-256；
 * - 所有不安全方法要求 Origin/Referer 与自身同源，并校验双提交 CSRF token
 *   （Cookie 值 + 服务端会话里的哈希）。
 *
 * Cookie 用 `SameSite=Lax` 而不是 `Strict`：OAuth 回调是从 wow-server 跨站跳回来的
 * 顶层导航，`Strict` 会让紧随其后的 `/admin` 请求带不上会话，凭空多一次跳转。
 * `Lax` 仍然拦截跨站 POST；写操作还有同源校验与 CSRF token 兜底。
 */

import type { AgentStore } from "../agent/store";
import { CSRF_COOKIE, SESSION_COOKIE, SESSION_TTL_SECONDS } from "../env";
import { constantTimeEqual, newNonce, sha256Hex } from "../agent/signing";
import { forbidden, unauthorized } from "../shared/errors";
import { parseCookies } from "../shared/http";

const CSRF_HEADER = "X-CSRF-Token";

export interface AdminSession {
  tokenHash: string;
  csrfHash: string;
  expiresAt: number;
}

/** 校验会话（GET）。返回 null 时调用方跳转登录页。 */
export async function currentSession(
  request: Request,
  store: AgentStore,
  now = Math.floor(Date.now() / 1000),
): Promise<AdminSession | null> {
  const token = parseCookies(request.headers.get("Cookie") ?? "").get(SESSION_COOKIE) ?? "";
  if (!/^[A-Za-z0-9_-]{32,64}$/u.test(token)) {
    return null;
  }
  const tokenHash = await sha256Hex(token);
  const session = store.session(tokenHash, now);
  if (!session) {
    return null;
  }
  return {
    tokenHash,
    csrfHash: session.csrfHash,
    expiresAt: session.expiresAt,
  };
}

/**
 * 校验会话 + 同源 + CSRF；用于所有写操作。
 * `csrfToken` 可以来自表单字段或 `X-CSRF-Token`。
 */
export async function requireAdminWrite(
  request: Request,
  store: AgentStore,
  csrfToken: string,
  now = Math.floor(Date.now() / 1000),
): Promise<AdminSession> {
  const session = await currentSession(request, store, now);
  if (!session) {
    throw unauthorized("请先登录");
  }
  if (!sameOrigin(request)) {
    throw forbidden("来源校验失败");
  }
  if (!/^[A-Za-z0-9_-]{32,64}$/u.test(csrfToken)) {
    throw forbidden("CSRF 校验失败");
  }
  const hash = await sha256Hex(csrfToken);
  if (!constantTimeEqual(hash, session.csrfHash)) {
    throw forbidden("CSRF 校验失败");
  }
  return session;
}

export function csrfFromRequest(request: Request, formToken?: string | null): string {
  return formToken ?? request.headers.get(CSRF_HEADER) ?? "";
}

/**
 * OAuth 成功后签发唯一的会话。
 *
 * 单用户管理面：每次登录都注销其他设备上的旧会话——这同时是「换一台设备重新授权」
 * 时的紧急吊销路径，旧浏览器会立刻掉线。
 */
export async function startSession(
  request: Request,
  store: AgentStore,
  now = Math.floor(Date.now() / 1000),
): Promise<{ sessionCookie: string; csrfCookie: string; csrfToken: string }> {
  store.deleteAllSessions();

  const token = newNonce() + newNonce();
  const csrfToken = newNonce() + newNonce();
  store.createSession(
    await sha256Hex(token),
    await sha256Hex(csrfToken),
    now,
    now + SESSION_TTL_SECONDS,
  );
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return {
    sessionCookie: `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}${secure}`,
    csrfCookie: `${CSRF_COOKIE}=${csrfToken}; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}${secure}`,
    csrfToken,
  };
}

export function logoutCookies(request: Request): string[] {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return [
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
    `${CSRF_COOKIE}=; SameSite=Lax; Path=/; Max-Age=0${secure}`,
  ];
}

export async function logout(request: Request, store: AgentStore): Promise<string[]> {
  const token = parseCookies(request.headers.get("Cookie") ?? "").get(SESSION_COOKIE) ?? "";
  if (token) {
    store.deleteSession(await sha256Hex(token));
  }
  return logoutCookies(request);
}

/** 同源校验：Origin 缺失时退回 Referer；两者都没有则拒绝。 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  const self = new URL(request.url).origin;
  if (origin) {
    return origin === self;
  }
  const referer = request.headers.get("Referer");
  if (!referer) {
    return false;
  }
  try {
    return new URL(referer).origin === self;
  } catch {
    return false;
  }
}

export function csrfCookieValue(request: Request): string {
  return parseCookies(request.headers.get("Cookie") ?? "").get(CSRF_COOKIE) ?? "";
}
