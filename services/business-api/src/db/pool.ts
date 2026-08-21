/**
 * PostgreSQL 连接池工厂（2.agent-registration T-003）。
 *
 * `services/business-service` 与 `services/dispatch-engine` 共享同一个物理 PostgreSQL 实例
 * （见 services/business-service/migrations/README.md、specs/PLAN.md）。本服务（business-api）
 * 承载的是同一套业务数据的读写入口之一，复用同一个 `DATABASE_URL`，不新建独立数据库连接目标。
 */

import { Pool, type QueryResultRow } from "pg";
import { getRequiredEnv } from "../config/env.js";

/**
 * 精简的查询接口：`pg.Pool` 与 `pg.PoolClient`（事务内）都满足此接口，
 * 便于业务代码不关心是否处于事务中，也便于测试注入 fake 实现（不依赖真实数据库）。
 */
export interface QueryExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

/** `pg.Pool` 结构性满足此接口，测试可注入不依赖真实数据库连接的 fake 实现。 */
export interface PoolLike {
  connect(): Promise<PoolClientLike>;
}

export interface PoolClientLike extends QueryExecutor {
  release(): void;
}

export function createPgPool(databaseUrl: string = getRequiredEnv("DATABASE_URL")): Pool {
  return new Pool({ connectionString: databaseUrl });
}

/**
 * 在单个事务内执行 `fn`：成功则提交，抛出异常则回滚并重新抛出。
 * 创建 Agent 需要原子写入 `agents` + `agent_credentials` 两张表（design.md 模块 1/2），
 * 任一步失败都不应留下半成品档案。
 */
export async function withTransaction<T>(
  pool: PoolLike,
  fn: (client: PoolClientLike) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN", []);
    const result = await fn(client);
    await client.query("COMMIT", []);
    return result;
  } catch (err) {
    await client.query("ROLLBACK", []);
    throw err;
  } finally {
    client.release();
  }
}
