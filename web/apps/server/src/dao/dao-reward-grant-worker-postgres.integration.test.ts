import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DaoCaseOperator } from "./dao-case-worker";
import {
	type DaoRewardGrantChain,
	DaoRewardGrantWorker,
} from "./dao-reward-grant-worker";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;
const publisher = `0x${"11".repeat(20)}`;
const provider = `0x${"22".repeat(20)}`;
const arbitrator = `0x${"33".repeat(20)}`;
const cappedWallet = `0x${"44".repeat(20)}`;
const poolAddress = `0x${"55".repeat(20)}`;
const escrowAddress = `0x${"66".repeat(20)}`;
const blockHash = `0x${"77".repeat(32)}`;
const txHash = `0x${"88".repeat(32)}`;
const occurredAt = new Date("2026-09-08T00:00:00.000Z");

/**
 * 随机 schema 原样应用全部迁移，验证历史业务事实扫描使用的是当前真实列名和约束。
 * 测试只删除自己创建的 schema，不读取或改写体验库中的任何业务记录。
 */
integration("创世 YD 奖励 PostgreSQL 契约", () => {
	let admin: Pool;
	let pool: Pool;
	let schema = "";

	beforeAll(async () => {
		if (databaseUrl === undefined) throw new Error("DATABASE_URL_REQUIRED");
		admin = new Pool({ connectionString: databaseUrl });
		const database = await admin.query<{ name: string }>(
			"SELECT current_database() AS name",
		);
		const expected =
			process.env.DAO_TEST_DATABASE_NAME ?? "aicp_admission_20260906";
		if (database.rows[0]?.name !== expected)
			throw new Error("ISOLATED_DAO_DATABASE_REQUIRED");
		schema = `dao_reward_${randomUUID().replaceAll("-", "")}`;
		if (!/^dao_reward_[0-9a-f]{32}$/.test(schema))
			throw new Error("INVALID_TEST_SCHEMA");
		await admin.query(`CREATE SCHEMA "${schema}"`);
		await admin.query(`SET search_path TO "${schema}", pg_catalog`);
		const directory = new URL(
			"../../../business-service/migrations/",
			import.meta.url,
		);
		const migrations = (await readdir(directory))
			.filter((file) => /^\d{4}_.+\.up\.sql$/.test(file))
			.sort();
		for (const file of migrations)
			await admin.query(await readFile(new URL(file, directory), "utf8"));
		pool = new Pool({
			connectionString: databaseUrl,
			options: `-c search_path=${schema},pg_catalog`,
		});
	});

	afterAll(async () => {
		if (pool !== undefined) await pool.end();
		if (admin !== undefined) {
			try {
				await admin.query("ROLLBACK");
				if (schema !== "") await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
			} finally {
				await admin.end();
			}
		}
	});

	it("补发现有七类事实、保持幂等并留下 100 YD 上限证据", async () => {
		await seedFacts(pool);
		const prepare = vi
			.fn<DaoCaseOperator["prepareContractCall"]>()
			.mockResolvedValue({ txHash, rawTransaction: "0x1234" });
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
			awarded: vi.fn().mockResolvedValue(false),
		};
		const policy = {
			campaignId: "genesis-v1",
			startsAt: new Date("2026-08-01T00:00:00.000Z"),
			endsAt: new Date("2027-01-01T00:00:00.000Z"),
			walletCapMinor: 100n * 10n ** 18n,
		};
		const worker = new DaoRewardGrantWorker(pool, chain, operator, policy);

		await expect(worker.run(occurredAt)).resolves.toMatchObject({
			status: "submitted",
			collected: 7,
		});
		const grants = await pool.query<{
			program_code: string;
			recipient: string;
			amount_minor: string;
		}>(
			`SELECT program_code,recipient,amount_minor::text
			   FROM dao_reward_grants ORDER BY program_code`,
		);
		expect(grants.rows).toEqual([
			{
				program_code: "agent_admission",
				recipient: provider,
				amount_minor: yd(10),
			},
			{
				program_code: "agent_delivery",
				recipient: provider,
				amount_minor: yd(20),
			},
			{
				program_code: "agent_first_delivery",
				recipient: provider,
				amount_minor: yd(15),
			},
			{
				program_code: "arbitration_vote",
				recipient: arbitrator,
				amount_minor: yd(10),
			},
			{
				program_code: "completed_task_publisher",
				recipient: publisher,
				amount_minor: yd(15),
			},
			{
				program_code: "funded_task",
				recipient: publisher,
				amount_minor: yd(5),
			},
			{
				program_code: "verified_user",
				recipient: publisher,
				amount_minor: yd(5),
			},
		]);
		await expect(worker.run(occurredAt)).resolves.toMatchObject({
			collected: 0,
		});
		expect(prepare).toHaveBeenCalledTimes(1);

		await pool.query(
			`INSERT INTO dao_reward_grants(
			   chain_id,pool_address,campaign_id,program_code,fact_id,source_id,recipient,
			   reward_kind,amount_minor,occurred_at,status
			 ) VALUES(31337,$1,'genesis-v1','verified_user','prior-cap',$2,$3,
			   'activity',$4,$5,'confirmed')`,
			[poolAddress, `0x${"99".repeat(32)}`, cappedWallet, yd(100), occurredAt],
		);
		await pool.query(
			"INSERT INTO platform_verified_wallets(wallet_address,first_verified_at) VALUES($1,$2)",
			[cappedWallet, occurredAt],
		);
		await expect(worker.run(occurredAt)).resolves.toMatchObject({
			collected: 1,
		});
		expect(
			(
				await pool.query<{ status: string }>(
					"SELECT status FROM dao_reward_grants WHERE recipient=$1 AND fact_id=$1",
					[cappedWallet],
				)
			).rows[0]?.status,
		).toBe("skipped_wallet_cap");
	});
});

async function seedFacts(pool: Pool): Promise<void> {
	const taskId = randomUUID();
	const agentId = randomUUID();
	const distributionId = randomUUID();
	const assignmentId = randomUUID();
	const resultId = randomUUID();
	const acceptanceId = randomUUID();
	const disputeId = randomUUID();
	const roundId = randomUUID();
	await pool.query(
		"INSERT INTO platform_verified_wallets(wallet_address,first_verified_at) VALUES($1,$2)",
		[publisher, occurredAt],
	);
	await pool.query(
		`INSERT INTO tasks(
		   id,publisher_id,title,description,acceptance_criteria,deliverable_format,category_id,
		   category_version,currency,deadline,required_capability,visibility,status,status_version
		 ) VALUES($1,$2,'奖励集成测试','验证创世奖励事实扫描。','完成可验收交付',
		   '文本',$3,1,'USDC','2026-12-31T00:00:00Z','测试','private','settled',8)`,
		[taskId, publisher, "40000000-0000-4000-8000-000000000001"],
	);
	await pool.query(
		`INSERT INTO escrow_intents(task_id,chain_id,contract_address,task_key,payer_wallet,amount_minor,status)
		 VALUES($1,31337,$2,$3,$4,1000000,'confirmed')`,
		[taskId, escrowAddress, blockHash, publisher],
	);
	await pool.query(
		`INSERT INTO escrow_sync(
		   task_id,chain_id,contract_address,task_key,tx_hash,log_index,event_type,amount_minor,
		   status,block_number,block_hash,confirmations,created_at
		 ) VALUES($1,31337,$2,$3,$4,0,'Deposited',1000000,'confirmed',1,$5,20,$6)`,
		[taskId, escrowAddress, blockHash, txHash, blockHash, occurredAt],
	);
	await pool.query(
		`INSERT INTO agents(
		   id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,
		   pricing_type,price_amount,price_currency,service_endpoint,email,status
		 ) VALUES($1,$2,$2,'奖励测试 Agent',$3,'测试交付',ARRAY['test'],'fixed',1000000,
		   'USDC','http://127.0.0.1:3999/execute',$4,'active')`,
		[
			agentId,
			provider,
			"40000000-0000-4000-8000-000000000001",
			`${agentId}@example.com`,
		],
	);
	await pool.query(
		`INSERT INTO job_distribution_records(
		   id,task_id,rule_version,input_fingerprint,input_snapshot,candidates,filter_reasons,
		   final_selection_agent_id
		 ) VALUES($1,$2,'ranking-v1',$3,'{}','[]','{}',$4)`,
		[distributionId, taskId, `reward-${taskId}`, agentId],
	);
	await pool.query(
		`INSERT INTO task_assignments(
		   id,task_id,agent_id,distribution_record_id,agreed_amount_minor,status,version,
		   assigned_by,accept_by,responded_at
		 ) VALUES($1,$2,$3,$4,1000000,'accepted',2,'reward-test',$5,$5)`,
		[assignmentId, taskId, agentId, distributionId, occurredAt],
	);
	await pool.query(
		`INSERT INTO task_results(
		   id,task_id,assignment_id,submission_batch,batch_no,result_index,summary,artifact_kind,
		   body_or_file_ref,mime_type,size_bytes,generated_at
		 ) VALUES($1,$2,$3,$4,1,1,'完成交付','inline','result','text/plain',6,$5)`,
		[resultId, taskId, assignmentId, randomUUID(), occurredAt],
	);
	await pool.query(
		`INSERT INTO task_acceptances(
		   id,task_id,result_id,assignment_id,accepted_by,gross_amount_minor,platform_fee_minor,
		   agent_amount_minor,fee_rule_version,created_at
		 ) VALUES($1,$2,$3,$4,$5,1000000,4000,996000,'fee-v1',$6)`,
		[acceptanceId, taskId, resultId, assignmentId, publisher, occurredAt],
	);
	await pool.query(
		`INSERT INTO sandbox_admission_rounds(
		   agent_id,attempt_no,trigger_type,status,technical_passed,final_score,completed_at
		 ) VALUES($1,1,'initial','passed',TRUE,90,$2)`,
		[agentId, occurredAt],
	);
	await pool.query(
		`INSERT INTO disputes(
		   id,task_id,opened_by,reason,status,evidence_deadline,funds_frozen,created_at,updated_at
		 ) VALUES($1,$2,$3,'奖励测试争议','evidence_collection',$4,TRUE,$4,$4)`,
		[disputeId, taskId, publisher, occurredAt],
	);
	await pool.query(
		`INSERT INTO dao_memberships(
		   actor_id,chain_id,contract_address,staked_amount_minor,eligible,sync_tx_hash,
		   sync_block_number,synced_at
		 ) VALUES($1,31337,$2,$3,TRUE,$4,1,$5)`,
		[arbitrator, escrowAddress, yd(1_000), txHash, occurredAt],
	);
	await pool.query(
		`INSERT INTO dao_arbitration_rounds(
		   id,dispute_id,selection_seed,panel_size,quorum,voting_deadline,status,created_at
		 ) VALUES($1,$2,$3,3,2,$4,'voting',$4)`,
		[roundId, disputeId, blockHash, occurredAt],
	);
	await pool.query(
		`INSERT INTO dao_arbitration_panel_members(
		   round_id,actor_id,selection_order,selected_stake_minor,selected_at
		 ) VALUES($1,$2,1,$3,$4)`,
		[roundId, arbitrator, yd(1_000), occurredAt],
	);
	await pool.query(
		`INSERT INTO dao_arbitration_votes(
		   round_id,actor_id,decision,release_basis_points,agent_responsibility,reasoning,created_at
		 ) VALUES($1,$2,'release',10000,'agent_not_at_fault','证据支持完整释放托管资金。',$3)`,
		[roundId, arbitrator, occurredAt],
	);
}

function yd(amount: number): string {
	return (BigInt(amount) * 10n ** 18n).toString();
}
