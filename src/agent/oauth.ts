/**
 * 与 wow-server 的 OAuth 绑定。
 *
 * Agent 是 OAuth 客户端，wow-server 是身份提供方；用户**不需要在 Agent 里设置任何
 * 密码或密钥**，只要填 wow-server 地址：
 *
 *   1. Agent 生成本地 Ed25519 密钥对（私钥用 master key 封存）；
 *   2. `GET {server}/agent/v1/oauth/authorize?...` 带上自己的 origin、公钥、回调地址、
 *      一次性 state 与 PKCE challenge；wow-server 让用户在浏览器里用本站账号确认；
 *   3. wow-server 回跳 `{endpoint}/oauth/callback?code=…&state=…`；
 *   4. Agent 校验 state，用 `code + verifier` 换回 `agentId` 与 **服务端公钥**，
 *      落库后绑定完成。
 *
 * 服务端地址只允许 https（localhost 例外，便于 `wrangler dev`）。所有出站请求禁止
 * 跟随重定向：避免把授权材料带到第三方 origin。
 */

import type { AgentRecord, AgentStore } from "./store";
import { OAUTH_PENDING_TTL_SECONDS } from "./store";
import { AGENT_NAME, AGENT_VERSION } from "../env";
import { AGENT_COMMIT } from "../commit";
import {
  base64UrlDecode,
  base64UrlEncode,
  canonicalRequest,
  constantTimeEqual,
  generateSigningKey,
  HEADER_AGENT_ID,
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  importPrivateKey,
  keyFingerprint,
  newNonce,
  sign,
  utf8,
} from "./signing";
import { open, seal } from "./crypto";
import {
  AgentError,
  badRequest,
  forbidden,
  tooMany,
  unavailable,
} from "../shared/errors";
import { platformFetch } from "../shared/http";

const OAUTH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** wow-server 的授权页与会话交换接口；与 `internal/features/agent/routes.go` 对齐。 */
const AUTHORIZE_PATH = "/agent/v1/oauth/authorize";
const TOKEN_PATH = "/agent/v1/oauth/token";
/** 由本 Agent 提供的回调路径。wow-server 会要求它与授权请求逐字节一致。 */
export const OAUTH_CALLBACK_PATH = "/oauth/callback";

export interface AgentIdentity {
  publicKey: string;
  publicKeyRaw: Uint8Array;
  privateKey: CryptoKey;
  fingerprint: string;
}

/** 生成本 Agent 的长期签名密钥；已存在则解密复用。 */
export async function loadIdentity(store: AgentStore): Promise<AgentIdentity> {
  const master = store.masterKey();
  const existing = store.agentKeys();
  if (existing) {
    try {
      return await identityFrom(existing.publicKey, existing.privateKeySealed, master);
    } catch {
      // master key 变化或数据损坏：旧密钥已无法使用。清掉绑定关系，重新生成密钥，
      // 让用户重新授权，而不是让整个 DO 永久 500。
      store.clearAgentKeys();
      store.clearAgent();
      store.clearOAuth();
    }
  }
  const generated = await generateSigningKey();
  const publicKey = base64UrlEncode(generated.publicKey);
  const sealed = await seal(
    master,
    base64UrlEncode(generated.privateKeyPkcs8),
    "agent-key",
    "agent-key",
  );
  store.saveAgentKeys(publicKey, sealed);
  return identityFrom(publicKey, sealed, master);
}

async function identityFrom(
  publicKey: string,
  privateKeySealed: string,
  master: string,
): Promise<AgentIdentity> {
  const privateKeyPkcs8 = base64UrlDecode(
    await open(master, privateKeySealed, "agent-key", "agent-key"),
  );
  const publicKeyRaw = base64UrlDecode(publicKey);
  return {
    publicKey,
    publicKeyRaw,
    privateKey: await importPrivateKey(privateKeyPkcs8),
    fingerprint: await keyFingerprint(publicKeyRaw),
  };
}

/** 把用户填的地址收敛成 `https://host[:port]`；不接受路径、query、userinfo。 */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > 300) {
    throw badRequest("wow-server 地址无效");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw badRequest("wow-server 地址无效");
  }
  const local =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw badRequest("wow-server 地址必须是 https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw badRequest("wow-server 地址不能带账号、参数或锚点");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw badRequest("wow-server 地址只填到域名");
  }
  return parsed.origin;
}

export interface OAuthStart {
  authorizeUrl: string;
  redirectUri: string;
}

/**
 * 发起一次授权。
 *
 * state 与 PKCE verifier 都是 256-bit 随机值，只在这一轮授权里有效；落库时 verifier
 * 加密。返回的 URL 让浏览器整页跳去 wow-server——登录态在那边，Agent 不接触密码。
 */
export async function startOAuth(
  store: AgentStore,
  identity: AgentIdentity,
  serverUrl: string,
  endpoint: string,
  agentName: string,
): Promise<OAuthStart> {
  const redirectUri = `${endpoint}${OAUTH_CALLBACK_PATH}`;
  const state = randomToken();
  const verifier = randomToken();
  const agent = sanitizeAccountName(agentName) || AGENT_NAME;

  // 新一轮授权直接替换上一轮：旧 state 立刻作废，避免同时存在两个可用的回调。
  await store.saveOAuth({
    serverUrl,
    state,
    verifier,
    redirectUri,
    agentName: agent,
    createdAt: now(),
  });

  const url = new URL(`${serverUrl}${AUTHORIZE_PATH}`);
  url.searchParams.set("agent_name", agent);
  url.searchParams.set("agent_version", AGENT_VERSION);
  // 源码提交号：服务端拿它和上游仓库的最新提交号比。拿不到就不带这个参数——
  // 服务端会因此不提示更新，而不是误报。
  if (AGENT_COMMIT) {
    url.searchParams.set("agent_commit", AGENT_COMMIT);
  }
  url.searchParams.set("endpoint", endpoint);
  url.searchParams.set("public_key", identity.publicKey);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");

  return { authorizeUrl: url.toString(), redirectUri };
}

/**
 * 处理 wow-server 的回跳：校验 state、换绑定凭据、落库。
 *
 * 授权码是一次性的；只要 wow-server 给出了明确答复（成功或拒绝），本地待办就清掉，
 * 刷新页面不会拿同一个 code 重试。只有网络本身失败时才保留待办，方便用户再试一次。
 */
export async function completeOAuth(
  store: AgentStore,
  identity: AgentIdentity,
  code: string,
  state: string,
  callbackOrigin: string,
): Promise<AgentRecord> {
  const pending = await store.oauth();
  if (!pending) {
    throw badRequest("授权已过期，请重新登录");
  }
  if (now() - pending.createdAt > OAUTH_PENDING_TTL_SECONDS) {
    store.clearOAuth();
    throw badRequest("授权已过期，请重新登录");
  }
  // state 是这一轮授权的凭据：不匹配的回跳一律当作 CSRF，不暴露是哪一项不对。
  if (!constantTimeEqual(state, pending.state)) {
    throw forbidden("授权状态不匹配，请重新登录");
  }
  if (callbackOrigin !== new URL(pending.redirectUri).origin) {
    store.clearOAuth();
    throw forbidden("回调地址不匹配，请重新登录");
  }
  if (!/^[A-Za-z0-9_-]{43}$/u.test(code)) {
    store.clearOAuth();
    throw badRequest("授权码无效，请重新登录");
  }

  const response = await outboundFetch(`${pending.serverUrl}${TOKEN_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      code,
      codeVerifier: pending.verifier,
      redirectUri: pending.redirectUri,
    }),
  });
  store.clearOAuth();

  if (response.status === 429) {
    throw tooMany("授权请求过于频繁，请稍后再试");
  }
  if (response.status === 400 || response.status === 403) {
    throw badRequest("授权已失效，请重新登录");
  }
  if (!response.ok) {
    throw unavailable("wow-server 暂时不可用，请稍后再试");
  }

  const payload = await readJSON(response);
  const agentId = String(payload.agentId ?? "");
  const serverPublicKey = String(payload.serverPublicKey ?? "");
  if (
    !/^[A-Za-z0-9_-]{16,64}$/u.test(agentId) ||
    !/^[A-Za-z0-9_-]{40,64}$/u.test(serverPublicKey)
  ) {
    throw unavailable("wow-server 返回了无效的绑定信息");
  }

  const at = now();
  const record: AgentRecord = {
    agentId,
    serverUrl: pending.serverUrl,
    serverPublicKey,
    publicKey: identity.publicKey,
    accountName: sanitizeAccountName(String(payload.accountName ?? "")),
    pairedAt: at,
    lastSeenAt: at,
  };
  store.saveAgent(record);
  return record;
}

/** 主动通知服务端解除绑定；本地记录无论如何都会清除。 */
export async function unpair(store: AgentStore, identity: AgentIdentity): Promise<void> {
  const agent = store.agent();
  store.clearAgent();
  store.clearOAuth();
  if (!agent) {
    return;
  }
  const response = await signedFetch(
    identity,
    `${agent.serverUrl}/agent/v1/unpair`,
    "POST",
    "/agent/v1/unpair",
    "",
    new Headers({ [HEADER_AGENT_ID]: agent.agentId }),
  ).catch(() => null);
  if (response && response.status >= 500) {
    throw unavailable("本地已解除绑定，但 wow-server 未确认");
  }
}

/** 已绑定 Agent 的展示信息（不含任何密钥原文）。 */
export async function agentSummary(store: AgentStore, identity: AgentIdentity) {
  const agent = store.agent();
  return {
    paired: Boolean(agent),
    agentId: agent?.agentId ?? "",
    fingerprint: identity.fingerprint,
    accountName: agent?.accountName ?? "",
    serverHost: agent ? hostOf(agent.serverUrl) : "",
    pairedAt: agent?.pairedAt ?? 0,
  };
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return "";
  }
}

async function signedFetch(
  identity: AgentIdentity,
  url: string,
  method: string,
  path: string,
  body: string,
  headers: Headers,
): Promise<Response> {
  const timestamp = String(now());
  const nonce = newNonce();
  const bodyBytes = utf8(body);
  const canonical = await canonicalRequest(method, path, "", timestamp, nonce, bodyBytes);
  const signature = await sign(identity.privateKey, canonical);
  headers.set(HEADER_TIMESTAMP, timestamp);
  headers.set(HEADER_NONCE, nonce);
  headers.set(HEADER_SIGNATURE, signature);
  headers.set("Accept", "application/json");
  return outboundFetch(url, {
    method,
    headers: Object.fromEntries(headers.entries()),
    body: body || undefined,
  });
}

async function outboundFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    const response = await platformFetch(url, {
      method: init.method,
      headers: init.headers as Record<string, string>,
      body: typeof init.body === "string" ? init.body : undefined,
      timeoutMs: OAUTH_TIMEOUT_MS,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      throw forbidden("wow-server 返回了重定向，已拒绝跟随");
    }
    return response;
  } catch (error) {
    if (error instanceof AgentError) {
      throw error;
    }
    throw unavailable("无法连接 wow-server，请检查地址与网络");
  }
}

async function readJSON(response: Response): Promise<Record<string, unknown>> {
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_RESPONSE_BYTES) {
    throw unavailable("wow-server 响应过大");
  }
  try {
    return JSON.parse(new TextDecoder().decode(buffer)) as Record<string, unknown>;
  } catch {
    throw unavailable("wow-server 返回的不是 JSON");
  }
}

/** 32 字节随机值的 base64url：43 个字符，同时满足 state 与 PKCE verifier 的字符集。 */
function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function sanitizeAccountName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 64);
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}
