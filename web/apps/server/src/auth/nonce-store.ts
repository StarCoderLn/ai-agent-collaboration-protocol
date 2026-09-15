/**
 * SIWE 一次性 nonce 存储（2.agent-registration T-010）。
 *
 * 权威表结构见 services/business-service/migrations/0002_auth_nonces_and_sessions.up.sql；
 * 权威设计见 specs/2.agent-registration/design.md 「模块 5」。nonce 短 TTL（5 分钟）、
 * 单次使用：`consume` 必须是原子操作（`UPDATE ... WHERE consumed_at IS NULL AND
 * expires_at > now()`），防止并发请求重放同一 nonce。
 */

import { generateNonce } from "siwe";
import type { QueryExecutor } from "../db/pool";

const DEFAULT_NONCE_TTL_MS = 5 * 60 * 1000;

export interface NonceRecord {
	nonce: string;
	expiresAt: Date;
}

export interface NonceStore {
	/** 签发一个新 nonce 并持久化。 */
	issue(): Promise<NonceRecord>;
	/**
	 * 原子消费一个 nonce：仅当该 nonce 存在、未过期且未被消费过时才成功。
	 * 返回 true 表示本次调用成功消费（调用方可继续签发会话）；false 表示
	 * nonce 不存在、已过期或已被消费过，调用方必须拒绝本次认证。
	 */
	consume(nonce: string): Promise<boolean>;
}

export class PgNonceStore implements NonceStore {
	constructor(
		private readonly db: QueryExecutor,
		private readonly ttlMs: number = DEFAULT_NONCE_TTL_MS,
		private readonly now: () => Date = () => new Date(),
	) {}

	async issue(): Promise<NonceRecord> {
		const nonce = generateNonce();
		const expiresAt = new Date(this.now().getTime() + this.ttlMs);
		await this.db.query(
			"INSERT INTO auth_nonces (nonce, expires_at) VALUES ($1, $2)",
			[nonce, expiresAt],
		);
		return { nonce, expiresAt };
	}

	async consume(nonce: string): Promise<boolean> {
		const result = await this.db.query(
			`UPDATE auth_nonces
       SET consumed_at = now()
       WHERE nonce = $1 AND consumed_at IS NULL AND expires_at > now()`,
			[nonce],
		);
		return (result.rowCount ?? 0) > 0;
	}
}
