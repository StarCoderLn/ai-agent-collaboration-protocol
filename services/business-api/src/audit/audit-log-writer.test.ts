import { describe, expect, it, vi } from "vitest";
import { PgAuditLogWriter } from "./audit-log-writer.js";
import type { QueryExecutor } from "../db/pool.js";
import type { AuditLogEntry } from "../agents/agent.js";

function makeFakeDb() {
  const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
  const db: QueryExecutor = { query };
  return { db, query };
}

const ENTRY: AuditLogEntry = {
  actorId: "0x1234567890123456789012345678901234567890",
  actorType: "provider",
  action: "agent.create",
  targetType: "agent",
  targetId: "agent-1",
  beforeSummary: {},
  afterSummary: { agentId: "agent-1", status: "pending_review" },
};

describe("PgAuditLogWriter", () => {
  it("inserts a parameterized row into audit_logs with JSON-encoded summaries", async () => {
    const { db, query } = makeFakeDb();
    const writer = new PgAuditLogWriter(db);

    await writer.write(ENTRY);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("INSERT INTO audit_logs");
    expect(sql).not.toContain(ENTRY.actorId);
    expect(params).toEqual([
      ENTRY.actorId,
      ENTRY.actorType,
      ENTRY.action,
      ENTRY.targetType,
      ENTRY.targetId,
      JSON.stringify(ENTRY.beforeSummary),
      JSON.stringify(ENTRY.afterSummary),
    ]);
  });

  it("never leaks a credential secret placed into afterSummary into anything but the parameterized value", async () => {
    const { db, query } = makeFakeDb();
    const writer = new PgAuditLogWriter(db);
    const plaintext = "must-not-leak-into-sql-text";

    await writer.write({
      ...ENTRY,
      afterSummary: { agentId: "agent-1", status: "pending_review", leakedSecret: plaintext },
    });
    // 呼应 security.md 第 15 条：即使调用方误把明文放进 afterSummary，
    // 也必须只出现在参数化值里，不能被拼接进 SQL 文本本身。
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).not.toContain(plaintext);
    expect(params).toContain(JSON.stringify({ agentId: "agent-1", status: "pending_review", leakedSecret: plaintext }));
  });
});
