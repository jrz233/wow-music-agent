import { describe, expect, it } from "vitest";
import type { AgentStore, StoredPlatform } from "../src/agent/store";
import type { Platform } from "../src/shared/types";
import { nextRefreshAt, platformDue } from "../src/agent/refresh";
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

describe("log redaction", () => {
  it("strips cookies, tokens and signatures", () => {
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
