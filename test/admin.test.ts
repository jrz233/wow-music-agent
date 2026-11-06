import { describe, expect, it } from "vitest";
import type { AgentStore } from "../src/agent/store";
import type { AgentIdentity } from "../src/agent/oauth";
import { SESSION_COOKIE } from "../src/env";
import { createAdminApp } from "../src/admin/routes";
import {
  currentSession,
  requireAdminWrite,
  sameOrigin,
  startSession,
} from "../src/admin/auth";

function fakeStore() {
  const sessions = new Map<string, { csrfHash: string; expiresAt: number }>();
  const store = {
    createSession: (tokenHash: string, csrfHash: string, _now: number, expiresAt: number) => {
      sessions.set(tokenHash, { csrfHash, expiresAt });
    },
    session: (tokenHash: string, now: number) => {
      const found = sessions.get(tokenHash);
      return found && found.expiresAt > now ? found : null;
    },
    deleteSession: (tokenHash: string) => sessions.delete(tokenHash),
    deleteAllSessions: () => sessions.clear(),
  };
  return { store: store as unknown as AgentStore, sessions };
}

function request(origin = "https://agent.example"): Request {
  return new Request("https://agent.example/admin/login", {
    method: "POST",
    headers: { Origin: origin },
  });
}

function cookiePair(setCookie: string): { name: string; value: string } {
  const pair = setCookie.split(";")[0] ?? "";
  const index = pair.indexOf("=");
  return { name: pair.slice(0, index), value: pair.slice(index + 1) };
}

describe("admin session", () => {
  it("sets HttpOnly session and readable CSRF cookies", async () => {
    const { store, sessions } = fakeStore();
    const result = await startSession(request(), store);

    expect(result.sessionCookie).toContain("HttpOnly");
    // Lax 而不是 Strict：OAuth 回调是跨站顶层跳转，Strict 会让紧随的 /admin 掉登录。
    expect(result.sessionCookie).toContain("SameSite=Lax");
    expect(result.sessionCookie).toContain("Secure");
    expect(result.csrfCookie).not.toContain("HttpOnly");
    expect(sessions.size).toBe(1);
  });

  it("invalidates older sessions on a new login", async () => {
    const { store, sessions } = fakeStore();
    const first = await startSession(request(), store);
    const firstToken = cookiePair(first.sessionCookie).value;
    await startSession(request(), store);

    expect(sessions).toHaveLength(1);
    const header = new Request("https://agent.example/admin", {
      headers: { Cookie: `${SESSION_COOKIE}=${firstToken}` },
    });
    expect(await currentSession(header, store)).toBeNull();
  });

  it("accepts the issued session and rejects tampered tokens", async () => {
    const { store } = fakeStore();
    const started = await startSession(request(), store);
    const token = cookiePair(started.sessionCookie).value;

    const valid = new Request("https://agent.example/admin", {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    const session = await currentSession(valid, store);
    expect(session?.csrfHash).toBeTruthy();

    const tampered = new Request("https://agent.example/admin", {
      headers: { Cookie: `${SESSION_COOKIE}=${token.slice(0, -1)}x` },
    });
    expect(await currentSession(tampered, store)).toBeNull();
  });

  it("rejects an expired session", async () => {
    const { store } = fakeStore();
    const started = await startSession(request(), store);
    const token = cookiePair(started.sessionCookie).value;
    const later = Math.floor(Date.now() / 1000) + 13 * 60 * 60;
    const expiring = new Request("https://agent.example/admin", {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(await currentSession(expiring, store, later)).toBeNull();
  });
});

describe("admin writes", () => {
  it("requires session, same origin and the matching CSRF token", async () => {
    const { store } = fakeStore();
    const started = await startSession(request(), store);
    const token = cookiePair(started.sessionCookie).value;

    const write = (origin: string, csrf: string) =>
      new Request("https://agent.example/admin/logout", {
        method: "POST",
        headers: { Origin: origin, Cookie: `${SESSION_COOKIE}=${token}` },
      });

    await expect(
      requireAdminWrite(write("https://agent.example", started.csrfToken), store, started.csrfToken),
    ).resolves.toBeTruthy();
    await expect(
      requireAdminWrite(write("https://evil.example", started.csrfToken), store, started.csrfToken),
    ).rejects.toThrow(/来源/u);
    await expect(
      requireAdminWrite(write("https://agent.example", "wrong"), store, "wrong"),
    ).rejects.toThrow(/CSRF/u);
    await expect(requireAdminWrite(write("https://agent.example", ""), store, "")).rejects.toThrow(
      /CSRF/u,
    );
  });
});

describe("origin checks", () => {
  it("accepts matching Origin or Referer, rejects neither", () => {
    expect(sameOrigin(request())).toBe(true);
    const referer = new Request("https://agent.example/admin", {
      method: "POST",
      headers: { Referer: "https://agent.example/admin/login" },
    });
    expect(sameOrigin(referer)).toBe(true);
    expect(sameOrigin(new Request("https://agent.example/admin", { method: "POST" }))).toBe(false);
  });

  /**
   * `no-referrer` 会让浏览器把**同源**表单 POST 的 `Origin` 也降成 `null`，
   * 于是登录页的「登录」按钮在真实浏览器里必然 403（curl 手打 Origin 看不出来）。
   * 这条用例把「管理页必须是 `same-origin`」钉在响应头上。
   */
  it("serves the login page with a referrer policy that keeps same-origin POSTs checkable", async () => {
    const app = createAdminApp(
      {
        session: () => null,
        agent: () => null,
      } as unknown as AgentStore,
      {} as AgentIdentity,
      async () => {},
    );
    const response = await app.request("https://agent.example/admin/login");
    expect(response.status).toBe(200);
    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
  });
});
