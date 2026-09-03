import { describe, expect, it, vi } from "vitest";
import { PgSessionStore } from "./session-store.js";
import type { QueryExecutor } from "../db/pool.js";

const WALLET = "0x1234567890123456789012345678901234567890";

describe("PgSessionStore", () => {
  it("create() inserts a high-entropy session_id with a 7-day expiry by default", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const db: QueryExecutor = { query };
    const now = () => new Date("2026-08-22T00:00:00.000Z");
    const store = new PgSessionStore(db, undefined, now);

    const session = await store.create(WALLET);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("INSERT INTO auth_sessions");
    expect(params).toEqual([session.sessionId, WALLET, session.expiresAt]);
    // 32 bytes hex-encoded = 64 hex chars，足够的熵防止会话 ID 被猜测。
    expect(session.sessionId).toMatch(/^[0-9a-f]{64}$/);
    expect(session.expiresAt).toEqual(new Date("2026-08-29T00:00:00.000Z"));
  });

  it("create() generates distinct session ids across calls", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const db: QueryExecutor = { query };
    const store = new PgSessionStore(db);

    const first = await store.create(WALLET);
    const second = await store.create(WALLET);

    expect(first.sessionId).not.toBe(second.sessionId);
  });

  it("findValid() returns the session when the DB row is not expired", async () => {
    const expiresAt = new Date("2026-08-23T00:00:00.000Z");
    const query = vi.fn(async () => ({
      rows: [{ session_id: "abc", wallet_address: WALLET, expires_at: expiresAt }],
      rowCount: 1,
    }));
    const db: QueryExecutor = { query: query as unknown as QueryExecutor["query"] };
    const store = new PgSessionStore(db);

    const session = await store.findValid("abc");

    expect(session).toEqual({ sessionId: "abc", walletAddress: WALLET, expiresAt });
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("expires_at > now()");
    expect(params).toEqual(["abc"]);
  });

  it("findValid() returns null when no row is found (unknown or expired session)", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const db: QueryExecutor = { query };
    const store = new PgSessionStore(db);

    const session = await store.findValid("does-not-exist");

    expect(session).toBeNull();
  });

  it("revoke() deletes only the requested opaque session id", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const db: QueryExecutor = { query };

    await new PgSessionStore(db).revoke("session-to-revoke");

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("DELETE FROM auth_sessions");
    expect(params).toEqual(["session-to-revoke"]);
  });
});
