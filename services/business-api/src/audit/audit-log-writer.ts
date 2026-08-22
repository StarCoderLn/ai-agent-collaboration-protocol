/**
 * `audit_logs` 平台级共享表的写入实现（2.agent-registration T-003）。
 *
 * 表结构权威定义见 services/business-service/migrations/0001_agent_registration.up.sql
 * 「模块 1」；`before_summary`/`after_summary` 由调用方在生成 `AuditLogEntry` 时已显式排除
 * 凭证明文/密文（design.md「安全考虑」），本文件不做二次脱敏或过滤，只负责参数化落库
 * （AGENTS.md 安全规则第 15 条：查询一律参数化，禁止字符串拼接）。
 *
 * 消费方接口定义见 `../agents/agent.ts` 的 `AuditLogWriter`；本实现是目前唯一的 Postgres
 * 落地版本。`audit_logs` 是后续 feature（3/7/9/12/13/15/16）复用的平台级共享表，新增写入方
 * 时应复用本类而非另建同构实现（AGENTS.md 第 9 条：单一权威位置）。
 */

import type { QueryExecutor } from "../db/pool";
import type { AuditLogEntry, AuditLogWriter } from "../agents/agent";

export class PgAuditLogWriter implements AuditLogWriter {
  constructor(private readonly db: QueryExecutor) {}

  async write(entry: AuditLogEntry): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_logs (actor_id, actor_type, action, target_type, target_id, before_summary, after_summary)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
      [
        entry.actorId,
        entry.actorType,
        entry.action,
        entry.targetType,
        entry.targetId,
        JSON.stringify(entry.beforeSummary),
        JSON.stringify(entry.afterSummary),
      ],
    );
  }
}
