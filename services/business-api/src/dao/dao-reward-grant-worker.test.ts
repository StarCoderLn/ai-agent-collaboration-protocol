import { Interface } from "ethers";
import type { QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { PoolClientLike, PoolLike } from "../db/pool";
import type { DaoCaseOperator } from "./dao-case-worker";
import {
	type DaoRewardGrantChain,
	DaoRewardGrantWorker,
} from "./dao-reward-grant-worker";

const actor = `0x${"11".repeat(20)}`;
const poolAddress = `0x${"22".repeat(20)}`;
const txHash = `0x${"33".repeat(32)}`;
const now = new Date("2026-09-08T00:00:00.000Z");
const policy = {
	campaignId: "genesis-v1",
	startsAt: new Date("2026-08-01T00:00:00.000Z"),
	endsAt: new Date("2027-01-01T00:00:00.000Z"),
	walletCapMinor: 100n * 10n ** 18n,
} as const;

describe("创世激励分配 worker", () => {
	it("从验证事实生成 5 YD 活动奖励并先保存签名再广播", async () => {
		const fake = fixture({ total: "0" });
		const result = await fake.worker.run(now);
		expect(result).toMatchObject({ status: "submitted", collected: 1, txHash });
		expect(fake.prepare).toHaveBeenCalledOnce();
		const call = fake.prepare.mock.calls[0];
		expect(call?.[0]).toBe(poolAddress);
		const decoded = new Interface([
			"function award(bytes32,address,uint256,uint8)",
		]).decodeFunctionData("award", call?.[1] ?? "0x");
		expect(decoded[1]).toBe(actor);
		expect(decoded[2]).toBe(5n * 10n ** 18n);
		expect(decoded[3]).toBe(2n);
		expect(
			fake.calls.findIndex((sql) => sql.includes("dao_reward_grant_attempts")),
		).toBeLessThan(fake.calls.indexOf("BEGIN"));
	});

	it("链上已有相同凭证时只收敛本地状态，不再次签名", async () => {
		const fake = fixture({ total: "0", awarded: true });
		await expect(fake.worker.run(now)).resolves.toMatchObject({
			status: "confirmed",
			collected: 1,
		});
		expect(fake.prepare).not.toHaveBeenCalled();
		expect(fake.broadcast).not.toHaveBeenCalled();
	});

	it("超过单钱包 100 YD 上限时留下跳过证据且不广播", async () => {
		const fake = fixture({ total: (100n * 10n ** 18n).toString(), cap: true });
		await expect(fake.worker.run(now)).resolves.toMatchObject({
			status: "idle",
			collected: 1,
		});
		expect(fake.insertParams?.[10]).toBe("skipped_wallet_cap");
		expect(fake.prepare).not.toHaveBeenCalled();
	});
});

function fixture(options: { total: string; awarded?: boolean; cap?: boolean }) {
	const calls: string[] = [];
	let insertParams: readonly unknown[] | undefined;
	const sourceId = `0x${"44".repeat(32)}`;
	const client: PoolClientLike = {
		release: vi.fn(),
		query: async <Row extends QueryResultRow = QueryResultRow>(
			sql: string,
			params: readonly unknown[],
		) => {
			const result = await queryFake(sql, params);
			// fake 按 SQL 分支返回真实行形状；泛型由生产查询调用点决定，边界处统一适配 pg 签名。
			return result as unknown as { rows: Row[]; rowCount: number | null };
		},
	};
	const queryFake = async (sql: string, params: readonly unknown[]) => {
		const normalized = sql.replaceAll(/\s+/g, " ").trim();
		calls.push(normalized);
		if (normalized.includes("pg_try_advisory_lock"))
			return rows([{ locked: true }]);
		if (normalized.startsWith("WITH deliveries AS")) {
			return rows([
				{
					program_code: "verified_user",
					fact_id: actor,
					recipient: actor,
					occurred_at: now,
				},
			]);
		}
		if (normalized.startsWith("SELECT 1 FROM dao_reward_grants"))
			return rows([]);
		if (normalized.includes("COALESCE(sum(amount_minor),0)")) {
			return rows([{ amount: options.total }]);
		}
		if (normalized.startsWith("INSERT INTO dao_reward_grants")) {
			insertParams = params;
			return { rows: [], rowCount: 1 };
		}
		if (
			normalized.includes("FROM dao_reward_grant_attempts attempt") &&
			normalized.includes("attempt.status IN")
		) {
			return rows([]);
		}
		if (
			normalized.includes("FROM dao_reward_grants reward_grant") &&
			normalized.includes("reward_grant.status='pending'")
		) {
			return options.cap
				? rows([])
				: rows([
						{
							id: "grant-1",
							source_id: sourceId,
							recipient: actor,
							reward_kind: "activity",
							amount_minor: (5n * 10n ** 18n).toString(),
							attempts: "0",
						},
					]);
		}
		if (normalized.startsWith("WITH attempt AS")) {
			return rows([
				{
					id: "attempt-1",
					grant_id: "grant-1",
					attempt_no: 1,
					tx_hash: txHash,
					raw_transaction: "0x1234",
					source_id: sourceId,
				},
			]);
		}
		return rows([]);
	};
	const prepare = vi
		.fn<DaoCaseOperator["prepareContractCall"]>()
		.mockResolvedValue({
			txHash,
			rawTransaction: "0x1234",
		});
	const broadcast = vi
		.fn<DaoCaseOperator["broadcast"]>()
		.mockResolvedValue(txHash);
	const operator: DaoCaseOperator = {
		prepareContractCall: prepare,
		broadcast,
		receipt: vi.fn().mockResolvedValue("pending"),
	};
	const chain: DaoRewardGrantChain = {
		chainId: 31337n,
		poolAddress,
		awarded: vi.fn().mockResolvedValue(options.awarded ?? false),
	};
	const pool: PoolLike = { connect: async () => client };
	return {
		worker: new DaoRewardGrantWorker(pool, chain, operator, policy),
		prepare,
		broadcast,
		calls,
		get insertParams() {
			return insertParams;
		},
	};
}

function rows<Row>(values: Row[]): { rows: Row[]; rowCount: number } {
	return { rows: values, rowCount: values.length };
}
