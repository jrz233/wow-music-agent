import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord, AgentStore, OAuthPending } from "../src/agent/store";
import type { AgentIdentity } from "../src/agent/oauth";
import { completeOAuth, normalizeServerUrl, startOAuth } from "../src/agent/oauth";

const SERVER = "https://wow.example.com";
const ENDPOINT = "https://agent.example.com";
const REDIRECT = `${ENDPOINT}/oauth/callback`;
const STATE = "state-0123456789abcdef";
const VERIFIER = "verifier-0123456789abcdefghijklmnopqrstuvwxyzABCD";
const CODE = "A".repeat(43);

const identity = {
  publicKey: "cHVibGljLWtleQ",
  publicKeyRaw: new Uint8Array(),
  privateKey: {} as CryptoKey,
  fingerprint: "fingerprint",
} as AgentIdentity;

interface FakeState {
  pending: OAuthPending | null;
  agent: AgentRecord | null;
}

function fakeStore(initial: Partial<FakeState> = {}) {
  const state: FakeState = { pending: initial.pending ?? null, agent: initial.agent ?? null };
  const store = {
    saveOAuth: async (pending: OAuthPending) => {
      state.pending = pending;
    },
    oauth: async () => state.pending,
    clearOAuth: () => {
      state.pending = null;
    },
    saveAgent: (record: AgentRecord) => {
      state.agent = record;
      state.pending = null;
    },
    agent: () => state.agent,
    clearAgent: () => {
      state.agent = null;
    },
  };
  return { store: store as unknown as AgentStore, state };
}

function pendingAt(createdAt = Math.floor(Date.now() / 1000)): OAuthPending {
  return {
    serverUrl: SERVER,
    state: STATE,
    verifier: VERIFIER,
    redirectUri: REDIRECT,
    agentName: "我的 Agent",
    createdAt,
  };
}

async function pkce(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeServerUrl", () => {
  it("accepts https and trims to the origin", () => {
    expect(normalizeServerUrl(" https://wow.example.com/ ")).toBe(SERVER);
    expect(normalizeServerUrl("https://wow.example.com:8443")).toBe(
      "https://wow.example.com:8443",
    );
    expect(normalizeServerUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("rejects plain http, paths, userinfo and parameters", () => {
    expect(() => normalizeServerUrl("http://wow.example.com")).toThrow(/https/u);
    expect(() => normalizeServerUrl("https://wow.example.com/music")).toThrow(/域名/u);
    expect(() => normalizeServerUrl("https://user:pass@wow.example.com")).toThrow(/账号/u);
    expect(() => normalizeServerUrl("https://wow.example.com/?a=1")).toThrow(/参数/u);
    expect(() => normalizeServerUrl("")).toThrow(/无效/u);
  });
});

describe("startOAuth", () => {
  it("builds an S256 authorization URL and stores the pending verifier", async () => {
    const { store, state } = fakeStore();
    const start = await startOAuth(store, identity, SERVER, ENDPOINT, "我的 Agent");

    expect(start.redirectUri).toBe(REDIRECT);
    const url = new URL(start.authorizeUrl);
    expect(url.origin).toBe(SERVER);
    expect(url.pathname).toBe("/agent/v1/oauth/authorize");
    expect(url.searchParams.get("agent_name")).toBe("我的 Agent");
    expect(url.searchParams.get("endpoint")).toBe(ENDPOINT);
    expect(url.searchParams.get("public_key")).toBe(identity.publicKey);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");

    const pending = state.pending;
    expect(pending).not.toBeNull();
    expect(pending?.serverUrl).toBe(SERVER);
    expect(pending?.state).toBe(url.searchParams.get("state"));
    expect(pending?.state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(pending?.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(url.searchParams.get("code_challenge")).toBe(await pkce(pending?.verifier ?? ""));
    // verifier 绝不能出现在浏览器会收到的地址里。
    expect(start.authorizeUrl).not.toContain(pending?.verifier ?? "x");
  });

  it("falls back to the default agent name and replaces an older pending flow", async () => {
    const { store, state } = fakeStore({ pending: pendingAt(1) });
    await startOAuth(store, identity, SERVER, ENDPOINT, "   ");
    expect(state.pending?.agentName).toBe("wow-music-agent");
    expect(state.pending?.createdAt).toBeGreaterThan(1);
  });
});

describe("completeOAuth", () => {
  it("exchanges the code and stores the binding", async () => {
    const { store, state } = fakeStore({ pending: pendingAt() });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            agentId: "agent_0123456789abcdef",
            serverPublicKey: "s".repeat(43),
            accountName: "测试账号",
            agentName: "我的 Agent",
            agentVersion: "0.1.0",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const record = await completeOAuth(store, identity, CODE, STATE, ENDPOINT);

    expect(record.agentId).toBe("agent_0123456789abcdef");
    expect(record.accountName).toBe("测试账号");
    expect(record.serverUrl).toBe(SERVER);
    expect(state.agent?.agentId).toBe(record.agentId);
    expect(state.pending).toBeNull();

    const call = calls[0];
    expect(call?.url).toBe(`${SERVER}/agent/v1/oauth/token`);
    expect(call?.init?.redirect).toBe("manual");
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      code: CODE,
      codeVerifier: VERIFIER,
      redirectUri: REDIRECT,
    });
  });

  it("rejects a mismatched state before touching the network", async () => {
    const { store, state } = fakeStore({ pending: pendingAt() });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      completeOAuth(store, identity, CODE, "another-state-0123456789", ENDPOINT),
    ).rejects.toThrow(/状态/u);
    expect(fetchMock).not.toHaveBeenCalled();
    // state 不对时保留待办：用户可能只是刷新了错误的标签页。
    expect(state.pending).not.toBeNull();
  });

  it("expires a stale pending flow", async () => {
    const { store, state } = fakeStore({ pending: pendingAt(1) });
    vi.stubGlobal("fetch", vi.fn());
    await expect(completeOAuth(store, identity, CODE, STATE, ENDPOINT)).rejects.toThrow(
      /过期/u,
    );
    expect(state.pending).toBeNull();
  });

  it("rejects a callback from another origin", async () => {
    const { store } = fakeStore({ pending: pendingAt() });
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      completeOAuth(store, identity, CODE, STATE, "https://evil.example.com"),
    ).rejects.toThrow(/回调地址/u);
  });

  it("surfaces a used or rejected code and clears the pending flow", async () => {
    const { store, state } = fakeStore({ pending: pendingAt() });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid" }), { status: 400 })),
    );
    await expect(completeOAuth(store, identity, CODE, STATE, ENDPOINT)).rejects.toThrow(
      /失效/u,
    );
    expect(state.pending).toBeNull();
  });

  it("rejects malformed binding credentials", async () => {
    const { store, state } = fakeStore({ pending: pendingAt() });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ agentId: "short", serverPublicKey: "also-short" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await expect(completeOAuth(store, identity, CODE, STATE, ENDPOINT)).rejects.toThrow(
      /无效的绑定信息/u,
    );
    expect(state.agent).toBeNull();
  });
});
