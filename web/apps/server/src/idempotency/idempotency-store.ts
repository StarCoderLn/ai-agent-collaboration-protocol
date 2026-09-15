/**
 * 幂等键存储（2.agent-registration T-003，跨 feature 依赖 1.agent-protocol-contract T-006）。
 *
 * 消费 [[1.agent-protocol-contract]] 定义的共享表 `idempotency_records`
 * （services/dispatch-engine/migrations/0001_idempotency_and_nonces.up.sql）。Go 与 TypeScript
 * 两端各自维护同构的 `CheckAndReserve`/`Commit` 实现（design.md 技术决策：不建物理共享包，
 * 避免跨语言构建耦合），本文件是 TS 侧的实现，语义须与
 * services/dispatch-engine/internal/protocol/idempotency.go 保持一致：
 *
 * - `Reserve`：原子地 `INSERT ... ON CONFLICT DO NOTHING`；插入成功即"占用成功"。
 *   插入失败（key 已存在）时回查当前行：`response_snapshot` 为 JSON `null` 字面量表示
 *   仍是 pending（其他并发请求占用中、尚未 Commit）；否则是已提交的历史响应快照。
 * - `Commit`：把 pending 记录的 `response_snapshot` 从 `null` 更新为真实快照，只允许对
 *   pending 记录调用一次，重复调用或对不存在的 key 调用是调用方用法错误。
 */

import type { QueryExecutor } from "../db/pool";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ResponseSnapshot {
	statusCode: number;
	body: unknown;
}

interface ReserveOutcome {
	/** true 表示本次调用新占用了这个 key，调用方应执行业务逻辑后调用 commitResponse。 */
	inserted: boolean;
	/** 仅在 inserted=false 时有意义：key 是否已提交过真实响应。 */
	committed: boolean;
	/** 仅在 committed=true 时有效。 */
	snapshot: ResponseSnapshot | null;
}

export interface IdempotencyStore {
	reserve(
		key: string,
		operationType: string,
		expiresAt: Date,
	): Promise<ReserveOutcome>;
	commitResponse(key: string, snapshot: ResponseSnapshot): Promise<void>;
}

interface IdempotencyRecordRow {
	response_snapshot: ResponseSnapshot | null;
}

export class PgIdempotencyStore implements IdempotencyStore {
	constructor(private readonly db: QueryExecutor) {}

	async reserve(
		key: string,
		operationType: string,
		expiresAt: Date,
	): Promise<ReserveOutcome> {
		const inserted = await this.db.query<{ idempotency_key: string }>(
			`INSERT INTO idempotency_records (idempotency_key, operation_type, response_snapshot, expires_at)
       VALUES ($1, $2, 'null'::jsonb, $3)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
			[key, operationType, expiresAt],
		);
		if (inserted.rows.length > 0) {
			return { inserted: true, committed: false, snapshot: null };
		}

		const existing = await this.db.query<IdempotencyRecordRow>(
			"SELECT response_snapshot FROM idempotency_records WHERE idempotency_key = $1",
			[key],
		);
		const row = existing.rows[0];
		if (!row || row.response_snapshot === null) {
			// 已存在但仍是 pending 占位（或在极小概率的竞态窗口内被清理任务回收）：
			// 按"仍被占用、尚未提交"处理，调用方不得当作全新请求重新执行业务逻辑。
			return { inserted: false, committed: false, snapshot: null };
		}
		return {
			inserted: false,
			committed: true,
			snapshot: row.response_snapshot,
		};
	}

	async commitResponse(key: string, snapshot: ResponseSnapshot): Promise<void> {
		const result = await this.db.query(
			`UPDATE idempotency_records
       SET response_snapshot = $2::jsonb
       WHERE idempotency_key = $1 AND response_snapshot = 'null'::jsonb`,
			[key, JSON.stringify(snapshot)],
		);
		if (result.rowCount === 0) {
			throw new Error(
				`IdempotencyStore.commitResponse: key "${key}" 未处于 pending 状态（未曾 reserve 或已提交过）`,
			);
		}
	}
}

export interface CheckAndReserveResult {
	/** key 命中已提交的历史响应时非 null，调用方应原样重放，不重新执行业务逻辑。 */
	existing: ResponseSnapshot | null;
	/** true 表示本次新占用了 key，调用方应执行业务逻辑后调用 commit。 */
	reserved: boolean;
}

/**
 * 幂等中间件：对外暴露 design.md 接口契约 `CheckAndReserve(key) (existing, reserved)` /
 * `Commit(key, response)`（TypeScript 侧命名为 checkAndReserve/commit）。
 */
export class Idempotency {
	constructor(
		private readonly store: IdempotencyStore,
		private readonly ttlMs: number = DEFAULT_TTL_MS,
		private readonly now: () => Date = () => new Date(),
	) {}

	async checkAndReserve(
		key: string,
		operationType: string,
	): Promise<CheckAndReserveResult> {
		if (!key) {
			throw new Error("Idempotency.checkAndReserve: key 不能为空");
		}
		if (!operationType) {
			throw new Error("Idempotency.checkAndReserve: operationType 不能为空");
		}

		const expiresAt = new Date(this.now().getTime() + this.ttlMs);
		const outcome = await this.store.reserve(key, operationType, expiresAt);
		if (outcome.inserted) {
			return { existing: null, reserved: true };
		}
		if (outcome.committed) {
			return { existing: outcome.snapshot, reserved: false };
		}
		// key 被其他并发请求占用且尚未提交（pending）：既不是全新请求，也没有历史响应可重放。
		return { existing: null, reserved: false };
	}

	async commit(key: string, snapshot: ResponseSnapshot): Promise<void> {
		if (!key) {
			throw new Error("Idempotency.commit: key 不能为空");
		}
		await this.store.commitResponse(key, snapshot);
	}
}
