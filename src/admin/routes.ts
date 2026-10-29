/**
 * 管理面路由。
 *
 * 登录 = 用 wow-server 账号完成 OAuth：本文件只负责把浏览器送去授权页、接收回跳、
 * 换回绑定凭据，然后签发管理会话。没有本地密码。
 *
 * 页面的 CSP 是 `default-src 'none'` + 单个 nonce：没有外部 CDN、没有内联事件
 * 属性、没有 `unsafe-inline`。二维码以 data URL 内联，因此也不需要放行平台图片域。
 */

import { Hono, type Context } from "hono";
import type { AgentIdentity } from "../agent/oauth";
import {
  agentSummary,
  completeOAuth,
  normalizeServerUrl,
  startOAuth,
  unpair,
} from "../agent/oauth";
import {
  platformView,
  nextRefreshAt,
  refreshPlatformNow,
  storeLogin,
} from "../agent/refresh";
import { redact } from "../agent/redact";
import type { AgentStore } from "../agent/store";
import { AgentError, badRequest, forbidden } from "../shared/errors";
import { beginNeteaseLogin, pollNeteaseLogin } from "../netease/auth";
import { beginQQLogin, pollQQLogin } from "../qq/auth";
import { constantTimeEqual, newNonce } from "../agent/signing";
import {
  csrfCookieValue,
  currentSession,
  logout,
  requireAdminWrite,
  sameOrigin,
  startSession,
} from "./auth";
import {
  dashboardPage,
  loginPage,
  oauthRedirectPage,
  type PairedView,
  type PlatformView,
} from "./html";

export type ScheduleRefresh = (nextAt: number | null) => Promise<void>;

export function createAdminApp(
  store: AgentStore,
  identity: AgentIdentity,
  scheduleRefresh: ScheduleRefresh,
) {
  const app = new Hono();

  // ---- 登录：跳去 wow-server 授权 -------------------------------------------

  app.get("/admin/login", async (c) => {
    const session = await currentSession(c.req.raw, store);
    if (session) {
      return redirect("/admin");
    }
    return renderLogin(c, store, safeMessage(c.req.query("message")), suggestedServerUrl(store));
  });

  // 未登录时唯一能 POST 的入口：不校验 CSRF（还没有会话），只校验同源。
  app.post("/admin/login", async (c) => {
    const form = await c.req.parseBody();
    const serverUrl = formString(form, "serverUrl");
    try {
      if (!sameOrigin(c.req.raw)) {
        throw forbidden("来源校验失败");
      }
      return await renderAuthorize(c, store, identity, serverUrl, formString(form, "agentName"));
    } catch (error) {
      return renderLogin(c, store, publicMessage(error), serverUrl, errorStatus(error));
    }
  });

  /**
   * OAuth 回跳。wow-server 只把一次性 code 与 state 放在 query 里；身份由 state 证明，
   * 不需要 Cookie（此时还没有会话）。
   */
  app.get("/oauth/callback", async (c) => {
    const code = c.req.query("code") ?? "";
    const state = c.req.query("state") ?? "";
    const denied = c.req.query("error") ?? "";
    try {
      if (denied) {
        // 拒绝也是一次有效回跳：先验证 state，再清掉待办，避免无限重试。
        const pending = await store.oauth();
        if (!pending || !constantTimeEqual(state, pending.state)) {
          throw forbidden("授权状态不匹配，请重新登录");
        }
        store.clearOAuth();
        return loginRedirect(denied === "access_denied" ? "授权已取消" : "授权未完成，请重新登录");
      }
      const record = await completeOAuth(
        store,
        identity,
        code,
        state,
        new URL(c.req.url).origin,
      );
      const session = await startSession(c.req.raw, store);
      console.log("agent connected", {
        agentId: record.agentId,
        account: record.accountName,
      });
      const message = record.accountName
        ? `已连接 ${record.accountName}`
        : "已完成连接";
      return redirect("/admin?message=" + encodeURIComponent(message), [
        session.sessionCookie,
        session.csrfCookie,
      ]);
    } catch (error) {
      const message = publicMessage(error);
      if (!(error instanceof AgentError) || error.status >= 500) {
        console.error("oauth callback failed", message);
      }
      return loginRedirect(message);
    }
  });

  app.post("/admin/logout", async (c) => {
    const form = await c.req.parseBody();
    await requireAdminWrite(c.req.raw, store, formString(form, "_csrf"));
    const cookies = await logout(c.req.raw, store);
    return redirect("/admin/login", cookies);
  });

  app.get("/admin", async (c) => {
    const guard = await pageSession(c, store);
    if (guard instanceof Response) {
      return guard;
    }
    return renderDashboard(c, store, identity, guard.csrf, safeMessage(c.req.query("message")));
  });

  // 已登录后更换 / 重新连接 wow-server。与登录页一样落到中转页。
  app.post("/admin/connect", async (c) => {
    const form = await c.req.parseBody();
    await requireAdminWrite(c.req.raw, store, formString(form, "_csrf"));
    try {
      return await renderAuthorize(
        c,
        store,
        identity,
        formString(form, "serverUrl"),
        formString(form, "agentName"),
      );
    } catch (error) {
      return renderDashboard(c, store, identity, csrfCookieValue(c.req.raw), publicMessage(error));
    }
  });

  // ---- 扫码登录 -------------------------------------------------------------

  // 旧的独立扫码页不再使用：二维码在概览的卡片下方就地展开。收藏了旧地址的
  // 浏览器仍然能回来，但不会再从导航误触一次「重新扫码」。
  app.get("/admin/qq", (c) => redirect("/admin"));
  app.get("/admin/netease", (c) => redirect("/admin"));

  /**
   * 就地获取二维码。返回 JSON 而不是整页：页面拿到后插到卡片下方并开始轮询，
   * 登录成功后整页刷新，卡片自然变成已登录状态。
   */
  app.get("/admin/api/:platform/qr", async (c) => {
    const guard = await pageSession(c, store);
    if (guard instanceof Response) {
      return json({ message: "登录已过期，请刷新页面" }, 401);
    }
    const platform = c.req.param("platform");
    if (platform !== "qq" && platform !== "netease") {
      return json({ message: "平台无效" }, 400);
    }
    try {
      if (platform === "qq") {
        const start = await beginQQLogin();
        // QQ 的 `key` 列存的是入口标识（xui / ssl），不是二维码 key——轮询必须回到
        // 同一台机器，qrsig 才对得上。
        store.saveQR("qq", start.endpoint, start.cookie, now());
        return json({ imageDataUrl: start.imageDataUrl });
      }
      const start = await beginNeteaseLogin();
      store.saveQR("netease", start.key, start.cookie, now());
      return json({ imageDataUrl: start.imageDataUrl });
    } catch (error) {
      const message = publicMessage(error);
      console.error(`${platform} qr failed`, { message, detail: redact(error) });
      return json({ message }, 502);
    }
  });

  app.get("/admin/api/qq/status", async (c) => {
    const guard = await pageSession(c, store);
    if (guard instanceof Response) {
      return json({ state: "error", message: "登录已过期" }, 401);
    }
    const qr = store.qr("qq");
    if (!qr || qr.createdAt < now() - 10 * 60) {
      store.clearQR("qq");
      return json({ state: "expired" });
    }
    try {
      const result = await pollQQLogin(qr.cookie, qr.key === "ssl" ? "ssl" : "xui");
      if (result.state === "success") {
        const nextAt = await storeLogin(store, "qq", result.credentials);
        await scheduleRefresh(nextAt);
        return json({ state: "success", nickname: result.credentials.nickname });
      }
      store.saveQR("qq", qr.key, result.cookie, qr.createdAt);
      return json({ state: result.state });
    } catch (error) {
      const message = publicMessage(error);
      // 扫码失败的原因必须能在日志里看到：页面上只显示「等待扫码」的话，
      // 用户和排查的人都是两眼一抹黑。
      console.error("qq login poll failed", { message, detail: redact(error) });
      return json({ state: "error", message }, 502);
    }
  });

  app.get("/admin/api/netease/status", async (c) => {
    const guard = await pageSession(c, store);
    if (guard instanceof Response) {
      return json({ state: "error", message: "登录已过期" }, 401);
    }
    const qr = store.qr("netease");
    if (!qr || qr.createdAt < now() - 10 * 60) {
      store.clearQR("netease");
      return json({ state: "expired" });
    }
    try {
      const result = await pollNeteaseLogin(qr.key, qr.cookie);
      if (result.state === "success") {
        const nextAt = await storeLogin(store, "netease", result.credentials);
        await scheduleRefresh(nextAt);
        return json({ state: "success", nickname: result.credentials.nickname });
      }
      // 轮询响应里带回来的 Cookie 要回存：丢掉它，下次轮询就换了身份，
      // 上游认不出这次扫码，状态会从「已扫码」退回「等待扫码」。
      store.saveQR("netease", qr.key, result.cookie, qr.createdAt);
      return json({ state: result.state });
    } catch (error) {
      const message = publicMessage(error);
      console.error("netease login poll failed", { message, detail: redact(error) });
      return json({ state: "error", message }, 502);
    }
  });

  // 手动续期一次。令牌本来就有 alarm 自动刷新，这里只是让用户能立刻确认
  // 「令牌还有没有效」，失败原因也走同一条消息回显。
  app.post("/admin/api/platform/:platform/refresh", async (c) => {
    const form = await c.req.parseBody();
    await requireAdminWrite(c.req.raw, store, formString(form, "_csrf"));
    const platform = c.req.param("platform");
    if (platform !== "qq" && platform !== "netease") {
      throw badRequest("平台无效");
    }
    const result = await refreshPlatformNow(store, platform);
    await scheduleRefresh(result.nextAt);
    return redirect("/admin?message=" + encodeURIComponent(result.message));
  });

  app.post("/admin/api/platform/:platform/logout", async (c) => {
    const form = await c.req.parseBody();
    await requireAdminWrite(c.req.raw, store, formString(form, "_csrf"));
    const platform = c.req.param("platform");
    if (platform !== "qq" && platform !== "netease") {
      throw badRequest("平台无效");
    }
    store.clearPlatform(platform);
    store.clearQR(platform);
    await scheduleRefresh(nextRefreshAt(store));
    return redirect("/admin?message=" + encodeURIComponent("已退出平台登录"));
  });

  app.post("/admin/unpair", async (c) => {
    const form = await c.req.parseBody();
    await requireAdminWrite(c.req.raw, store, formString(form, "_csrf"));
    let message = "已解除绑定";
    try {
      await unpair(store, identity);
    } catch (error) {
      message = publicMessage(error);
    }
    return redirect("/admin?message=" + encodeURIComponent(message));
  });

  app.notFound((c) => simpleError(404, "页面不存在"));

  app.onError((error) => {
    const message = publicMessage(error);
    if (!(error instanceof AgentError)) {
      console.error("admin error", message);
    }
    return simpleError(errorStatus(error), message);
  });

  return app;
}

// ---- 渲染辅助 ---------------------------------------------------------------

async function pageSession(c: Context, store: AgentStore) {
  const session = await currentSession(c.req.raw, store);
  if (!session) {
    return redirect("/admin/login");
  }
  return { csrf: csrfCookieValue(c.req.raw) };
}

/** 校验地址、生成 pending 与授权链接，再返回同源中转页。 */
async function renderAuthorize(
  c: Context,
  store: AgentStore,
  identity: AgentIdentity,
  rawServerUrl: string,
  agentName: string,
): Promise<Response> {
  const serverUrl = normalizeServerUrl(rawServerUrl);
  const endpoint = agentEndpoint(c.req.url);
  const start = await startOAuth(store, identity, serverUrl, endpoint, agentName);
  const nonce = newNonce();
  return html(oauthRedirectPage(nonce, start.authorizeUrl), nonce);
}

function renderLogin(
  c: Context,
  store: AgentStore,
  message: string,
  serverUrl: string,
  status = 200,
): Response {
  const nonce = newNonce();
  return html(loginPage(nonce, message, serverUrl), nonce, status);
}

async function renderDashboard(
  c: Context,
  store: AgentStore,
  identity: AgentIdentity,
  csrf: string,
  message: string,
  status = 200,
): Promise<Response> {
  const nonce = newNonce();
  const summary = await agentSummary(store, identity);
  const paired: PairedView = summary;
  const platforms = [platformView(store, "qq"), platformView(store, "netease")] as PlatformView[];
  const body = dashboardPage({ nonce, csrf, platforms, paired, message });
  return html(body, nonce, status);
}

/** 登录页预填上次用过的地址；仅此用途，不构成信任。 */
function suggestedServerUrl(store: AgentStore): string {
  return store.agent()?.serverUrl ?? "";
}

function loginRedirect(message: string): Response {
  return redirect("/admin/login?message=" + encodeURIComponent(message));
}

function html(body: string, nonce: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "img-src 'self' data:",
        "connect-src 'self'",
        "form-action 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
      // 必须是 `same-origin`，不能是 `no-referrer`：按 Fetch 规范，referrer policy 为
      // `no-referrer` 时浏览器会把**同源**表单 POST 的 `Origin` 也写成 `null`，
      // 同源校验就再也拿不到可信来源（实测无头 Chromium：`Origin: null` + 无
      // `Referer` → 403）。`same-origin` 仍然不给**跨站**请求带 `Referer`，
      // 中转页跳去 wow-server 时地址里的 `state` 照样不外泄。
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(null, { status: 303, headers });
}

function simpleError(status: number, message: string): Response {
  const nonce = newNonce();
  const escaped = message
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
  return html(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WOW 音乐 Agent</title>
  <style nonce="${nonce}">body{font-family:system-ui,sans-serif;padding:40px;max-width:520px;margin:auto;line-height:1.6}</style>
  </head><body><h1>WOW 音乐 Agent</h1><p>${escaped}</p>
  <p><a href="/admin">返回管理页</a></p></body></html>`,
    nonce,
    status,
  );
}

function formString(form: Record<string, string | File>, key: string): string {
  const value = form[key];
  return typeof value === "string" ? value : "";
}

/**
 * 本 Agent 对 wow-server 声明的公开地址。
 *
 * 必须是 https：wow-server 的 SSRF 校验只放行公网 https，而 `wrangler dev` 的
 * http://localhost 无法被远端访问。管理页非 https 时直接给出可操作的提示。
 */
function agentEndpoint(rawUrl: string): string {
  const endpoint = new URL(rawUrl).origin;
  if (!endpoint.startsWith("https://")) {
    throw badRequest("当前管理页不是 https，wow-server 无法回调本 Agent；请使用 workers.dev 或自定义域名");
  }
  return endpoint;
}

function publicMessage(error: unknown): string {
  if (error instanceof AgentError) {
    return error.publicMessage;
  }
  return "操作失败，请稍后再试";
}

function errorStatus(error: unknown): number {
  if (error instanceof AgentError) {
    return error.status;
  }
  return 500;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function safeMessage(value: string | undefined): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 200);
}
