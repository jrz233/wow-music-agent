/**
 * 单例 Durable Object。
 *
 * 所有 `/admin/*` 与 `/v1/*` 请求都落到同一个实例：单用户部署，天然没有租户
 * 枚举与跨用户串数据的问题。SQLite 由 DO 提供；平台凭据加密后写入。
 *
 * 两类后台任务：
 *   - alarm：平台会话到期前刷新；
 *   - cron（每 15 分钟）：补设遗漏的 alarm、清理过期 nonce / 会话 / 二维码。
 *
 * cron 通过 Durable Object RPC 调用，不占用任何 HTTP 路径：外部请求无法触发刷新。
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { OWNER_OBJECT_NAME } from "../env";
import { createAdminApp } from "../admin/routes";
import { createV1App } from "./v1";
import { loadIdentity, OAUTH_CALLBACK_PATH, type AgentIdentity } from "./oauth";
import { nextRefreshAt, refreshDue } from "./refresh";
import { redact } from "./redact";
import { AgentStore } from "./store";

const ALARM_MIN_DELAY_MS = 60_000;

/** Hono 实例的结构化类型；避免把各自的 Variables 泛型泄漏到字段声明里。 */
interface FetchApp {
  fetch(request: Request, env?: unknown, ctx?: unknown): Response | Promise<Response>;
}

export class AgentDurableObject extends DurableObject<Env> {
  private readonly storage: DurableObjectStorage;
  private readonly env_: Env;
  private readonly store: AgentStore;
  private readonly identity: Promise<AgentIdentity>;
  private adminApp: FetchApp | null = null;
  private v1App: FetchApp | null = null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.storage = state.storage;
    this.env_ = env;
    this.store = new AgentStore(state.storage);
    // 首次并发请求可能同时触发密钥生成；blockConcurrencyWhile 保证只生成一次。
    this.identity = state.blockConcurrencyWhile(() => loadIdentity(this.store));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 根路径直接进管理页：用户部署完只记得「打开这个域名」，多记一个 `/admin`
    // 只是多一条会写错的路。`/` 只做 302，不渲染任何内容。
    if (url.pathname === "/") {
      return new Response(null, {
        status: 302,
        headers: { Location: "/admin", "Cache-Control": "no-store" },
      });
    }

    // `/oauth/callback` 是 wow-server 的授权回跳，必须绕过管理会话（此时还没登录）。
    if (
      url.pathname !== "/admin" &&
      !url.pathname.startsWith("/admin/") &&
      !url.pathname.startsWith("/v1/") &&
      url.pathname !== OAUTH_CALLBACK_PATH
    ) {
      return new Response("not found", { status: 404 });
    }

    const identity = await this.identity;
    if (url.pathname.startsWith("/v1/")) {
      const app = this.v1App ?? (this.v1App = createV1App(this.store, identity));
      return app.fetch(request, this.env_);
    }

    const admin =
      this.adminApp ??
      (this.adminApp = createAdminApp(this.store, identity, (nextAt) =>
        this.scheduleRefresh(nextAt),
      ));
    return admin.fetch(request, this.env_);
  }

  /** alarm 只做「到期刷新 + 排出下一次」；任何异常都不能让 alarm 链断掉。 */
  async alarm(): Promise<void> {
    try {
      const { summary, nextAt } = await refreshDue(this.store);
      this.store.cleanup(now());
      if (summary.refreshed.length + summary.loggedOut.length + summary.degraded.length > 0) {
        console.log("agent refresh", {
          refreshed: summary.refreshed,
          loggedOut: summary.loggedOut,
          degraded: summary.degraded,
        });
      }
      await this.scheduleRefresh(nextAt);
    } catch (error) {
      console.error("agent alarm failed", redact(error));
      // 出错时不要把 alarm 停掉：15 分钟后重试一次，避免一次网络抖动导致永久不刷新。
      await this.scheduleRefresh(now() + 15 * 60);
    }
  }

  /** 只由 Worker 的 `scheduled` 通过 RPC 调用；没有 HTTP 入口。 */
  async runMaintenance(): Promise<{ ok: boolean; nextAt: number | null }> {
    const { nextAt } = await refreshDue(this.store);
    this.store.cleanup(now());
    await this.scheduleRefresh(nextAt);
    return { ok: true, nextAt };
  }

  private async scheduleRefresh(nextAt: number | null): Promise<void> {
    if (nextAt === null) {
      await this.storage.deleteAlarm();
      return;
    }
    const timestamp = Math.max(nextAt * 1000, Date.now() + ALARM_MIN_DELAY_MS);
    const existing = await this.storage.getAlarm();
    // 不把已经排好的更早 alarm 往后推。
    if (existing !== null && existing <= timestamp && existing > Date.now()) {
      return;
    }
    await this.storage.setAlarm(timestamp);
  }
}

/** 供测试/诊断：DO 单例名必须与 index.ts 一致。 */
export const AGENT_OBJECT_NAME = OWNER_OBJECT_NAME;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function nextAlarmAt(store: AgentStore): number | null {
  return nextRefreshAt(store);
}
