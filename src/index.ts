/**
 * Worker 入口。
 *
 * 公开面只有 `/healthz`；管理页与 Agent 能力都在 Durable Object 内。DO 没有
 * 公开路由，外部只能通过本 Worker 访问，因此不需要额外的内部鉴权层。
 */

import { Hono } from "hono";
import type { Env } from "./env";
import { AGENT_NAME, AGENT_VERSION, OWNER_OBJECT_NAME } from "./env";
import { AgentDurableObject } from "./agent/do";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) =>
  c.json(
    { ok: true, name: AGENT_NAME, version: AGENT_VERSION },
    { headers: { "Cache-Control": "no-store" } },
  ),
);

app.all("*", (c) => {
  const id = c.env.AGENT.idFromName(OWNER_OBJECT_NAME);
  return c.env.AGENT.get(id).fetch(c.req.raw);
});

app.onError((error, c) => {
  console.error("worker error", error instanceof Error ? error.name : "unknown");
  return c.json({ error: "服务暂时不可用" }, 500);
});

export default {
  fetch: app.fetch,

  /**
   * 每 15 分钟补设一次 alarm 并清理过期数据。
   * 这只是兜底：登录成功后的 alarm 由 DO 自己安排。走 RPC 而不是内部 HTTP，
   * 外部请求无法触发刷新。
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const id = env.AGENT.idFromName(OWNER_OBJECT_NAME);
    const stub = env.AGENT.get(id);
    ctx.waitUntil(
      stub.runMaintenance().catch((error: unknown) => {
        console.error("cron failed", error instanceof Error ? error.name : "unknown");
      }),
    );
  },
};

export { AgentDurableObject };
