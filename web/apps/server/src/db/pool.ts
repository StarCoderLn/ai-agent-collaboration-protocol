/**
 * PostgreSQL 连接池工厂（2.agent-registration T-003）。
 *
 * `services/business-service` 与 `services/dispatch-engine` 共享同一个物理 PostgreSQL 实例
 * （见 services/business-service/migrations/README.md、specs/PLAN.md）。本服务（marketplace-api）
 * 承载的是同一套业务数据的读写入口之一，复用同一个 `DATABASE_URL`，不新建独立数据库连接目标。
 */

import { Pool, type QueryResultRow } from "pg";
import { getRequiredEnv } from "../config/env";

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

export function createPgPool(
	databaseUrl: string = getRequiredEnv("DATABASE_URL"),
): Pool {
	return new Pool({ connectionString: databaseUrl });
}

let cachedSharedPool: Pool | undefined;

/**
 * 进程级单例连接池（2.agent-registration T-010）：`services/business-service` 与
 * `services/dispatch-engine` 共享同一个物理 PostgreSQL 实例，本进程内的多个仓储/
 * 幂等存储/会话存储也应共享同一个 `Pool`，不为每个依赖各自新建连接池
 * （原先各生产依赖装配模块各自维护私有缓存，见 create-agent-production-deps.ts
 * 历史实现；收敛到此处单一权威位置，避免同进程内出现多个物理连接池）。
 */
export function getSharedPgPool(databaseUrl?: string): Pool {
	if (!cachedSharedPool) {
		cachedSharedPool = createPgPool(databaseUrl);
	}
	return cachedSharedPool;
}

/**
 * 把 `pg.Pool` 适配为 `QueryExecutor`（2.agent-registration T-011 收敛）。
 *
 * `pg.Pool.query` 是重载方法，TypeScript 无法直接把它结构性匹配到 `QueryExecutor`
 * （原先 `create-agent-production-deps.ts`/`auth-production-deps.ts` 各自复制了一份
 * 同样的适配代码，收敛到此处单一权威位置，避免重复实现同一条转换规则）。
 * 仅需在直接消费共享 `Pool` 时使用；事务内的 `PoolClientLike`（`withTransaction` 回调
 * 参数）已经结构性满足 `QueryExecutor`，不需要再包一层。
 */
export function asQueryExecutor(pool: Pool): QueryExecutor {
	return {
		query: (text, params) => pool.query(text, params as unknown[]),
	};
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
