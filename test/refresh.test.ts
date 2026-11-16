import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStore, PlatformCredentials, StoredPlatform } from "../src/agent/store";
import type { Platform } from "../src/shared/types";
import { nextRefreshAt, platformDue, refreshPlatformNow } from "../src/agent/refresh";
import { redact, safeError } from "../src/agent/redact";

function fakeStore(rows: Partial<Record<Platform, Partial<StoredPlatform>>>): AgentStore {
  return {
    platform: (platform: Platform) => {
      const row = rows[platform];
      return row ? platformRow(platform, row) : null;
    },
  } as unknown as AgentStore;
}

function platformRow(
  platform: Platform,
  overrides: Partial<StoredPlatform> = {},
): StoredPlatform {
  return {
    platform,
    accountId: "1",
    nickname: "",
    avatarUrl: "",
    expiresAt: 0,
    status: "active",
    lastRefreshAt: 0,
    lastError: "",
    updatedAt: 0,
    ...overrides,
  } as StoredPlatform;
}

describe("refresh scheduling", () => {
  const now = 1_800_000_000;

  it("returns null when nothing is logged in", () => {
    expect(nextRefreshAt(fakeStore({}), now)).toBeNull();
    expect(nextRefreshAt(fakeStore({ qq: { status: "logged_out" } }), now)).toBeNull();
  });

  it("rolls the session forward every 30 minutes", () => {
    const store = fakeStore({
      qq: { status: "active", expiresAt: now + 30 * 86400, lastRefreshAt: now - 300 },
    });
    expect(nextRefreshAt(store, now)).toBe(now + 1500);
  });

  it("refreshes early when expiry is close", () => {
    const store = fakeStore({
      qq: { status: "active", expiresAt: now + 1200, lastRefreshAt: now - 300 },
    });
    expect(nextRefreshAt(store, now)).toBe(now + 600);
  });

  it("schedules immediately when the last refresh is overdue", () => {
    const store = fakeStore({
      qq: { status: "active", expiresAt: now + 86400, lastRefreshAt: now - 3600 },
    });
    expect(nextRefreshAt(store, now)).toBe(now + 60);
  });

  it("schedules immediately for rows without a refresh timestamp", () => {
    const store = fakeStore({ qq: { status: "active", expiresAt: now + 86400 } });
    expect(nextRefreshAt(store, now)).toBe(now + 60);
  });

  it("backs off for degraded platforms and ignores logged_out", () => {
    const next = nextRefreshAt(
      fakeStore({
        qq: { status: "degraded", expiresAt: now + 600 },
        netease: { status: "logged_out", expiresAt: now + 60 },
      }),
      now,
    );
    expect(next).toBe(now + 900);
  });

  it("never returns an alarm in the past", () => {
    const next = nextRefreshAt(fakeStore({ qq: { status: "active", expiresAt: now - 100 } }), now);
    expect(next).toBe(now + 60);
  });
});

describe("platformDue", () => {
  const now = 1_800_000_000;
  const month = 30 * 86400;

  it("is due once 30 minutes have passed since the last refresh", () => {
    expect(
      platformDue(
        platformRow("qq", { status: "active", expiresAt: now + month, lastRefreshAt: now - 1800 }),
        now,
      ),
    ).toBe(true);
    expect(
      platformDue(
        platformRow("qq", { status: "active", expiresAt: now + month, lastRefreshAt: now - 1799 }),
        now,
      ),
    ).toBe(false);
  });

  it("is due within 10 minutes of expiry even after a recent refresh", () => {
    expect(
      platformDue(
        platformRow("qq", { status: "active", expiresAt: now + 599, lastRefreshAt: now - 60 }),
        now,
      ),
    ).toBe(true);
  });

  it("is due when degraded and when the refresh timestamp is missing", () => {
    expect(platformDue(platformRow("qq", { status: "degraded" }), now)).toBe(true);
    expect(
      platformDue(platformRow("qq", { status: "active", expiresAt: now + month }), now),
    ).toBe(true);
  });

  it("never treats logged out or absent platforms as due", () => {
    expect(platformDue(null, now)).toBe(false);
    expect(platformDue(platformRow("qq", { status: "logged_out" }), now)).toBe(false);
  });
});

describe("refresh pipeline", () => {
  const now = 1_800_000_000;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(routes: { match: string; body: string; delayMs?: number }[]): {
    max: number;
  } {
    const inFlight = { current: 0, max: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        inFlight.current += 1;
        inFlight.max = Math.max(inFlight.max, inFlight.current);
        try {
          for (const route of routes) {
            if (!url.includes(route.match) && !String(init?.body ?? "").includes(route.match)) {
              continue;
            }
            if (route.delayMs) {
              await new Promise((resolve) => setTimeout(resolve, route.delayMs));
            }
            return new Response(route.body, { status: 200 });
          }
          return new Response("", { status: 404 });
        } finally {
          inFlight.current -= 1;
        }
      }),
    );
    return inFlight;
  }

  /** QQ 凭据：二维码换票得到的 uin + qm_keyst，额外字段按需拼接。 */
  function qqCredential(...extra: string[]): string {
    return [
      "uin=456",
      "qm_keyst=OLD_KEY",
      "musicid=456",
      "loginType=6",
      "android_id=0011223344556677",
      "open_udid=00112233445566778899aabbccddeeff",
      "open_udid2=ffeeddccbbaa99887766554433221100",
      "imei=123456789012345",
      ...extra,
    ].join("; ");
  }

  /** 只实现刷新链路用到的方法：读凭据、落凭据、标记状态。 */
  function memoryStore(credential: string, row: Partial<StoredPlatform> = {}) {
    let current = credential;
    let status = "active";
    let lastError = "";
    let expiresAt = now + 86400;
    const plat = (): StoredPlatform => ({
      platform: "qq",
      accountId: "456",
      nickname: "昵称",
      avatarUrl: "",
      expiresAt,
      status,
      lastRefreshAt: now - 1800,
      lastError,
      updatedAt: 0,
      ...row,
    });
    const store = {
      platform: () => plat(),
      credentials: async (): Promise<{ accountId: string; credential: string }> => ({
        accountId: "456",
        credential: current,
      }),
      saveCredentials: async (_platform: Platform, credentials: PlatformCredentials) => {
        current = credentials.credential;
        status = "active";
        lastError = "";
        expiresAt = credentials.expiresAt;
      },
      invalidatePlatform: (_platform: Platform, _now: number, error: string) => {
        current = "";
        status = "logged_out";
        lastError = error;
        expiresAt = 0;
      },
      markPlatform: (
        _platform: Platform,
        _now: number,
        updates: { status?: string; lastError?: string },
      ) => {
        status = updates.status ?? status;
        lastError = updates.lastError ?? lastError;
      },
    };
    return {
      store: store as unknown as AgentStore,
      credential: () => current,
      status: () => status,
      lastError: () => lastError,
    };
  }

  it("上游明确回登录失效：清掉凭据并记下原因", async () => {
    stubFetch([{ match: "fcg_get_profile_homepage", body: JSON.stringify({ code: 1000 }) }]);
    const memory = memoryStore(qqCredential());

    const result = await refreshPlatformNow(memory.store, "qq", now);

    expect(result.state).toBe("logged_out");
    expect(result.message).toContain("1000");
    expect(memory.credential()).toBe("");
    expect(memory.status()).toBe("logged_out");
  });

  it("资料接口限流：保留凭据，只标记 degraded", async () => {
    stubFetch([
      { match: "fcg_get_profile_homepage", body: JSON.stringify({ code: 104604 }) },
    ]);
    const memory = memoryStore(qqCredential());

    const result = await refreshPlatformNow(memory.store, "qq", now);

    expect(result.state).toBe("degraded");
    expect(memory.credential()).toContain("qm_keyst=OLD_KEY");
    expect(memory.status()).toBe("degraded");
  });

  it("手动刷新会真的轮换令牌，而不是只探活", async () => {
    stubFetch([
      {
        match: "music.login.LoginServer",
        body: JSON.stringify({
          code: 0,
          req_0: {
            code: 0,
            data: { str_musicid: "456", musickey: "NEW_KEY", loginType: 6, keyExpiresIn: 259200 },
          },
        }),
      },
    ]);
    const memory = memoryStore(
      qqCredential(
        `musickeyCreateTime=${now}`,
        "keyExpiresIn=259200",
        "refresh_token=OLD_REFRESH",
        "refresh_key=OLD_REFRESH_KEY",
      ),
    );

    const result = await refreshPlatformNow(memory.store, "qq", now);

    expect(result.message).toBe("令牌已刷新");
    expect(memory.credential()).toContain("qm_keyst=NEW_KEY");
  });

  it("没有续期材料的凭据：手动刷新会提示到期后需要重新扫码", async () => {
    stubFetch([
      {
        match: "fcg_get_profile_homepage",
        body: JSON.stringify({ code: 0, data: { creator: { nick: "还能用" } } }),
      },
    ]);
    const memory = memoryStore(qqCredential());

    const result = await refreshPlatformNow(memory.store, "qq", now);

    expect(result.state).toBe("ok");
    expect(result.message).toContain("没有续期材料");
    expect(memory.credential()).toContain("qm_keyst=OLD_KEY");
    // 面板上要能提前看到「到期后没人能续」，而不是等探活回 1000。
    expect(memory.lastError()).toContain("没有续期材料");
  });

  it("续期材料被上游判失效：保留当前 key，并在面板标出到期后要重新扫码", async () => {
    stubFetch([
      {
        match: "music.login.LoginServer",
        body: JSON.stringify({ code: 0, req_0: { code: 1000, data: {} } }),
      },
      {
        match: "fcg_get_profile_homepage",
        body: JSON.stringify({ code: 0, data: { creator: { nick: "key 还有效" } } }),
      },
    ]);
    const memory = memoryStore(
      qqCredential(
        `musickeyCreateTime=${now - 86400}`,
        "keyExpiresIn=3600",
        "refresh_token=OLD_REFRESH",
        "refresh_key=OLD_REFRESH_KEY",
      ),
    );

    const result = await refreshPlatformNow(memory.store, "qq", now);

    expect(result.message).toContain("续期材料已失效");
    expect(memory.credential()).toContain("qm_keyst=OLD_KEY");
    expect(memory.status()).toBe("active");
    expect(memory.lastError()).toContain("续期材料已失效");
  });

  it("同一时刻只跑一条续期链路", async () => {
    const inFlight = stubFetch([
      {
        match: "music.login.LoginServer",
        body: JSON.stringify({
          code: 0,
          req_0: {
            code: 0,
            data: { str_musicid: "456", musickey: "NEW_KEY", loginType: 6, keyExpiresIn: 259200 },
          },
        }),
        delayMs: 5,
      },
    ]);
    const memory = memoryStore(
      qqCredential(
        `musickeyCreateTime=${now}`,
        "keyExpiresIn=259200",
        "refresh_token=OLD_REFRESH",
        "refresh_key=OLD_REFRESH_KEY",
      ),
    );

    await Promise.all([
      refreshPlatformNow(memory.store, "qq", now),
      refreshPlatformNow(memory.store, "qq", now),
    ]);

    // 一次性续期材料被两条链路同时拿去换，后到的一条会被上游判失效。
    expect(inFlight.max).toBe(1);
  });
});

describe("log redaction", () => {  it("strips cookies, tokens and signatures", () => {
    const text = redact(
      "Cookie: MUSIC_U=abc; qqmusic_key=xyz Authorization: Bearer secret access_token=abc x-wow-signature: sig",
    );
    expect(text).not.toContain("MUSIC_U=abc");
    expect(text).not.toContain("Bearer secret");
    expect(text).not.toContain("access_token=abc");
    expect(text).not.toContain("sig");
    expect(text).toContain("[redacted]");
  });

  it("removes control characters and bounds length", () => {
    const text = redact(`a\nb\tc${"x".repeat(1000)}`);
    expect(text).not.toContain("\n");
    expect(text.length).toBeLessThanOrEqual(500);
  });

  it("handles errors and arbitrary objects", () => {
    expect(safeError(new Error("boom"))).toContain("boom");
    expect(safeError({ password: "hunter2" })).not.toContain("hunter2");
  });
});
