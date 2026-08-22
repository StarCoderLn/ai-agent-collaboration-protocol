import { describe, expect, it, vi } from "vitest";
import { PgNonceStore } from "./nonce-store.js";
import type { QueryExecutor } from "../db/pool.js";

function makeFakeDb(rowCount: number) {
  const query = vi.fn(async () => ({ rows: [], rowCount }));
  const db: QueryExecutor = { query };
  return { db, query };
}

describe("PgNonceStore", () => {
  it("issues a nonce with an INSERT and a short TTL expiry", async () => {
    const { db, query } = makeFakeDb(1);
    const now = () => new Date("2026-08-22T00:00:00.000Z");
    const store = new PgNonceStore(db, 5 * 60 * 1000, now);

    const record = await store.issue();

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("INSERT INTO auth_nonces");
    expect(params[0]).toBe(record.nonce);
    expect(record.nonce.length).toBeGreaterThanOrEqual(8);
    expect(record.expiresAt).toEqual(new Date("2026-08-22T00:05:00.000Z"));
  });

  it("consume() returns true when the atomic UPDATE affects a row", async () => {
    const { db, query } = makeFakeDb(1);
    const store = new PgNonceStore(db);

    const consumed = await store.consume("some-nonce");

    expect(consumed).toBe(true);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("UPDATE auth_nonces");
    expect(sql).toContain("consumed_at IS NULL");
    expect(sql).toContain("expires_at > now()");
    expect(params).toEqual(["some-nonce"]);
  });

  it("consume() returns false when no row matched (already consumed, expired, or unknown)", async () => {
    const { db } = makeFakeDb(0);
    const store = new PgNonceStore(db);

    const consumed = await store.consume("stale-nonce");

    expect(consumed).toBe(false);
  });
});
