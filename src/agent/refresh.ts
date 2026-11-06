/**
 * 平台会话刷新。
 *
 * Cloudflare 只在 alarm 到期时唤醒 DO，因此「何时刷新」由这里统一计算：
 * 到期前 10 分钟、且至少每 30 分钟探活一次。失败指数退避（15 分钟起），
 * 明确失效才标记 `logged_out` 并清除 alarm；网络错误只降级为 `degraded`。
 *
 * 注意：这里从不把平台返回的错误原文写进 `last_error`，避免把 Cookie 片段
 * 或平台风控信息带到面板。
 */

import type { AgentStore, PlatformCredentials, StoredPlatform } from "./store";
import type { Platform } from "../shared/types";
import { PLATFORMS } from "../shared/types";
import { refreshNetease } from "../netease/auth";
import { refreshQQ } from "../qq/auth";
import { redact } from "./redact";

const REFRESH_AHEAD_SECONDS = 10 * 60;
const MAX_INTERVAL_SECONDS = 30 * 60;
const DEGRADED_BACKOFF_SECONDS = 15 * 60;
const MIN_ALARM_SECONDS = 60;

export interface RefreshSummary {
  refreshed: Platform[];
  loggedOut: Platform[];
  degraded: Platform[];
}

/**
 * 该平台此刻是否需要刷新。
 *
 * 除了临期，**刷新成功本身也会滑动有效期**（QQ 每次续期重新给 30 天），所以
 * 平时也要按 `MAX_INTERVAL_SECONDS` 滚动续一次：只在临期前才动手的话，长期
 * 不打开面板的账号会在 30 天后直接掉线，面板上的「下次自动刷新」也就成了空话。
 */
export function platformDue(
  row: StoredPlatform | null,
  now = Math.floor(Date.now() / 1000),
): boolean {
  if (!row || row.status === "logged_out") {
    return false;
  }
  if (row.status === "degraded") {
    return true;
  }
  if (row.expiresAt === 0 || row.expiresAt - REFRESH_AHEAD_SECONDS <= now) {
    return true;
  }
  // 旧数据没有刷新时间：先探一次，避免一直等到 30 天后才发现失效。
  return row.lastRefreshAt <= 0 || now - row.lastRefreshAt >= MAX_INTERVAL_SECONDS;
}

/** 刷新所有**已到期**的平台会话；返回下一次需要唤醒的时间（秒），无会话返回 null。 */
export async function refreshDue(store: AgentStore, now = Math.floor(Date.now() / 1000)): Promise<{
  summary: RefreshSummary;
  nextAt: number | null;
}> {
  const summary: RefreshSummary = { refreshed: [], loggedOut: [], degraded: [] };
  for (const platform of PLATFORMS) {
    const row = store.platform(platform);
    if (!row || !platformDue(row, now)) {
      continue;
    }
    await refreshOne(store, platform, row, summary, now);
  }
  return { summary, nextAt: nextRefreshAt(store, now) };
}

/** 单个平台下一次该刷新的时刻；未登录返回 null。 */
export function platformNextRefreshAt(
  store: AgentStore,
  platform: Platform,
  now = Math.floor(Date.now() / 1000),
): number | null {
  const row = store.platform(platform);
  if (!row || row.status === "logged_out") {
    return null;
  }
  if (row.status === "degraded") {
    return now + DEGRADED_BACKOFF_SECONDS;
  }
  // 与 platformDue 的三个条件一一对应：没记录 / 未知到期时间 → 立刻安排。
  if (row.lastRefreshAt <= 0 || row.expiresAt === 0) {
    return now;
  }
  const probeAt = row.lastRefreshAt + MAX_INTERVAL_SECONDS;
  const expiryAt = row.expiresAt - REFRESH_AHEAD_SECONDS;
  return Math.min(probeAt, expiryAt);
}

/** 登录成功后立刻安排一次刷新；调用方负责 `storage.setAlarm`。 */
export function nextRefreshAt(store: AgentStore, now = Math.floor(Date.now() / 1000)): number | null {
  let next: number | null = null;
  for (const platform of PLATFORMS) {
    const candidate = platformNextRefreshAt(store, platform, now);
    if (candidate === null) {
      continue;
    }
    if (next === null || candidate < next) {
      next = candidate;
    }
  }
  if (next === null) {
    return null;
  }
  return Math.max(next, now + MIN_ALARM_SECONDS);
}

export interface ManualRefreshResult {
  state: "ok" | "degraded" | "logged_out" | "missing";
  message: string;
  nextAt: number | null;
}

/**
 * 手动刷新一个平台：不等到期，立刻用已保存的凭据续期一次。
 *
 * 令牌本来就有 alarm 自动刷新；这个入口只是让用户在想确认「令牌还有没有效」
 * 时不必等下一次 alarm。失败不会往外抛：面板要把原因显示出来，而不是 500。
 */
export async function refreshPlatformNow(
  store: AgentStore,
  platform: Platform,
  now = Math.floor(Date.now() / 1000),
): Promise<ManualRefreshResult> {
  const row = store.platform(platform);
  if (!row || row.status === "logged_out") {
    return {
      state: "missing",
      message: "尚未登录，无法刷新令牌",
      nextAt: nextRefreshAt(store, now),
    };
  }
  const summary: RefreshSummary = { refreshed: [], loggedOut: [], degraded: [] };
  await refreshOne(store, platform, row, summary, now);
  const nextAt = nextRefreshAt(store, now);
  if (summary.loggedOut.length > 0) {
    return { state: "logged_out", message: "登录已失效，请重新扫码", nextAt };
  }
  if (summary.degraded.length > 0) {
    return { state: "degraded", message: "刷新暂时失败，稍后会自动重试", nextAt };
  }
  return { state: "ok", message: "令牌已刷新", nextAt };
}

async function refreshOne(
  store: AgentStore,
  platform: Platform,
  row: StoredPlatform,
  summary: RefreshSummary,
  now: number,
): Promise<void> {
  let credentials: { credential: string; accountId: string } | null;
  try {
    credentials = await store.credentials(platform);
  } catch (error) {
    // 解密失败通常意味着 master key 变了或数据损坏；只能重新扫码。
    store.invalidatePlatform(platform, now, `凭据无法解密，请重新登录（${redact(error)}）`);
    summary.loggedOut.push(platform);
    return;
  }
  if (!credentials || credentials.credential === "") {
    store.invalidatePlatform(platform, now, "登录已失效，请重新扫码");
    summary.loggedOut.push(platform);
    return;
  }

  let refreshed: PlatformCredentials | null;
  try {
    refreshed =
      platform === "qq"
        ? await refreshQQ(credentials.credential)
        : await refreshNetease(credentials.credential);
  } catch (error) {
    store.markPlatform(platform, now, {
      status: "degraded",
      lastError: `刷新暂时失败，稍后重试：${redact(error)}`,
    });
    summary.degraded.push(platform);
    return;
  }

  if (!refreshed) {
    store.invalidatePlatform(platform, now, "登录已失效，请重新扫码");
    summary.loggedOut.push(platform);
    return;
  }

  const merged: PlatformCredentials = {
    accountId: refreshed.accountId || row.accountId,
    nickname: refreshed.nickname || row.nickname,
    avatarUrl: refreshed.avatarUrl || row.avatarUrl,
    credential: refreshed.credential,
    expiresAt:
      refreshed.expiresAt > now ? refreshed.expiresAt : now + MAX_INTERVAL_SECONDS,
  };
  await store.saveCredentials(platform, merged, now);
  summary.refreshed.push(platform);
}

/** 登录成功后的统一入口：落库并返回下一次刷新时间。 */
export async function storeLogin(
  store: AgentStore,
  platform: Platform,
  credentials: PlatformCredentials,
  now = Math.floor(Date.now() / 1000),
): Promise<number | null> {
  await store.saveCredentials(platform, credentials, now);
  store.clearQR(platform);
  return nextRefreshAt(store, now);
}

/** 用已保存凭据构造平台客户端；未登录返回 null。 */
export async function platformCredential(store: AgentStore, platform: Platform): Promise<string | null> {
  const row = store.platform(platform);
  if (!row || row.status === "logged_out") {
    return null;
  }
  try {
    const credentials = await store.credentials(platform);
    return credentials?.credential || null;
  } catch {
    return null;
  }
}

/** 管理页展示用的平台状态（不含凭据）。 */
export function platformView(store: AgentStore, platform: Platform) {
  const row = store.platform(platform);
  if (!row) {
    return {
      platform,
      loggedIn: false,
      status: "logged_out",
      accountId: "",
      nickname: "",
      avatarUrl: "",
      expiresAt: 0,
      lastRefreshAt: 0,
      nextRefreshAt: 0,
      lastError: "",
    };
  }
  return {
    platform,
    loggedIn: row.status !== "logged_out",
    status: row.status,
    accountId: row.accountId,
    nickname: row.nickname,
    avatarUrl: row.avatarUrl,
    expiresAt: row.expiresAt,
    lastRefreshAt: row.lastRefreshAt,
    nextRefreshAt: platformNextRefreshAt(store, platform) ?? 0,
    lastError: row.lastError,
  };
}
