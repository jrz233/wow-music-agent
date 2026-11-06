/**
 * `AgentStore.useNonce` 的真实 SQL 行为。
 *
 * 这里用的是 `node:sqlite` 而不是内存假 store：曾经的 bug 就是**真实 SQL 语义**
 * 与假设不符——DO SQLite 的 `cursor.rowsWritten` 统计所有被写入的 B 树行，
 * `PRIMARY KEY (scope, nonce)` 的隐式索引也算一行，所以一次成功插入恒为 2。
 * 用 `rowsWritten === 1` 判断「是否首次」会让**每个首次请求都被判成重放**，
 * 表现为 Agent 永远 401、面板永远显示离线。假 store 无法暴露这一类问题。
 *
 * 只覆盖 SQL 语义这一层；签名与路由的行为见 `v1.test.ts`。
 */

import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

/** 与 `AgentStore.ensureSchema` 中 `nonces` 的定义逐字一致。 */
function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE nonces (
      scope      TEXT NOT NULL,
      nonce      TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (scope, nonce)
    );
  `);
  return db;
}

/** 与 `AgentStore.useNonce` 的实现逐字一致。 */
function useNonce(db: DatabaseSync, scope: string, nonce: string, expiresAt: number): boolean {
  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO nonces (scope, nonce, expires_at) VALUES (?, ?, ?)
       RETURNING scope`,
    )
    .all(scope, nonce, expiresAt);
  return inserted.length === 1;
}

describe("useNonce", () => {
  it("首次使用的 nonce 返回 true", () => {
    const db = openDatabase();
    expect(useNonce(db, "agent:abc", "0123456789abcdef", 1000)).toBe(true);
  });

  it("同一 nonce 第二次使用返回 false", () => {
    const db = openDatabase();
    expect(useNonce(db, "agent:abc", "0123456789abcdef", 1000)).toBe(true);
    expect(useNonce(db, "agent:abc", "0123456789abcdef", 1000)).toBe(false);
  });

  it("同一 nonce 在不同 scope 下互不影响", () => {
    const db = openDatabase();
    expect(useNonce(db, "agent:abc", "0123456789abcdef", 1000)).toBe(true);
    expect(useNonce(db, "agent:def", "0123456789abcdef", 1000)).toBe(true);
  });

  it("清理过期 nonce 后可以重新使用", () => {
    const db = openDatabase();
    expect(useNonce(db, "agent:abc", "0123456789abcdef", 500)).toBe(true);
    db.prepare("DELETE FROM nonces WHERE expires_at <= ?").run(1000);
    expect(useNonce(db, "agent:abc", "0123456789abcdef", 2000)).toBe(true);
  });

  /**
   * 钉住「插入结果」这一层的语义变动：真正插入时 `changes` 是 1、被 `IGNORE` 掉时是 0，
   * 而 `RETURNING` 的行数与之完全一致。`rowsWritten` 不能替代它们——DO SQLite 会把
   * `PRIMARY KEY (scope, nonce)` 的隐式索引也算一行，成功插入恒为 2。
   */
  it("INSERT OR IGNORE 的 changes / RETURNING 行数：插入 1、重放 0", () => {
    const db = openDatabase();

    const inserted = db
      .prepare("INSERT OR IGNORE INTO nonces (scope, nonce, expires_at) VALUES (?, ?, ?)")
      .run("agent:abc", "0123456789abcdef", 1000);
    expect(inserted.changes).toBe(1);

    const returned = db
      .prepare(
        `INSERT OR IGNORE INTO nonces (scope, nonce, expires_at) VALUES (?, ?, ?)
         RETURNING scope`,
      )
      .all("agent:abc", "0123456789abcdef", 1000);
    expect(returned).toHaveLength(0);
  });
});
