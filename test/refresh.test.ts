import { describe, expect, it } from "vitest";
import type { AgentStore, StoredPlatform } from "../src/agent/store";
import type { Platform } from "../src/shared/types";
import { nextRefreshAt } from "../src/agent/refresh";
import { redact, safeError } from "../src/agent/redact";

function fakeStore(rows: Partial<Record<Platform, Partial<StoredPlatform>>>): AgentStore {
  return {
    platform: (platform: Platform) => {
      const row = rows[platform];
      return row
        ? ({
            platform,
            accountId: "1",
            nickname: "",
            avatarUrl: "",
            expiresAt: 0,
            status: "active",
            lastRefreshAt: 0,
            lastError: "",
            updatedAt: 0,
            ...row,
          } as StoredPlatform)
        : null;
    },
  } as unknown as AgentStore;
}

describe("refresh scheduling", () => {
  const now = 1_800_000_000;

  it("returns null when nothing is logged in", () => {
    expect(nextRefreshAt(fakeStore({}), now)).toBeNull();
    expect(nextRefreshAt(fakeStore({ qq: { status: "logged_out" } }), now)).toBeNull();
  });

  it("uses the earliest of expiry-ahead and 30 minutes", () => {
    expect(nextRefreshAt(fakeStore({ qq: { status: "active", expiresAt: now + 3600 } }), now)).toBe(
      now + 1800,
    );
    expect(nextRefreshAt(fakeStore({ qq: { status: "active", expiresAt: now + 1200 } }), now)).toBe(
      now + 600,
    );
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
