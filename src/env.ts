/**
 * Worker 环境。
 *
 * **没有任何 secret**：管理页用 wow-server 账号 OAuth 登录，存储密钥、管理会话与
 * Agent 签名私钥都由 Durable Object 在首次启动时生成并落库。部署后直接打开
 * `/admin`，填 wow-server 地址即可。
 */
import type { AgentDurableObject } from "./agent/do";

export interface Env {
  AGENT: DurableObjectNamespace<AgentDurableObject>;
}

export const AGENT_VERSION = "0.2.0";
export const AGENT_NAME = "wow-music-agent";
/** 与 wow-server `internal/features/agent` 的 `agentAPIVersion` 对齐。 */
export const AGENT_API_VERSION = 1;

export const SESSION_COOKIE = "wow_agent_session";
export const CSRF_COOKIE = "wow_agent_csrf";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** Durable Object 单例名。单用户部署，避免多租户与枚举。 */
export const OWNER_OBJECT_NAME = "owner";
