/**
 * Durable Object 的 SQLite 存储。
 *
 * 单用户部署：所有表都只有一份逻辑数据（`agent` / `oauth_pending` 的 id 固定为 1）。
 * 这里没有平台令牌或 PKCE verifier 的明文列——`credential_sealed` 与
 * `oauth_pending.verifier_sealed` 都是 AES-GCM 密文，密钥在 `settings.master_key`，
 * 永远不会出现在响应或日志里。
 */

import type { Platform } from "../shared/types";
import { open, platformAAD, seal } from "./crypto";

export interface AgentRecord {
  agentId: string;
  serverUrl: string;
  serverPublicKey: string;
  publicKey: string;
  accountName: string;
  pairedAt: number;
  lastSeenAt: number;
}

/**
 * 一次尚未完成的 OAuth 授权。
 *
 * `state` 与 `verifier` 是本次浏览器跳转专用的临时材料：授权码换回来后立刻删除，
 * 最多保留 {@link OAUTH_PENDING_TTL_SECONDS}。verifier 加密落库，与平台凭据同一标准。
 */
export interface OAuthPending {
  serverUrl: string;
  state: string;
  verifier: string;
  redirectUri: string;
  agentName: string;
  createdAt: number;
}

/** 授权页最多给人 10 分钟：够登录 + 确认，不够拿来慢慢猜 state。 */
export const OAUTH_PENDING_TTL_SECONDS = 10 * 60;

export interface StoredPlatform {
  platform: Platform;
  accountId: string;
  nickname: string;
  avatarUrl: string;
  expiresAt: number;
  status: string;
  lastRefreshAt: number;
  lastError: string;
  updatedAt: number;
}

export interface PlatformCredentials {
  accountId: string;
  nickname: string;
  avatarUrl: string;
  credential: string;
  expiresAt: number;
}

export class AgentStore {
  private readonly sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        csrf_hash  TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_keys (
        id                 INTEGER PRIMARY KEY CHECK (id = 1),
        public_key         TEXT NOT NULL,
        private_key_sealed TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_pending (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        server_url      TEXT NOT NULL,
        state           TEXT NOT NULL,
        verifier_sealed TEXT NOT NULL,
        redirect_uri    TEXT NOT NULL,
        agent_name      TEXT NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent (
        id                INTEGER PRIMARY KEY CHECK (id = 1),
        agent_id          TEXT NOT NULL,
        server_url        TEXT NOT NULL,
        server_public_key TEXT NOT NULL,
        public_key        TEXT NOT NULL,
        account_name      TEXT NOT NULL,
        paired_at         INTEGER NOT NULL,
        last_seen_at      INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS platforms (
        platform          TEXT PRIMARY KEY,
        account_id        TEXT NOT NULL,
        nickname          TEXT NOT NULL,
        avatar_url        TEXT NOT NULL,
        credential_sealed TEXT NOT NULL,
        expires_at        INTEGER NOT NULL,
        status            TEXT NOT NULL,
        last_refresh_at   INTEGER NOT NULL,
        last_error        TEXT NOT NULL,
        updated_at        INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nonces (
        scope      TEXT NOT NULL,
        nonce      TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (scope, nonce)
      );
      CREATE TABLE IF NOT EXISTS qr_sessions (
        platform   TEXT PRIMARY KEY,
        key        TEXT NOT NULL,
        cookie     TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
    `);
    // 旧版本的 `pairing` 表（配对码流程）不再使用。保留它不影响任何逻辑：里面只有
    // 早已失效的 pair id 与授权链接，upgrade 时不删除用户数据，读代码时也不会被引用。
  }

  getSetting(key: string): string | null {
    const row = this.sql
      .exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)
      .toArray()[0];
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  /** master key 在首次访问时生成；调用方（DO）会传入同一个实例，因此无需锁。 */
  masterKey(): string {
    let value = this.getSetting("master_key");
    if (!value) {
      // 延迟到 crypto.ts，避免 store 依赖 WebCrypto 的初始化顺序。
      value = createMasterKeyValue();
      this.setSetting("master_key", value);
    }
    return value;
  }

  // ---- 管理会话 -------------------------------------------------------------

  createSession(tokenHash: string, csrfHash: string, now: number, expiresAt: number): void {
    this.sql.exec(
      "INSERT INTO sessions (token_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?)",
      tokenHash,
      csrfHash,
      now,
      expiresAt,
    );
  }

  session(tokenHash: string, now: number): { csrfHash: string; expiresAt: number } | null {
    const row = this.sql
      .exec<{ csrf_hash: string; expires_at: number }>(
        "SELECT csrf_hash, expires_at FROM sessions WHERE token_hash = ?",
        tokenHash,
      )
      .toArray()[0];
    if (!row || row.expires_at <= now) {
      return null;
    }
    return { csrfHash: row.csrf_hash, expiresAt: row.expires_at };
  }

  deleteSession(tokenHash: string): void {
    this.sql.exec("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
  }

  deleteAllSessions(): void {
    this.sql.exec("DELETE FROM sessions");
  }

  // ---- Agent 密钥与授权 -----------------------------------------------------

  agentKeys(): { publicKey: string; privateKeySealed: string } | null {
    const row = this.sql
      .exec<{ public_key: string; private_key_sealed: string }>(
        "SELECT public_key, private_key_sealed FROM agent_keys WHERE id = 1",
      )
      .toArray()[0];
    return row ? { publicKey: row.public_key, privateKeySealed: row.private_key_sealed } : null;
  }

  clearAgentKeys(): void {
    this.sql.exec("DELETE FROM agent_keys");
  }

  saveAgentKeys(publicKey: string, privateKeySealed: string): void {
    this.sql.exec(
      `INSERT INTO agent_keys (id, public_key, private_key_sealed) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         public_key = excluded.public_key,
         private_key_sealed = excluded.private_key_sealed`,
      publicKey,
      privateKeySealed,
    );
  }

  async saveOAuth(pending: OAuthPending): Promise<void> {
    const sealed = await seal(this.masterKey(), pending.verifier, "oauth-pkce", "oauth-pkce");
    this.sql.exec(
      `INSERT INTO oauth_pending
         (id, server_url, state, verifier_sealed, redirect_uri, agent_name, created_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         server_url = excluded.server_url,
         state = excluded.state,
         verifier_sealed = excluded.verifier_sealed,
         redirect_uri = excluded.redirect_uri,
         agent_name = excluded.agent_name,
         created_at = excluded.created_at`,
      pending.serverUrl,
      pending.state,
      sealed,
      pending.redirectUri,
      pending.agentName,
      pending.createdAt,
    );
  }

  /** 读出待完成的授权；verifier 在这里解密，调用方用完必须 `clearOAuth()`。 */
  async oauth(): Promise<OAuthPending | null> {
    const row = this.sql
      .exec<{
        server_url: string;
        state: string;
        verifier_sealed: string;
        redirect_uri: string;
        agent_name: string;
        created_at: number;
      }>("SELECT * FROM oauth_pending WHERE id = 1")
      .toArray()[0];
    if (!row) {
      return null;
    }
    const verifier = await open(
      this.masterKey(),
      row.verifier_sealed,
      "oauth-pkce",
      "oauth-pkce",
    );
    return {
      serverUrl: row.server_url,
      state: row.state,
      verifier,
      redirectUri: row.redirect_uri,
      agentName: row.agent_name,
      createdAt: row.created_at,
    };
  }

  clearOAuth(): void {
    this.sql.exec("DELETE FROM oauth_pending");
  }

  agent(): AgentRecord | null {
    const row = this.sql
      .exec<{
        agent_id: string;
        server_url: string;
        server_public_key: string;
        public_key: string;
        account_name: string;
        paired_at: number;
        last_seen_at: number;
      }>("SELECT * FROM agent WHERE id = 1")
      .toArray()[0];
    if (!row) {
      return null;
    }
    return {
      agentId: row.agent_id,
      serverUrl: row.server_url,
      serverPublicKey: row.server_public_key,
      publicKey: row.public_key,
      accountName: row.account_name,
      pairedAt: row.paired_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  saveAgent(record: AgentRecord): void {
    this.sql.exec(
      `INSERT INTO agent
         (id, agent_id, server_url, server_public_key, public_key, account_name, paired_at, last_seen_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         agent_id = excluded.agent_id,
         server_url = excluded.server_url,
         server_public_key = excluded.server_public_key,
         public_key = excluded.public_key,
         account_name = excluded.account_name,
         paired_at = excluded.paired_at,
         last_seen_at = excluded.last_seen_at`,
      record.agentId,
      record.serverUrl,
      record.serverPublicKey,
      record.publicKey,
      record.accountName,
      record.pairedAt,
      record.lastSeenAt,
    );
    // 绑定成功后不应再留着任何一次待完成的授权（含它的 PKCE verifier）。
    this.clearOAuth();
  }

  clearAgent(): void {
    this.sql.exec("DELETE FROM agent");
  }

  touchAgent(now: number): void {
    this.sql.exec("UPDATE agent SET last_seen_at = ? WHERE id = 1", now);
  }

  // ---- 平台会话 -------------------------------------------------------------

  platform(platform: Platform): StoredPlatform | null {
    const row = this.sql
      .exec<{
        platform: Platform;
        account_id: string;
        nickname: string;
        avatar_url: string;
        expires_at: number;
        status: string;
        last_refresh_at: number;
        last_error: string;
        updated_at: number;
      }>("SELECT * FROM platforms WHERE platform = ?", platform)
      .toArray()[0];
    if (!row) {
      return null;
    }
    return {
      platform: row.platform,
      accountId: row.account_id,
      nickname: row.nickname,
      avatarUrl: row.avatar_url,
      expiresAt: row.expires_at,
      status: row.status,
      lastRefreshAt: row.last_refresh_at,
      lastError: row.last_error,
      updatedAt: row.updated_at,
    };
  }

  async saveCredentials(platform: Platform, credentials: PlatformCredentials, now: number): Promise<void> {
    const master = this.masterKey();
    const aad = platformAAD(platform, credentials.accountId);
    const sealed = await seal(master, credentials.credential, aad, aad);
    this.sql.exec(
      `INSERT INTO platforms
         (platform, account_id, nickname, avatar_url, credential_sealed, expires_at, status, last_refresh_at, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, '', ?)
       ON CONFLICT(platform) DO UPDATE SET
         account_id = excluded.account_id,
         nickname = excluded.nickname,
         avatar_url = excluded.avatar_url,
         credential_sealed = excluded.credential_sealed,
         expires_at = excluded.expires_at,
         status = excluded.status,
         last_refresh_at = excluded.last_refresh_at,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
      platform,
      credentials.accountId,
      credentials.nickname,
      credentials.avatarUrl,
      sealed,
      credentials.expiresAt,
      now,
      now,
    );
  }

  async credentials(platform: Platform): Promise<{ credential: string; accountId: string } | null> {
    const row = this.sql
      .exec<{ account_id: string; credential_sealed: string }>(
        "SELECT account_id, credential_sealed FROM platforms WHERE platform = ?",
        platform,
      )
      .toArray()[0];
    if (!row) {
      return null;
    }
    const aad = platformAAD(platform, row.account_id);
    const credential = await open(this.masterKey(), row.credential_sealed, aad, aad);
    return { credential, accountId: row.account_id };
  }

  markPlatform(
    platform: Platform,
    now: number,
    updates: { status?: string; lastRefreshAt?: number; expiresAt?: number; lastError?: string; nickname?: string; avatarUrl?: string },
  ): void {
    const current = this.platform(platform);
    if (!current) return;
    this.sql.exec(
      `UPDATE platforms SET
         status = ?, last_refresh_at = ?, expires_at = ?, last_error = ?,
         nickname = ?, avatar_url = ?, updated_at = ?
       WHERE platform = ?`,
      updates.status ?? current.status,
      updates.lastRefreshAt ?? current.lastRefreshAt,
      updates.expiresAt ?? current.expiresAt,
      updates.lastError ?? current.lastError,
      updates.nickname ?? current.nickname,
      updates.avatarUrl ?? current.avatarUrl,
      now,
      platform,
    );
  }

  clearPlatform(platform: Platform): void {
    this.sql.exec("DELETE FROM platforms WHERE platform = ?", platform);
  }

  /** 会话确定失效：删掉密文、保留昵称等展示信息，状态置为 logged_out。 */
  invalidatePlatform(platform: Platform, now: number, lastError: string): void {
    this.sql.exec(
      `UPDATE platforms SET credential_sealed = '', status = 'logged_out',
         expires_at = 0, last_error = ?, updated_at = ?
       WHERE platform = ?`,
      lastError,
      now,
      platform,
    );
  }

  // ---- nonce / 清理 ---------------------------------------------------------

  /**
   * 插入并检查是否首次使用；返回 false 表示重放。
   *
   * **不要用 `cursor.rowsWritten === 1` 判断**：DO SQLite 的 `rowsWritten` 统计的是
   * 所有被写入的 B 树行，`PRIMARY KEY (scope, nonce)` 的隐式索引也算一行，所以一次
   * 成功插入这里恒为 2。那个写法会让**每个首次请求都被判成重放**，表现为 Agent
   * 永远 401、面板永远离线，而 Server 侧只看到「请求失败」。
   *
   * 改用 `RETURNING`：只在真正插入时返回一行，冲突被 `IGNORE` 掉时零行。
   */
  useNonce(scope: string, nonce: string, expiresAt: number): boolean {
    const inserted = this.sql
      .exec(
        `INSERT OR IGNORE INTO nonces (scope, nonce, expires_at) VALUES (?, ?, ?)
         RETURNING scope`,
        scope,
        nonce,
        expiresAt,
      )
      .toArray();
    return inserted.length === 1;
  }

  cleanup(now: number): void {
    this.sql.exec("DELETE FROM nonces WHERE expires_at <= ?", now);
    this.sql.exec("DELETE FROM sessions WHERE expires_at <= ?", now);
    this.sql.exec("DELETE FROM qr_sessions WHERE created_at <= ?", now - 10 * 60);
    this.sql.exec(
      "DELETE FROM oauth_pending WHERE created_at <= ?",
      now - OAUTH_PENDING_TTL_SECONDS,
    );
  }

  // ---- 二维码会话 -----------------------------------------------------------

  saveQR(platform: Platform, key: string, cookie: string, now: number): void {
    this.sql.exec(
      `INSERT INTO qr_sessions (platform, key, cookie, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(platform) DO UPDATE SET key = excluded.key, cookie = excluded.cookie, created_at = excluded.created_at`,
      platform,
      key,
      cookie,
      now,
    );
  }

  qr(platform: Platform): { key: string; cookie: string; createdAt: number } | null {
    const row = this.sql
      .exec<{ key: string; cookie: string; created_at: number }>(
        "SELECT key, cookie, created_at FROM qr_sessions WHERE platform = ?",
        platform,
      )
      .toArray()[0];
    return row ? { key: row.key, cookie: row.cookie, createdAt: row.created_at } : null;
  }

  clearQR(platform: Platform): void {
    this.sql.exec("DELETE FROM qr_sessions WHERE platform = ?", platform);
  }
}

/** 单独抽出来便于 store 不直接 import crypto（测试可替换）。 */
function createMasterKeyValue(): string {
  const buffer = new Uint8Array(32);
  crypto.getRandomValues(buffer);
  let binary = "";
  for (const byte of buffer) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
