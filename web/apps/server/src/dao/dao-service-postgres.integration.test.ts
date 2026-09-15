import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { PoolLike } from "../db/pool";
import { PgDisputeRepository } from "../disputes/dispute-repository";
import { taskKeyForTaskId } from "../escrow/escrow-chain-client";
import { EscrowExecutionWorker } from "../escrow/escrow-execution-worker";
import type { EscrowOperatorClient } from "../escrow/escrow-operator-client";
import {
	type EscrowDatabase,
	PgEscrowRepository,
} from "../escrow/escrow-repository";
import { inspectDaoEvidence } from "./dao-case-actions";
import type {
	DaoCaseChainClient,
	EvidenceTransactionStatus,
} from "./dao-case-chain-client";
import {
	type ChainCaseSnapshot,
	daoCaseInterface,
	daoCaseKey,
	evidenceContentHash,
} from "./dao-case-contract";
import { DaoCaseRecoveryService } from "./dao-case-recovery";
import { type DaoCaseOperator, DaoCaseWorker } from "./dao-case-worker";
import {
	projectChainCase,
	registerChainCase,
	retryUnsignedCaseCommand,
} from "./dao-chain-case-repository";
import type { DaoMembershipChainClient } from "./dao-chain-client";
import { createDaoRoundForDispute, DaoService } from "./dao-service";

const DATABASE_URL = process.env.DATABASE_URL;
const integration = DATABASE_URL === undefined ? describe.skip : describe;
const CATEGORY_ID = "40000000-0000-4000-8000-000000000001";
const PUBLISHER = `0x${"10".repeat(20)}`;
const CONTRACT = `0x${"20".repeat(20)}`;
const DAO = `0x${"21".repeat(20)}`;
const YD = `0x${"22".repeat(20)}`;
const NEUTRAL_MEMBERS = [
	`0x${"31".repeat(20)}`,
	`0x${"32".repeat(20)}`,
	`0x${"33".repeat(20)}`,
] as const;
const PROVIDERS = [
	`0x${"41".repeat(20)}`,
	`0x${"42".repeat(20)}`,
	`0x${"43".repeat(20)}`,
] as const;
const PAYOUTS = [
	`0x${"51".repeat(20)}`,
	`0x${"52".repeat(20)}`,
	`0x${"53".repeat(20)}`,
] as const;
const BLOCK_HASH = `0x${"71".repeat(32)}`;

/**
 * 真实 PostgreSQL 测试覆盖 DAO 最关键的跨表事务：利益相关钱包不能入组、两张同类票
 * 形成多数后只生成一份多 Agent 原子结算 outbox，且分账总额严格等于裁决释放额。
 * 外层事务最终回滚，测试不会污染用户当前的本地任务和 DAO 成员数据。
 */
integration("DAO arbitration PostgreSQL contract", () => {
	let pool: Pool;

	beforeAll(() => {
		pool = new Pool({ connectionString: requiredDatabaseUrl() });
	});

	afterAll(async () => {
		await pool.end();
	});

	it("排除任务参与方，并由两票多数生成三 Agent 部分结算", async () => {
		await withRollbackClient(pool, async (client) => {
			const fixture = await insertFixture(client);
			const round = await createDaoRoundForDispute(
				client,
				fixture.disputeId,
				fixture.taskId,
				fixture.now,
			);
			expect(round.status).toBe("voting");

			const panel = await client.query<{ actor_id: string }>(
				"SELECT actor_id FROM dao_arbitration_panel_members WHERE round_id=$1 ORDER BY selection_order",
				[round.roundId],
			);
			expect(panel.rows.map((row) => row.actor_id).sort()).toEqual(
				[...NEUTRAL_MEMBERS].sort(),
			);
			expect(panel.rows.map((row) => row.actor_id)).not.toContain(PROVIDERS[0]);

			const service = new DaoService(
				asNestedPool(client),
				client,
				unusedChain(),
				{
					minimumStakeMinor: 1_000n * 10n ** 18n,
				},
			);
			const vote = {
				decision: "partial_release" as const,
				releaseBasisPoints: 5_000,
				agentResponsibility: "shared" as const,
				reasoning: "交付已完成一半，按已确认工作量结算一半费用。",
			};
			await expect(
				service.vote(round.roundId, PROVIDERS[0], vote, fixture.now),
			).rejects.toMatchObject({ code: "DAO_VOTE_FORBIDDEN", statusCode: 403 });
			await expect(
				service.vote(
					round.roundId,
					panel.rows[0]?.actor_id ?? "",
					vote,
					fixture.now,
				),
			).resolves.toMatchObject({
				status: "voting",
				voteCount: 1,
				decision: null,
			});
			await expect(
				service.vote(
					round.roundId,
					panel.rows[0]?.actor_id ?? "",
					vote,
					fixture.now,
				),
			).rejects.toMatchObject({ code: "DAO_ALREADY_VOTED", statusCode: 409 });
			await expect(
				service.vote(
					round.roundId,
					panel.rows[1]?.actor_id ?? "",
					vote,
					fixture.now,
				),
			).resolves.toMatchObject({
				status: "decided",
				voteCount: 2,
				decision: {
					type: "partial_release",
					releaseAmountMinor: "30000000",
					refundAmountMinor: "30000000",
				},
			});

			const stored = await client.query<{
				decision_count: string;
				decision_id: string;
				action: string;
				workflow_payouts: readonly {
					grossAmountMinor: string;
					feeAmountMinor: string;
				}[];
				settlement_manifest_hash: string;
				decision_hash: string;
				evidence_root: string;
			}>(
				`SELECT (SELECT count(*)::text FROM arbitration_decisions WHERE dispute_id=$1) AS decision_count,
                decision.id::text AS decision_id,job.action,job.workflow_payouts,
                job.settlement_manifest_hash,job.decision_hash,job.evidence_root
           FROM escrow_execution_jobs job
           JOIN arbitration_decisions decision ON decision.id=job.source_ref
          WHERE job.task_id=$2 AND job.source='arbitration'`,
				[fixture.disputeId, fixture.taskId],
			);
			const job = stored.rows[0];
			expect(job).toMatchObject({
				decision_count: "1",
				action: "workflow_settle",
			});
			expect(
				job?.workflow_payouts.reduce(
					(sum, payout) => sum + BigInt(payout.grossAmountMinor),
					0n,
				),
			).toBe(30_000_000n);
			expect(job?.decision_hash).toMatch(/^0x[0-9a-f]{64}$/);
			expect(job?.evidence_root).toMatch(/^0x[0-9a-f]{64}$/);

			// 裁决写入只代表链下计划已固化。资金与争议冻结必须一直保持不变，直到同一份分账
			// 清单被 worker 广播并由链同步器确认，防止 RPC 响应丢失时把“已提交”误当“已到账”。
			const txHash = `0x${"72".repeat(32)}`;
			const operator: EscrowOperatorClient = {
				prepare: async (claimed) => {
					expect(claimed).toMatchObject({
						action: "workflow_settle",
						settlementManifestHash: job?.settlement_manifest_hash,
						evidenceRoot: job?.evidence_root,
					});
					return { txHash, rawTransaction: "0x02abcd" };
				},
				broadcast: async () => txHash,
			};
			await expect(
				new EscrowExecutionWorker(
					asNestedPool(client),
					operator,
					workerConfig(),
				).runOne(fixture.now),
			).resolves.toMatchObject({ status: "submitted", txHash });
			const totalFee =
				job?.workflow_payouts.reduce(
					(sum, payout) => sum + BigInt(payout.feeAmountMinor),
					0n,
				) ?? 0n;
			const escrow = new PgEscrowRepository(asEscrowDatabase(client));
			await escrow.observe({
				chainId: 31_337n,
				contractAddress: CONTRACT,
				taskKey: taskKeyForTaskId(fixture.taskId),
				txHash,
				logIndex: 0,
				blockNumber: 201n,
				blockHash: BLOCK_HASH,
				payload: {
					type: "WorkflowSettled",
					payer: PUBLISHER,
					escrowAmountMinor: 60_000_000n,
					totalGrossAmountMinor: 30_000_000n,
					totalFeeAmountMinor: totalFee,
					payerRefundAmountMinor: 30_000_000n,
					settlementManifestHash: job?.settlement_manifest_hash ?? "",
					evidenceRoot: job?.evidence_root ?? "",
				},
			});
			const pending = required(
				(await escrow.listPending(31_337n, CONTRACT, 10)).find(
					(event) => event.blockNumber === 201n,
				),
			);
			await expect(
				escrow.applyCanonicalConfirmation({
					eventId: pending.id,
					canonicalBlockHash: BLOCK_HASH,
					confirmations: 12n,
					now: new Date("2026-09-02T08:05:00.000Z"),
				}),
			).resolves.toBe("confirmed");
			await expect(
				client.query(
					`SELECT task.status AS task_status,dispute.status AS dispute_status,dispute.funds_frozen,
                decision.execution_status,job.status AS job_status,run.released_amount_minor::text,
                run.refundable_amount_minor::text
           FROM tasks task JOIN disputes dispute ON dispute.task_id=task.id
           JOIN arbitration_decisions decision ON decision.dispute_id=dispute.id
           JOIN escrow_execution_jobs job ON job.source_ref=decision.id
           JOIN task_workflow_runs run ON run.task_id=task.id
          WHERE task.id=$1`,
					[fixture.taskId],
				),
			).resolves.toMatchObject({
				rows: [
					{
						task_status: "settled",
						dispute_status: "executed",
						funds_frozen: false,
						execution_status: "executed",
						job_status: "executed",
						released_amount_minor: "30000000",
						refundable_amount_minor: "30000000",
					},
				],
			});
		});
	});

	it("合格且无利益冲突的成员不足三人时保留等待成组状态", async () => {
		await withRollbackClient(pool, async (client) => {
			const fixture = await insertFixture(client);
			await client.query("DELETE FROM dao_memberships WHERE actor_id=$1", [
				NEUTRAL_MEMBERS[2],
			]);

			const round = await createDaoRoundForDispute(
				client,
				fixture.disputeId,
				fixture.taskId,
				fixture.now,
			);

			expect(round.status).toBe("awaiting_panel");
			await expect(
				client.query(
					"SELECT count(*)::text AS count FROM dao_arbitration_panel_members WHERE round_id=$1",
					[round.roundId],
				),
			).resolves.toMatchObject({ rows: [{ count: "0" }] });
		});
	});

	it("两票全额退款生成带裁决与证据摘要的专用退款任务", async () => {
		await withRollbackClient(pool, async (client) => {
			const fixture = await insertFixture(client);
			const round = await createDaoRoundForDispute(
				client,
				fixture.disputeId,
				fixture.taskId,
				fixture.now,
			);
			const panel = await client.query<{ actor_id: string }>(
				"SELECT actor_id FROM dao_arbitration_panel_members WHERE round_id=$1 ORDER BY selection_order",
				[round.roundId],
			);
			const service = new DaoService(
				asNestedPool(client),
				client,
				unusedChain(),
				{
					minimumStakeMinor: 1_000n * 10n ** 18n,
				},
			);
			const vote = {
				decision: "refund" as const,
				releaseBasisPoints: 0,
				agentResponsibility: "agent_at_fault" as const,
				reasoning: "关键验收条件均未满足，应将全部托管资金退回发布者。",
			};
			await service.vote(
				round.roundId,
				panel.rows[0]?.actor_id ?? "",
				vote,
				fixture.now,
			);
			await service.vote(
				round.roundId,
				panel.rows[1]?.actor_id ?? "",
				vote,
				fixture.now,
			);

			const jobResult = await client.query<{
				action: string;
				workflow_payouts: unknown;
				decision_hash: string;
				evidence_root: string;
			}>(
				`SELECT action,workflow_payouts,decision_hash,evidence_root
           FROM escrow_execution_jobs WHERE task_id=$1 AND source='arbitration'`,
				[fixture.taskId],
			);
			const refundJob = required(jobResult.rows[0]);
			expect(refundJob).toMatchObject({
				action: "dispute_refund",
				workflow_payouts: null,
				decision_hash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
				evidence_root: expect.stringMatching(/^0x[0-9a-f]{64}$/),
			});

			const txHash = `0x${"73".repeat(32)}`;
			const operator: EscrowOperatorClient = {
				prepare: async (claimed) => {
					expect(claimed).toMatchObject({
						action: "dispute_refund",
						decisionHash: refundJob.decision_hash,
						evidenceRoot: refundJob.evidence_root,
					});
					return { txHash, rawTransaction: "0x02dcba" };
				},
				broadcast: async () => txHash,
			};
			await expect(
				new EscrowExecutionWorker(
					asNestedPool(client),
					operator,
					workerConfig(),
				).runOne(fixture.now),
			).resolves.toMatchObject({ status: "submitted", txHash });
			const escrow = new PgEscrowRepository(asEscrowDatabase(client));
			await escrow.observe({
				chainId: 31_337n,
				contractAddress: CONTRACT,
				taskKey: taskKeyForTaskId(fixture.taskId),
				txHash,
				logIndex: 0,
				blockNumber: 202n,
				blockHash: BLOCK_HASH,
				payload: {
					type: "DisputeRefunded",
					payer: PUBLISHER,
					escrowAmountMinor: 60_000_000n,
					payerRefundAmountMinor: 60_000_000n,
					decisionHash: refundJob.decision_hash,
					evidenceRoot: refundJob.evidence_root,
				},
			});
			const pending = required(
				(await escrow.listPending(31_337n, CONTRACT, 10)).find(
					(event) => event.blockNumber === 202n,
				),
			);
			await expect(
				escrow.applyCanonicalConfirmation({
					eventId: pending.id,
					canonicalBlockHash: BLOCK_HASH,
					confirmations: 12n,
					now: new Date("2026-09-02T08:06:00.000Z"),
				}),
			).resolves.toBe("confirmed");
			await expect(
				client.query(
					`SELECT task.status AS task_status,dispute.status AS dispute_status,dispute.funds_frozen,
                decision.execution_status,job.status AS job_status,intent.status AS intent_status
           FROM tasks task JOIN disputes dispute ON dispute.task_id=task.id
           JOIN arbitration_decisions decision ON decision.dispute_id=dispute.id
           JOIN escrow_execution_jobs job ON job.source_ref=decision.id
           JOIN escrow_intents intent ON intent.task_id=task.id
          WHERE task.id=$1`,
					[fixture.taskId],
				),
			).resolves.toMatchObject({
				rows: [
					{
						task_status: "refunded",
						dispute_status: "executed",
						funds_frozen: false,
						execution_status: "executed",
						job_status: "executed",
						intent_status: "refunded",
					},
				],
			});
		});
	});

	it("平台内部仲裁同样按三 Agent 冻结报价分配，而不是只支付最后一个 Agent", async () => {
		await withRollbackClient(pool, async (client) => {
			const fixture = await insertFixture(client);
			const arbitrator = `0x${"61".repeat(20)}`;
			await client.query(
				"INSERT INTO platform_actor_roles(actor_id,role,granted_by) VALUES ($1,'arbitrator','dao-integration-test')",
				[arbitrator],
			);

			const result = await new PgDisputeRepository(client).decide(
				fixture.disputeId,
				arbitrator,
				{
					type: "partial_release",
					releaseAmountMinor: 30_000_001n,
					refundAmountMinor: 29_999_999n,
					agentResponsibility: "shared",
					reason: "平台复核确认三个阶段均有部分有效交付，按总额比例结算。",
				},
				fixture.now,
			);

			expect(result.body).toMatchObject({
				decision: "partial_release",
				releaseAmountMinor: "30000001",
				refundAmountMinor: "29999999",
			});
			const stored = await client.query<{
				decision_source: string;
				action: string;
				workflow_payouts: readonly { grossAmountMinor: string }[];
			}>(
				`SELECT decision.decision_source,job.action,job.workflow_payouts
           FROM arbitration_decisions decision
           JOIN escrow_execution_jobs job
             ON job.source='arbitration' AND job.source_ref=decision.id
          WHERE decision.dispute_id=$1`,
				[fixture.disputeId],
			);
			expect(stored.rows[0]).toMatchObject({
				decision_source: "platform",
				action: "workflow_settle",
			});
			expect(stored.rows[0]?.workflow_payouts).toHaveLength(3);
			expect(
				stored.rows[0]?.workflow_payouts.reduce(
					(sum, payout) => sum + BigInt(payout.grossAmountMinor),
					0n,
				),
			).toBe(30_000_001n);
		});
	});
	it("链上首审申诉期没有付款任务，平台不能绕过，终审只生成一次结算", async () => {
		await withRollbackClient(pool, async (client) => {
			const fixture = await insertFixture(client);
			const config = { chainId: 31337n, contractAddress: DAO };
			await registerChainCase(
				client,
				fixture.disputeId,
				fixture.taskId,
				config,
			);
			const snapshot: ChainCaseSnapshot = {
				status: "appeal_window",
				taskKey: taskKeyForTaskId(fixture.taskId),
				evidenceRoot: BLOCK_HASH,
				round: 1,
				evidenceDeadline: "1788000000",
				deadline: "1789000000",
				releaseBasisPoints: 5000,
				firstReleaseBasisPoints: 5000,
				appellant: PUBLISHER,
				rewardPerVoteMinor: "10",
				appealBondMinor: "20",
				appealFeeMinor: "1",
				bondPolicy: 1,
				requestId: "42",
				candidatesHash: BLOCK_HASH,
				panel: [...NEUTRAL_MEMBERS],
				firstPanel: [...NEUTRAL_MEMBERS],
				voters: [...NEUTRAL_MEMBERS],
				voteCount: 3,
				blockNumber: "100",
				blockHash: BLOCK_HASH,
				blockTimestamp: "1788500000",
			};
			await projectChainCase(
				client,
				fixture.disputeId,
				snapshot,
				config,
				fixture.now,
			);
			expect(
				(
					await client.query(
						"SELECT 1 FROM escrow_execution_jobs WHERE task_id=$1",
						[fixture.taskId],
					)
				).rows,
			).toHaveLength(0);
			const repository = new PgDisputeRepository(client);
			await expect(
				repository.decide(
					fixture.disputeId,
					PUBLISHER,
					{
						type: "refund",
						releaseAmountMinor: 0n,
						refundAmountMinor: 60_000_000n,
						agentResponsibility: "agent_at_fault",
						reason: "尝试跳过申诉期直接退款，不应执行。",
					},
					fixture.now,
				),
			).rejects.toMatchObject({ code: "DAO_CHAIN_DECISION_REQUIRED" });
			const read = await repository.read(fixture.disputeId, NEUTRAL_MEMBERS[0]);
			expect(read.body).toMatchObject({
				viewerRole: "arbitrator",
				viewerCanPlatformDecide: false,
				chainArbitration: { status: "appeal_window" },
			});
			const final = {
				...snapshot,
				status: "final" as const,
				blockNumber: "101",
			};
			await projectChainCase(
				client,
				fixture.disputeId,
				final,
				config,
				fixture.now,
			);
			await projectChainCase(
				client,
				fixture.disputeId,
				final,
				config,
				fixture.now,
			);
			const jobs = await client.query<{
				evidence_root: string;
				workflow_payouts: { grossAmountMinor: string }[];
			}>(
				"SELECT evidence_root,workflow_payouts FROM escrow_execution_jobs WHERE task_id=$1",
				[fixture.taskId],
			);
			expect(jobs.rows).toHaveLength(1);
			expect(jobs.rows[0]?.evidence_root).toBe(BLOCK_HASH);
			expect(
				jobs.rows[0]?.workflow_payouts.reduce(
					(sum, line) => sum + BigInt(line.grossAmountMinor),
					0n,
				),
			).toBe(30_000_000n);
			expect(
				(
					await client.query("SELECT funds_frozen FROM disputes WHERE id=$1", [
						fixture.disputeId,
					])
				).rows[0]?.funds_frozen,
			).toBe(true);
			await expect(
				projectChainCase(
					client,
					fixture.disputeId,
					{ ...snapshot, blockNumber: "102" },
					config,
					fixture.now,
				),
			).rejects.toThrow("DAO_FINAL_DECISION_REORGED");
			await expect(
				projectChainCase(
					client,
					fixture.disputeId,
					{ ...snapshot, status: "none", blockNumber: "103" },
					config,
					fixture.now,
				),
			).rejects.toThrow("DAO_FINAL_DECISION_REORGED");
		});
	});

	it("开案固化混合候选阶段，后来达到社区阈值也不会替换本案创始后备", async () => {
		await withIsolatedCaseSchema(pool, async (client) => {
			const fixture = await insertFixture(client);
			const founding = testAddresses(0x600, 8);
			const firstCommunity = testAddresses(0x700, 4);
			await insertEligibleMemberships(client, founding, fixture.now);
			// 夹具已有三名中立成员和一名任务参与者；加四名后，开案时共有八名社区成员。
			await insertEligibleMemberships(client, firstCommunity, fixture.now);
			await registerChainCase(client, fixture.disputeId, fixture.taskId, {
				chainId: 31337n,
				contractAddress: DAO,
				foundingArbitrators: founding,
			});
			expect(
				(
					await client.query<{
						candidate_pool_policy: {
							phase: string;
							communityEligibleAtOpen: number;
						};
					}>(
						"SELECT candidate_pool_policy FROM dao_chain_cases WHERE dispute_id=$1",
						[fixture.disputeId],
					)
				).rows[0]?.candidate_pool_policy,
			).toMatchObject({ phase: "mixed", communityEligibleAtOpen: 8 });

			// 开案后再增加四名社区成员，使当前总数达到十二；本案仍必须沿用已固化的 mixed。
			const laterCommunity = testAddresses(0x800, 4);
			await insertEligibleMemberships(client, laterCommunity, fixture.now);
			await client.query(
				"UPDATE dao_case_commands SET status='confirmed' WHERE dispute_id=$1 AND command_key='open'",
				[fixture.disputeId],
			);
			const eligibleMembers = vi.fn(
				async (candidates: readonly string[]) => candidates,
			);
			const snapshot: ChainCaseSnapshot = {
				status: "awaiting_panel",
				taskKey: taskKeyForTaskId(fixture.taskId),
				evidenceRoot: BLOCK_HASH,
				round: 1,
				evidenceDeadline: "0",
				deadline: "0",
				releaseBasisPoints: 0,
				firstReleaseBasisPoints: 0,
				appellant: PUBLISHER,
				rewardPerVoteMinor: "10",
				appealBondMinor: "20",
				appealFeeMinor: "1",
				bondPolicy: 1,
				requestId: "0",
				candidatesHash: BLOCK_HASH,
				panel: [],
				firstPanel: [],
				voteCount: 0,
				voters: [],
				blockNumber: "100",
				blockHash: BLOCK_HASH,
				blockTimestamp: "1788500000",
			};
			const chain: DaoCaseChainClient = {
				chainId: 31337n,
				contractAddress: DAO,
				read: async () => snapshot,
				eligibleMembers,
				verifyEscrowBinding: async () => undefined,
				hasVoted: async () => false,
				paymentToken: async () => CONTRACT,
				verifyEvidence: async () => {
					throw new Error("UNEXPECTED_EVIDENCE_CALL");
				},
				inspectEvidenceTransaction: async () => {
					throw new Error("UNEXPECTED_EVIDENCE_CALL");
				},
			};
			const operator: DaoCaseOperator = {
				prepareContractCall: async () => ({
					txHash: BLOCK_HASH,
					rawTransaction: "0x02abcd",
				}),
				broadcast: async () => BLOCK_HASH,
				receipt: async () => "pending",
			};
			await expect(
				new DaoCaseWorker(asDirectPool(client), chain, operator).run(),
			).resolves.toMatchObject({ submitted: 1 });
			const command = (
				await client.query<{ calldata: string }>(
					"SELECT calldata FROM dao_case_commands WHERE dispute_id=$1 AND command_key='1:requestPanel'",
					[fixture.disputeId],
				)
			).rows[0];
			const decoded = daoCaseInterface.decodeFunctionData(
				"requestPanel",
				required(command).calldata,
			);
			const candidates = Array.from(decoded[1] as readonly string[]).map(
				(actor) => actor.toLowerCase(),
			);
			expect(candidates.filter((actor) => founding.includes(actor))).toEqual(
				founding.slice(0, 5),
			);
			expect(candidates).toEqual(
				expect.arrayContaining([
					...NEUTRAL_MEMBERS,
					...firstCommunity,
					...laterCommunity,
				]),
			);
			expect(candidates).not.toContain(PROVIDERS[0]);
		});
	});

	it("新版合约超过全案硬期限后持久化唯一恢复命令", async () => {
		await withIsolatedCaseSchema(pool, async (client) => {
			const fixture = await insertFixture(client);
			await registerChainCase(client, fixture.disputeId, fixture.taskId, {
				chainId: 31337n,
				contractAddress: DAO,
			});
			await client.query(
				"UPDATE dao_case_commands SET status='confirmed' WHERE dispute_id=$1 AND command_key='open'",
				[fixture.disputeId],
			);
			const snapshot: ChainCaseSnapshot = {
				status: "awaiting_randomness",
				taskKey: taskKeyForTaskId(fixture.taskId),
				evidenceRoot: BLOCK_HASH,
				round: 1,
				evidenceDeadline: "50",
				deadline: "0",
				releaseBasisPoints: 0,
				firstReleaseBasisPoints: 0,
				appellant: PUBLISHER,
				rewardPerVoteMinor: "10",
				appealBondMinor: "20",
				appealFeeMinor: "1",
				bondPolicy: 1,
				timeoutFallbackBasisPoints: null,
				recoveryEligibleAt: "100",
				requestId: "42",
				candidatesHash: BLOCK_HASH,
				panel: [],
				firstPanel: [],
				voteCount: 0,
				voters: [],
				blockNumber: "100",
				blockHash: BLOCK_HASH,
				blockTimestamp: "100",
			};
			const chain: DaoCaseChainClient = {
				chainId: 31337n,
				contractAddress: DAO,
				read: async () => snapshot,
				eligibleMembers: async () => [],
				verifyEscrowBinding: async () => undefined,
				hasVoted: async () => false,
				paymentToken: async () => CONTRACT,
				verifyEvidence: async () => {
					throw new Error("UNEXPECTED_EVIDENCE_CALL");
				},
				inspectEvidenceTransaction: async () => {
					throw new Error("UNEXPECTED_EVIDENCE_CALL");
				},
			};
			const operator: DaoCaseOperator = {
				prepareContractCall: async () => ({
					txHash: BLOCK_HASH,
					rawTransaction: "0x02abcd",
				}),
				broadcast: async () => BLOCK_HASH,
				receipt: async () => "pending",
			};
			await expect(
				new DaoCaseWorker(asDirectPool(client), chain, operator).run(),
			).resolves.toMatchObject({ submitted: 1 });
			const command = (
				await client.query<{ calldata: string }>(
					"SELECT calldata FROM dao_case_commands WHERE dispute_id=$1 AND command_key='1:enterRecovery'",
					[fixture.disputeId],
				)
			).rows[0];
			expect(
				daoCaseInterface.decodeFunctionData(
					"enterRecovery",
					required(command).calldata,
				)[0],
			).toBe(daoCaseKey(fixture.disputeId));
		});
	});

	it("独立真实连接并发投影 Final 只生成一份裁决与资金 outbox", async () => {
		await withIsolatedCaseSchema(pool, async (observer, first, second) => {
			const fixture = await insertFixture(observer);
			const config = { chainId: 31337n, contractAddress: DAO };
			await registerChainCase(
				observer,
				fixture.disputeId,
				fixture.taskId,
				config,
			);
			const final: ChainCaseSnapshot = {
				status: "final",
				taskKey: taskKeyForTaskId(fixture.taskId),
				evidenceRoot: BLOCK_HASH,
				round: 2,
				evidenceDeadline: "1788000000",
				deadline: "1789000000",
				releaseBasisPoints: 5000,
				firstReleaseBasisPoints: 10000,
				appellant: PUBLISHER,
				rewardPerVoteMinor: "10",
				appealBondMinor: "20",
				appealFeeMinor: "1",
				bondPolicy: 1,
				requestId: "42",
				candidatesHash: BLOCK_HASH,
				panel: [...NEUTRAL_MEMBERS],
				firstPanel: [...NEUTRAL_MEMBERS],
				voters: [...NEUTRAL_MEMBERS],
				voteCount: 3,
				blockNumber: "100",
				blockHash: BLOCK_HASH,
				blockTimestamp: "1789500000",
			};
			const firstPid = required(
				(await first.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
					.rows[0],
			).pid;
			const secondPid = required(
				(await second.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
					.rows[0],
			).pid;
			expect(firstPid).not.toBe(secondPid);
			await first.query("BEGIN");
			await second.query("BEGIN");
			// 先持有同一聚合的真实任务锁，使另一连接在投影入口等待；不是靠 Promise.all 猜测重叠。
			await first.query("SELECT id FROM tasks WHERE id=$1 FOR UPDATE", [
				fixture.taskId,
			]);
			const secondProjection = projectChainCase(
				second,
				fixture.disputeId,
				final,
				config,
				fixture.now,
			);
			// 立即观察 rejected，失败路径清理后再向测试抛出，避免悬空 rejection。
			const secondResult = secondProjection.then(
				() => null,
				(error: unknown) => error,
			);
			try {
				let blocked = false;
				for (let attempt = 0; attempt < 100; attempt++) {
					const locks = await observer.query<{ blocked: boolean }>(
						"SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked",
						[firstPid, secondPid],
					);
					if (locks.rows[0]?.blocked === true) {
						blocked = true;
						break;
					}
					await delay(10);
				}
				expect(blocked).toBe(true);
				await projectChainCase(
					first,
					fixture.disputeId,
					final,
					config,
					fixture.now,
				);
				await first.query("COMMIT");
				expect(await secondResult).toBeNull();
				await second.query("COMMIT");
			} finally {
				await first.query("ROLLBACK");
				await secondResult;
				await second.query("ROLLBACK");
			}
			const decisions = await observer.query<{
				release_amount_minor: string;
				refund_amount_minor: string;
			}>(
				"SELECT release_amount_minor::text,refund_amount_minor::text FROM arbitration_decisions WHERE dispute_id=$1",
				[fixture.disputeId],
			);
			const jobs = await observer.query<{
				workflow_payouts: { grossAmountMinor: string }[];
				status: string;
			}>(
				"SELECT workflow_payouts,status FROM escrow_execution_jobs WHERE task_id=$1 AND source='arbitration'",
				[fixture.taskId],
			);
			expect(decisions.rows).toEqual([
				{ release_amount_minor: "30000000", refund_amount_minor: "30000000" },
			]);
			expect(jobs.rows).toHaveLength(1);
			expect(jobs.rows[0]?.status).toBe("pending");
			expect(
				jobs.rows[0]?.workflow_payouts.reduce(
					(total, payout) => total + BigInt(payout.grossAmountMinor),
					0n,
				),
			).toBe(30_000_000n);
			expect(
				(
					await observer.query(
						"SELECT funds_frozen FROM disputes WHERE id=$1",
						[fixture.disputeId],
					)
				).rows,
			).toEqual([{ funds_frozen: true }]);
		});
	}, 30_000);

	it("确认旧签名回滚后保留原始尝试并以同一逻辑命令生成下一次签名", async () => {
		await withIsolatedCaseSchema(pool, async (observer) => {
			const fixture = await insertFixture(observer);
			await registerChainCase(observer, fixture.disputeId, fixture.taskId, {
				chainId: 31337n,
				contractAddress: DAO,
			});
			const firstHash = `0x${"72".repeat(32)}`;
			const secondHash = `0x${"73".repeat(32)}`;
			const snapshot: ChainCaseSnapshot = {
				status: "none",
				taskKey: BLOCK_HASH,
				evidenceRoot: BLOCK_HASH,
				round: 0,
				evidenceDeadline: "0",
				deadline: "0",
				releaseBasisPoints: 0,
				firstReleaseBasisPoints: 0,
				appellant: PUBLISHER,
				rewardPerVoteMinor: "0",
				appealBondMinor: "0",
				appealFeeMinor: "0",
				bondPolicy: 0,
				requestId: "0",
				candidatesHash: BLOCK_HASH,
				panel: [],
				firstPanel: [],
				voteCount: 0,
				voters: [],
				blockNumber: "1",
				blockHash: BLOCK_HASH,
				blockTimestamp: "100",
			};
			let receipt: "pending" | "confirmed" | "reverted" = "pending";
			let preparations = 0;
			const chain: DaoCaseChainClient = {
				chainId: 31337n,
				contractAddress: DAO,
				read: async () => snapshot,
				eligibleMembers: async () => [],
				verifyEscrowBinding: async () => undefined,
				hasVoted: async () => false,
				paymentToken: async () => CONTRACT,
				verifyEvidence: async () => {
					throw new Error("UNEXPECTED_EVIDENCE_CALL");
				},
				inspectEvidenceTransaction: async () => {
					throw new Error("UNEXPECTED_EVIDENCE_CALL");
				},
			};
			const operator: DaoCaseOperator = {
				prepareContractCall: async () => {
					preparations++;
					return preparations === 1
						? { txHash: firstHash, rawTransaction: "0x02aaaa" }
						: { txHash: secondHash, rawTransaction: "0x02bbbb" };
				},
				broadcast: async (prepared) => prepared.txHash,
				receipt: async (hash) => (hash === firstHash ? receipt : "pending"),
			};
			const directPool = asDirectPool(observer);
			const worker = new DaoCaseWorker(directPool, chain, operator);
			await expect(worker.run()).resolves.toMatchObject({ submitted: 1 });
			receipt = "reverted";
			await expect(worker.run()).resolves.toMatchObject({ submitted: 0 });

			const command = required(
				(
					await observer.query<{ id: string }>(
						"SELECT id::text FROM dao_case_commands WHERE dispute_id=$1 AND command_key='open'",
						[fixture.disputeId],
					)
				).rows[0],
			);
			const service = new DaoCaseRecoveryService(directPool, chain, operator);
			const recovery = {
				commandId: command.id,
				expectedErrorCode: "DAO_COMMAND_REVERTED",
				expectedTxHash: firstHash,
				resolutionCode: "configuration_repaired" as const,
			};
			receipt = "pending";
			await expect(service.retryReverted(recovery)).rejects.toMatchObject({
				code: "DAO_COMMAND_RECEIPT_PENDING",
			});
			receipt = "confirmed";
			await expect(service.retryReverted(recovery)).rejects.toMatchObject({
				code: "DAO_COMMAND_ALREADY_CONFIRMED",
			});
			receipt = "reverted";
			const freeze = required(
				(
					await observer.query<{ id: string }>(
						"INSERT INTO reconciliation_alerts(task_id,discrepancy_summary,operations_frozen) VALUES($1,'{}'::jsonb,TRUE) RETURNING id::text",
						[fixture.taskId],
					)
				).rows[0],
			);
			await expect(service.retryReverted(recovery)).rejects.toMatchObject({
				code: "DAO_OPERATIONS_FROZEN",
			});
			await observer.query(
				"UPDATE reconciliation_alerts SET resolved_at=now(),operations_frozen=FALSE WHERE id=$1",
				[freeze.id],
			);
			await expect(service.retryReverted(recovery)).resolves.toMatchObject({
				commandId: command.id,
				status: "pending",
				nextAttemptNo: 2,
			});
			await expect(service.retryReverted(recovery)).rejects.toMatchObject({
				code: "DAO_COMMAND_STATE_CHANGED",
			});
			expect(
				(
					await observer.query(
						"SELECT status,tx_hash,raw_transaction FROM dao_case_commands WHERE id=$1",
						[command.id],
					)
				).rows,
			).toEqual([{ status: "pending", tx_hash: null, raw_transaction: null }]);
			expect(
				(
					await observer.query(
						"SELECT attempt_no,tx_hash,raw_transaction,status FROM dao_case_command_attempts WHERE command_id=$1 ORDER BY attempt_no",
						[command.id],
					)
				).rows,
			).toEqual([
				{
					attempt_no: 1,
					tx_hash: firstHash,
					raw_transaction: "0x02aaaa",
					status: "reverted",
				},
			]);

			await expect(worker.run()).resolves.toMatchObject({ submitted: 1 });
			expect(preparations).toBe(2);
			expect(
				(
					await observer.query(
						"SELECT attempt_no,tx_hash,raw_transaction,status FROM dao_case_command_attempts WHERE command_id=$1 ORDER BY attempt_no",
						[command.id],
					)
				).rows,
			).toEqual([
				{
					attempt_no: 1,
					tx_hash: firstHash,
					raw_transaction: "0x02aaaa",
					status: "reverted",
				},
				{
					attempt_no: 2,
					tx_hash: secondHash,
					raw_transaction: "0x02bbbb",
					status: "submitted",
				},
			]);
			expect(
				(
					await observer.query(
						"SELECT count(*)::int AS count FROM audit_logs WHERE action='dao.case_command.retry_reverted' AND target_id=$1",
						[command.id],
					)
				).rows,
			).toEqual([{ count: 1 }]);
		});
	}, 30_000);

	it("只在规范最终裁决恢复时解除重组冻结并恢复被冻结的结算 outbox", async () => {
		await withIsolatedCaseSchema(pool, async (observer) => {
			const fixture = await insertFixture(observer);
			const config = { chainId: 31337n, contractAddress: DAO };
			await registerChainCase(
				observer,
				fixture.disputeId,
				fixture.taskId,
				config,
			);
			const final: ChainCaseSnapshot = {
				status: "final",
				taskKey: taskKeyForTaskId(fixture.taskId),
				evidenceRoot: BLOCK_HASH,
				round: 2,
				evidenceDeadline: "1788000000",
				deadline: "1789000000",
				releaseBasisPoints: 5000,
				firstReleaseBasisPoints: 10000,
				appellant: PUBLISHER,
				rewardPerVoteMinor: "10",
				appealBondMinor: "20",
				appealFeeMinor: "1",
				bondPolicy: 1,
				requestId: "42",
				candidatesHash: BLOCK_HASH,
				panel: [...NEUTRAL_MEMBERS],
				firstPanel: [...NEUTRAL_MEMBERS],
				voters: [...NEUTRAL_MEMBERS],
				voteCount: 3,
				blockNumber: "100",
				blockHash: BLOCK_HASH,
				blockTimestamp: "1789500000",
			};
			await projectChainCase(
				observer,
				fixture.disputeId,
				final,
				config,
				fixture.now,
			);
			const alert = required(
				(
					await observer.query<{ id: string }>(
						`INSERT INTO reconciliation_alerts(task_id,discrepancy_summary,operations_frozen)
         VALUES($1,$2::jsonb,TRUE) RETURNING id::text`,
						[
							fixture.taskId,
							JSON.stringify({
								code: "DAO_FINAL_DECISION_REORGED",
								disputeId: fixture.disputeId,
							}),
						],
					)
				).rows[0],
			);
			await observer.query(
				"UPDATE escrow_execution_jobs SET status='dead_letter',last_error_code='ESCROW_OPERATIONS_FROZEN' WHERE task_id=$1",
				[fixture.taskId],
			);
			let canonical = {
				...final,
				releaseBasisPoints: 4000,
				blockNumber: "110",
				blockHash: `0x${"74".repeat(32)}`,
			};
			const chain: DaoCaseChainClient = {
				chainId: 31337n,
				contractAddress: DAO,
				read: async () => canonical,
				eligibleMembers: async () => [],
				verifyEscrowBinding: async () => undefined,
				hasVoted: async () => false,
				paymentToken: async () => CONTRACT,
				verifyEvidence: async () => {
					throw new Error("UNEXPECTED_EVIDENCE_CALL");
				},
				inspectEvidenceTransaction: async () => {
					throw new Error("UNEXPECTED_EVIDENCE_CALL");
				},
			};
			const operator: DaoCaseOperator = {
				prepareContractCall: async () => {
					throw new Error("UNEXPECTED_PREPARE");
				},
				broadcast: async () => {
					throw new Error("UNEXPECTED_BROADCAST");
				},
				receipt: async () => {
					throw new Error("UNEXPECTED_RECEIPT");
				},
			};
			const service = new DaoCaseRecoveryService(
				asDirectPool(observer),
				chain,
				operator,
			);
			const input = {
				disputeId: fixture.disputeId,
				expectedAlertId: alert.id,
				resolutionCode: "canonical_final_restored" as const,
			};
			await expect(
				service.resolveFinalReorg(input, fixture.now),
			).rejects.toMatchObject({ code: "DAO_CANONICAL_FINAL_MISMATCH" });
			expect(
				(
					await observer.query(
						"SELECT resolved_at,operations_frozen FROM reconciliation_alerts WHERE id=$1",
						[alert.id],
					)
				).rows,
			).toEqual([{ resolved_at: null, operations_frozen: true }]);

			canonical = {
				...final,
				blockNumber: "111",
				blockHash: `0x${"75".repeat(32)}`,
			};
			await expect(
				service.resolveFinalReorg(input, fixture.now),
			).resolves.toMatchObject({
				disputeId: fixture.disputeId,
				alertId: alert.id,
				status: "resolved",
				restoredJobs: 1,
			});
			expect(
				(
					await observer.query(
						"SELECT resolved_at IS NOT NULL AS resolved,operations_frozen FROM reconciliation_alerts WHERE id=$1",
						[alert.id],
					)
				).rows,
			).toEqual([{ resolved: true, operations_frozen: false }]);
			expect(
				(
					await observer.query(
						"SELECT status,last_error_code FROM escrow_execution_jobs WHERE task_id=$1",
						[fixture.taskId],
					)
				).rows,
			).toEqual([{ status: "pending", last_error_code: null }]);
			expect(
				(
					await observer.query(
						"SELECT synced_block_number::text,synced_block_hash FROM dao_chain_cases WHERE dispute_id=$1",
						[fixture.disputeId],
					)
				).rows,
			).toEqual([
				{ synced_block_number: "111", synced_block_hash: canonical.blockHash },
			]);
			expect(
				(
					await observer.query(
						"SELECT action,after_summary FROM audit_logs WHERE target_type='reconciliation_alert' AND target_id=$1",
						[alert.id],
					)
				).rows,
			).toEqual([
				{
					action: "dao.final_reorg.resolve",
					after_summary: {
						resolutionCode: "canonical_final_restored",
						canonicalBlockHash: canonical.blockHash,
						canonicalBlockNumber: "111",
						restoredJobs: 1,
					},
				},
			]);
		});
	}, 30_000);

	it("新版证据正文不能修改或删除，重复提交锚定不能替换原交易", async () => {
		await withRollbackClient(pool, async (client) => {
			const fixture = await insertFixture(client);
			const id = randomUUID();
			const hash = evidenceContentHash({
				disputeId: fixture.disputeId,
				evidenceId: id,
				submitter: PUBLISHER,
				description: "原始提交证据",
				attachments: [],
			});
			await client.query(
				"INSERT INTO dispute_evidence(id,dispute_id,submitted_by,party,description,content_hash) VALUES ($1,$2,$3,'publisher','原始提交证据',$4)",
				[id, fixture.disputeId, PUBLISHER, hash],
			);
			await client.query("SAVEPOINT evidence_change");
			await expect(
				client.query(
					"UPDATE dispute_evidence SET description='替换正文' WHERE id=$1",
					[id],
				),
			).rejects.toThrow("COMMITTED_EVIDENCE_IS_APPEND_ONLY");
			await client.query("ROLLBACK TO SAVEPOINT evidence_change");
			await expect(
				client.query("DELETE FROM dispute_evidence WHERE id=$1", [id]),
			).rejects.toThrow("COMMITTED_EVIDENCE_IS_APPEND_ONLY");
			await client.query("ROLLBACK TO SAVEPOINT evidence_change");
			await client.query(
				"UPDATE dispute_evidence SET anchor_tx_hash=$2 WHERE id=$1",
				[id, BLOCK_HASH],
			);
			await client.query("SAVEPOINT anchor_change");
			await expect(
				client.query(
					"UPDATE dispute_evidence SET anchor_tx_hash=NULL WHERE id=$1",
					[id],
				),
			).rejects.toThrow("EVIDENCE_ANCHOR_IS_IMMUTABLE");
			await client.query("ROLLBACK TO SAVEPOINT anchor_change");
		});
	});

	it("证据交易只有规范回滚且举证期仍开放时允许用户重新签名", async () => {
		await withRollbackClient(pool, async (client) => {
			const fixture = await insertFixture(client);
			await registerChainCase(client, fixture.disputeId, fixture.taskId, {
				chainId: 31337n,
				contractAddress: DAO,
			});
			const evidenceId = randomUUID();
			const contentHash = evidenceContentHash({
				disputeId: fixture.disputeId,
				evidenceId,
				submitter: PUBLISHER,
				description: "需要链上锚定的原始证据",
				attachments: [],
			});
			await client.query(
				"INSERT INTO dispute_evidence(id,dispute_id,submitted_by,party,description,attachments,content_hash) VALUES ($1,$2,$3,'publisher','需要链上锚定的原始证据','[]'::jsonb,$4)",
				[evidenceId, fixture.disputeId, PUBLISHER, contentHash],
			);
			let transaction: EvidenceTransactionStatus = { status: "pending" };
			let blockTimestamp = "100";
			const chain: DaoCaseChainClient = {
				chainId: 31337n,
				contractAddress: DAO,
				read: async () => ({
					status: "evidence",
					taskKey: taskKeyForTaskId(fixture.taskId),
					evidenceRoot: BLOCK_HASH,
					round: 1,
					evidenceDeadline: "150",
					deadline: "0",
					releaseBasisPoints: 0,
					firstReleaseBasisPoints: 0,
					appellant: PUBLISHER,
					rewardPerVoteMinor: "0",
					appealBondMinor: "0",
					appealFeeMinor: "0",
					bondPolicy: 0,
					requestId: "0",
					candidatesHash: BLOCK_HASH,
					panel: [],
					firstPanel: [],
					voteCount: 0,
					voters: [],
					blockNumber: "1",
					blockHash: BLOCK_HASH,
					blockTimestamp,
				}),
				eligibleMembers: async () => [],
				verifyEscrowBinding: async () => undefined,
				hasVoted: async () => false,
				paymentToken: async () => CONTRACT,
				verifyEvidence: async () => {
					throw new Error("UNEXPECTED_LEGACY_EVIDENCE_CALL");
				},
				inspectEvidenceTransaction: async () => transaction,
			};
			const input = {
				action: "inspectEvidence",
				evidenceId,
				txHash: BLOCK_HASH,
			};
			await expect(
				inspectDaoEvidence(client, chain, fixture.disputeId, PUBLISHER, input),
			).resolves.toMatchObject({
				status: "pending",
				retryAllowed: false,
			});
			transaction = { status: "reverted" };
			await expect(
				inspectDaoEvidence(client, chain, fixture.disputeId, PUBLISHER, input),
			).resolves.toMatchObject({
				status: "reverted",
				retryAllowed: true,
			});
			blockTimestamp = "150";
			await expect(
				inspectDaoEvidence(client, chain, fixture.disputeId, PUBLISHER, input),
			).resolves.toMatchObject({
				status: "reverted",
				retryAllowed: false,
			});
			blockTimestamp = "100";
			transaction = { status: "confirmed", contentHash };
			await expect(
				inspectDaoEvidence(client, chain, fixture.disputeId, PUBLISHER, input),
			).resolves.toMatchObject({
				status: "anchored",
				retryAllowed: false,
			});
			expect(
				(
					await client.query(
						"SELECT anchor_tx_hash FROM dispute_evidence WHERE id=$1",
						[evidenceId],
					)
				).rows,
			).toEqual([{ anchor_tx_hash: BLOCK_HASH }]);
		});
	});

	it("广播响应丢失后新 worker 复用持久化签名，不再申请 nonce 或生成第二笔开案交易", async () => {
		await withRollbackClient(pool, async (client) => {
			const fixture = await insertFixture(client);
			await registerChainCase(client, fixture.disputeId, fixture.taskId, {
				chainId: 31337n,
				contractAddress: DAO,
			});
			const chain: DaoCaseChainClient = {
				chainId: 31337n,
				contractAddress: DAO,
				read: async () => ({
					status: "none",
					taskKey: BLOCK_HASH,
					evidenceRoot: BLOCK_HASH,
					round: 0,
					evidenceDeadline: "0",
					deadline: "0",
					releaseBasisPoints: 0,
					firstReleaseBasisPoints: 0,
					appellant: PUBLISHER,
					rewardPerVoteMinor: "0",
					appealBondMinor: "0",
					appealFeeMinor: "0",
					bondPolicy: 0,
					requestId: "0",
					candidatesHash: BLOCK_HASH,
					panel: [],
					firstPanel: [],
					voteCount: 0,
					voters: [],
					blockNumber: "1",
					blockHash: BLOCK_HASH,
					blockTimestamp: "100",
				}),
				eligibleMembers: async () => [],
				verifyEscrowBinding: async () => undefined,
				hasVoted: async () => false,
				paymentToken: async () => CONTRACT,
				verifyEvidence: async () => {
					throw new Error("UNEXPECTED_EVIDENCE_CALL");
				},
				inspectEvidenceTransaction: async () => {
					throw new Error("UNEXPECTED_EVIDENCE_CALL");
				},
			};
			let lostResponse = true;
			let receipt: "pending" | "confirmed" = "pending";
			const prepare = vi.fn(async () => ({
				txHash: BLOCK_HASH,
				rawTransaction: "0x02abcd",
			}));
			const broadcast = vi.fn(async () => {
				const persisted = await client.query(
					"SELECT tx_hash,raw_transaction FROM dao_case_commands WHERE dispute_id=$1",
					[fixture.disputeId],
				);
				expect(persisted.rows[0]).toEqual({
					tx_hash: BLOCK_HASH,
					raw_transaction: "0x02abcd",
				});
				if (lostResponse) throw new Error("RPC_RESPONSE_LOST");
				return BLOCK_HASH;
			});
			const operator: DaoCaseOperator = {
				prepareContractCall: prepare,
				broadcast,
				receipt: async () => receipt,
			};
			await new DaoCaseWorker(asNestedPool(client), chain, operator).run();
			expect(
				(
					await client.query(
						"SELECT status FROM dao_case_commands WHERE dispute_id=$1",
						[fixture.disputeId],
					)
				).rows[0]?.status,
			).toBe("prepared");
			lostResponse = false;
			await new DaoCaseWorker(asNestedPool(client), chain, operator).run();
			expect(prepare).toHaveBeenCalledTimes(1);
			expect(broadcast).toHaveBeenCalledTimes(2);
			receipt = "confirmed";
			await new DaoCaseWorker(asNestedPool(client), chain, operator).run();
			expect(
				(
					await client.query(
						"SELECT status FROM dao_case_commands WHERE dispute_id=$1",
						[fixture.disputeId],
					)
				).rows[0]?.status,
			).toBe("confirmed");
			expect(broadcast).toHaveBeenCalledTimes(2);
		});
	});

	it("另一真实连接持有案件 operator 锁时不签名广播，释放后只执行一次", async () => {
		await withRollbackClient(pool, async (client) => {
			const fixture = await caseLockFixture(client);
			const competitor = await pool.connect();
			try {
				// session advisory lock 可重入，因此竞争者必须是另一个真实连接，不能复用回滚夹具。
				const sessions = await Promise.all([
					client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"),
					competitor.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"),
				]);
				expect(sessions[0]?.rows[0]?.pid).not.toBe(sessions[1]?.rows[0]?.pid);
				await competitor.query(
					"SELECT pg_advisory_lock(hashtextextended($1,0))",
					[fixture.lockKey],
				);
				await expect(fixture.worker.run()).resolves.toMatchObject({
					submitted: 0,
				});
				expect(fixture.prepare).not.toHaveBeenCalled();
				expect(fixture.broadcast).not.toHaveBeenCalled();
				await competitor.query(
					"SELECT pg_advisory_unlock(hashtextextended($1,0))",
					[fixture.lockKey],
				);
				await expect(fixture.worker.run()).resolves.toMatchObject({
					submitted: 1,
				});
				expect(fixture.prepare).toHaveBeenCalledTimes(1);
				expect(fixture.broadcast).toHaveBeenCalledTimes(1);
			} finally {
				try {
					await competitor.query(
						"SELECT pg_advisory_unlock(hashtextextended($1,0))",
						[fixture.lockKey],
					);
				} finally {
					competitor.release(true);
				}
			}
		});
	});

	it("案件慢广播期间另一真实连接不能取得 operator 锁，完成后释放", async () => {
		await withRollbackClient(pool, async (client) => {
			const fixture = await caseLockFixture(client);
			const competitor = await pool.connect();
			let enterBroadcast: () => void = () => {};
			let finishBroadcast: () => void = () => {};
			const entered = new Promise<void>((resolve) => {
				enterBroadcast = resolve;
			});
			const finish = new Promise<void>((resolve) => {
				finishBroadcast = resolve;
			});
			fixture.broadcast.mockImplementation(async () => {
				// 本测试验证锁覆盖保存签名与广播窗口；外层回滚不代表签名已对另一连接提交可见。
				const stored = await client.query(
					"SELECT status,tx_hash,raw_transaction FROM dao_case_commands WHERE dispute_id=$1",
					[fixture.disputeId],
				);
				expect(stored.rows[0]).toEqual({
					status: "prepared",
					tx_hash: BLOCK_HASH,
					raw_transaction: "0x02abcd",
				});
				enterBroadcast();
				await finish;
				return BLOCK_HASH;
			});
			const running = fixture.worker.run();
			try {
				// 若 worker 在进入广播之前结束或报错，立即失败，避免测试因等待屏障而悬挂。
				await Promise.race([
					entered,
					running.then(() => {
						throw new Error("EXPECTED_PENDING_BROADCAST");
					}),
				]);
				const held = await competitor.query<{ locked: boolean }>(
					"SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
					[fixture.lockKey],
				);
				expect(held.rows[0]?.locked).toBe(false);
				finishBroadcast();
				await expect(running).resolves.toMatchObject({ submitted: 1 });
				const released = await competitor.query<{ locked: boolean }>(
					"SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
					[fixture.lockKey],
				);
				expect(released.rows[0]?.locked).toBe(true);
				expect(fixture.prepare).toHaveBeenCalledTimes(1);
				expect(fixture.broadcast).toHaveBeenCalledTimes(1);
			} finally {
				finishBroadcast();
				try {
					await running;
				} finally {
					try {
						await competitor.query("SELECT pg_advisory_unlock_all()");
					} finally {
						competitor.release();
					}
				}
			}
		});
	});

	it("本轮链快照读取失败时不签名或广播已有命令，恢复读取后才继续", async () => {
		await withRollbackClient(pool, async (client) => {
			const fixture = await insertFixture(client);
			await registerChainCase(client, fixture.disputeId, fixture.taskId, {
				chainId: 31337n,
				contractAddress: DAO,
			});
			const prepare = vi.fn(async () => ({
				txHash: BLOCK_HASH,
				rawTransaction: "0x02abcd",
			}));
			const broadcast = vi.fn(async () => BLOCK_HASH);
			let unavailable = true;
			const chain: DaoCaseChainClient = {
				chainId: 31337n,
				contractAddress: DAO,
				read: async () => {
					if (unavailable) throw new Error("DAO_CASE_BLOCK_REORGED");
					return {
						status: "none",
						taskKey: BLOCK_HASH,
						evidenceRoot: BLOCK_HASH,
						round: 0,
						evidenceDeadline: "0",
						deadline: "0",
						releaseBasisPoints: 0,
						firstReleaseBasisPoints: 0,
						appellant: PUBLISHER,
						rewardPerVoteMinor: "0",
						appealBondMinor: "0",
						appealFeeMinor: "0",
						bondPolicy: 0,
						requestId: "0",
						candidatesHash: BLOCK_HASH,
						panel: [],
						firstPanel: [],
						voteCount: 0,
						voters: [],
						blockNumber: "1",
						blockHash: BLOCK_HASH,
						blockTimestamp: "100",
					};
				},
				eligibleMembers: async () => [],
				verifyEscrowBinding: async () => undefined,
				hasVoted: async () => false,
				paymentToken: async () => CONTRACT,
				verifyEvidence: async () => {
					throw new Error("UNEXPECTED_EVIDENCE_CALL");
				},
				inspectEvidenceTransaction: async () => {
					throw new Error("UNEXPECTED_EVIDENCE_CALL");
				},
			};
			const operator: DaoCaseOperator = {
				prepareContractCall: prepare,
				broadcast,
				receipt: async () => "pending",
			};
			expect(
				await new DaoCaseWorker(asNestedPool(client), chain, operator).run(),
			).toMatchObject({ failed: 1, submitted: 0 });
			expect(prepare).not.toHaveBeenCalled();
			expect(broadcast).not.toHaveBeenCalled();
			unavailable = false;
			expect(
				await new DaoCaseWorker(asNestedPool(client), chain, operator).run(),
			).toMatchObject({ failed: 0, submitted: 1 });
			expect(prepare).toHaveBeenCalledTimes(1);
			await client.query(
				"INSERT INTO reconciliation_alerts(task_id,discrepancy_summary,operations_frozen) VALUES ($1,$2::jsonb,TRUE)",
				[
					fixture.taskId,
					JSON.stringify({ code: "DAO_FINAL_DECISION_REORGED" }),
				],
			);
			// 已恢复正常 RPC 不能解除持久冻结，且冻结时不重播占用该 nonce 的原始交易。
			expect(
				await new DaoCaseWorker(asNestedPool(client), chain, operator).run(),
			).toMatchObject({ failed: 0, submitted: 0 });
			expect(prepare).toHaveBeenCalledTimes(1);
			expect(broadcast).toHaveBeenCalledTimes(1);
			await client.query(
				"UPDATE reconciliation_alerts SET resolved_at=now() WHERE task_id=$1",
				[fixture.taskId],
			);
			expect(
				await new DaoCaseWorker(asNestedPool(client), chain, operator).run(),
			).toMatchObject({ submitted: 1 });
			expect(prepare).toHaveBeenCalledTimes(1);
			expect(broadcast).toHaveBeenCalledTimes(2);
		});
	});

	it("运营只可重试状态未变化且尚未签名的失败命令，并保留审计证据", async () => {
		await withRollbackClient(pool, async (client) => {
			const fixture = await insertFixture(client);
			await registerChainCase(client, fixture.disputeId, fixture.taskId, {
				chainId: 31337n,
				contractAddress: DAO,
			});
			const command = (
				await client.query<{ id: string }>(
					"SELECT id::text FROM dao_case_commands WHERE dispute_id=$1 AND command_key='open'",
					[fixture.disputeId],
				)
			).rows[0];
			expect(command).toBeDefined();
			await client.query(
				"UPDATE dao_case_commands SET status='failed',error_code='DAO_PREPARE_FAILED' WHERE id=$1",
				[command?.id],
			);

			await expect(
				retryUnsignedCaseCommand(client, {
					commandId: command?.id ?? "",
					expectedErrorCode: "DAO_PREPARE_FAILED",
					resolutionCode: "rpc_recovered",
				}),
			).resolves.toMatchObject({
				disputeId: fixture.disputeId,
				commandKey: "open",
				status: "pending",
			});
			expect(
				(
					await client.query(
						"SELECT status,error_code,tx_hash,raw_transaction FROM dao_case_commands WHERE id=$1",
						[command?.id],
					)
				).rows[0],
			).toEqual({
				status: "pending",
				error_code: null,
				tx_hash: null,
				raw_transaction: null,
			});
			expect(
				(
					await client.query(
						"SELECT actor_id,actor_type,action,before_summary,after_summary FROM audit_logs WHERE target_type='dao_case_command' AND target_id=$1",
						[command?.id],
					)
				).rows[0],
			).toMatchObject({
				actor_id: "dao-operations",
				actor_type: "system",
				action: "dao.case_command.retry",
				before_summary: { errorCode: "DAO_PREPARE_FAILED", status: "failed" },
				after_summary: { status: "pending", resolutionCode: "rpc_recovered" },
			});

			await client.query(
				"UPDATE dao_case_commands SET status='failed',error_code='DAO_COMMAND_REVERTED',tx_hash=$2,raw_transaction='0x02abcd' WHERE id=$1",
				[command?.id, BLOCK_HASH],
			);
			await expect(
				retryUnsignedCaseCommand(client, {
					commandId: command?.id ?? "",
					expectedErrorCode: "DAO_COMMAND_REVERTED",
					resolutionCode: "configuration_repaired",
				}),
			).rejects.toMatchObject({ code: "DAO_SIGNED_COMMAND_RETRY_FORBIDDEN" });
			expect(
				(
					await client.query(
						"SELECT tx_hash,raw_transaction FROM dao_case_commands WHERE id=$1",
						[command?.id],
					)
				).rows[0],
			).toEqual({ tx_hash: BLOCK_HASH, raw_transaction: "0x02abcd" });

			await client.query(
				"UPDATE dao_case_commands SET error_code='DAO_PREPARE_FAILED',tx_hash=NULL,raw_transaction=NULL WHERE id=$1",
				[command?.id],
			);
			await client.query(
				"INSERT INTO reconciliation_alerts(task_id,discrepancy_summary,operations_frozen) VALUES ($1,$2::jsonb,TRUE)",
				[
					fixture.taskId,
					JSON.stringify({ code: "DAO_FINAL_DECISION_REORGED" }),
				],
			);
			await expect(
				retryUnsignedCaseCommand(client, {
					commandId: command?.id ?? "",
					expectedErrorCode: "DAO_PREPARE_FAILED",
					resolutionCode: "rpc_recovered",
				}),
			).rejects.toMatchObject({ code: "DAO_OPERATIONS_FROZEN" });
			await client.query(
				"UPDATE reconciliation_alerts SET resolved_at=now() WHERE task_id=$1",
				[fixture.taskId],
			);
			await client.query(
				"UPDATE dao_chain_cases SET status='evidence' WHERE dispute_id=$1",
				[fixture.disputeId],
			);
			await expect(
				retryUnsignedCaseCommand(client, {
					commandId: command?.id ?? "",
					expectedErrorCode: "DAO_PREPARE_FAILED",
					resolutionCode: "rpc_recovered",
				}),
			).rejects.toMatchObject({ code: "DAO_COMMAND_NO_LONGER_APPLICABLE" });
			expect(
				(
					await client.query(
						"SELECT count(*)::text AS count FROM audit_logs WHERE target_type='dao_case_command' AND target_id=$1",
						[command?.id],
					)
				).rows[0],
			).toEqual({ count: "1" });
		});
	});

	it.each(["unsigned", "pending", "confirmed", "reverted"] as const)(
		"候选失败案件的 %s 交易不会错误越过或永久阻塞其他 nonce",
		async (blockedReceipt) => {
			await withRollbackClient(pool, async (client) => {
				const blocked = await insertFixture(client);
				const recovering = await insertFixture(client);
				for (const fixture of [blocked, recovering]) {
					await registerChainCase(client, fixture.disputeId, fixture.taskId, {
						chainId: 31337n,
						contractAddress: DAO,
					});
				}
				const priorHash = `0x${"72".repeat(32)}`;
				await client.query(
					"UPDATE dao_case_commands SET created_at='2000-01-01T00:00:00Z' WHERE dispute_id=$1",
					[blocked.disputeId],
				);
				if (blockedReceipt !== "unsigned") {
					const blockedCommand = required(
						(
							await client.query<{ id: string }>(
								"UPDATE dao_case_commands SET status='submitted',tx_hash=$2,raw_transaction='0x02cdef' WHERE dispute_id=$1 RETURNING id::text",
								[blocked.disputeId, priorHash],
							)
						).rows[0],
					);
					await client.query(
						"INSERT INTO dao_case_command_attempts(command_id,attempt_no,raw_transaction,tx_hash,status) VALUES($1,1,'0x02cdef',$2,'submitted')",
						[blockedCommand.id, priorHash],
					);
				}
				const recoveringCommand = required(
					(
						await client.query<{ id: string }>(
							"UPDATE dao_case_commands SET status='prepared',tx_hash=$2,raw_transaction='0x02abcd' WHERE dispute_id=$1 RETURNING id::text",
							[recovering.disputeId, BLOCK_HASH],
						)
					).rows[0],
				);
				await client.query(
					"INSERT INTO dao_case_command_attempts(command_id,attempt_no,raw_transaction,tx_hash,status) VALUES($1,1,'0x02abcd',$2,'prepared')",
					[recoveringCommand.id, BLOCK_HASH],
				);
				const blockedKey = (
					await client.query<{ case_key: string }>(
						"SELECT case_key FROM dao_chain_cases WHERE dispute_id=$1",
						[blocked.disputeId],
					)
				).rows[0]?.case_key;
				const chain: DaoCaseChainClient = {
					chainId: 31337n,
					contractAddress: DAO,
					read: async (key) => ({
						status: key === blockedKey ? "awaiting_panel" : "none",
						taskKey: taskKeyForTaskId(
							key === blockedKey ? blocked.taskId : recovering.taskId,
						),
						evidenceRoot: BLOCK_HASH,
						round: 1,
						evidenceDeadline: "0",
						deadline: "0",
						releaseBasisPoints: 0,
						firstReleaseBasisPoints: 0,
						appellant: PUBLISHER,
						rewardPerVoteMinor: "0",
						appealBondMinor: "0",
						appealFeeMinor: "0",
						bondPolicy: 0,
						requestId: "0",
						candidatesHash: BLOCK_HASH,
						panel: [],
						firstPanel: [],
						voteCount: 0,
						voters: [],
						blockNumber: "1",
						blockHash: BLOCK_HASH,
						blockTimestamp: "100",
					}),
					eligibleMembers: async () => {
						throw new Error("DAO_CANDIDATE_LIMIT_EXCEEDED");
					},
					verifyEscrowBinding: async () => undefined,
					hasVoted: async () => false,
					paymentToken: async () => CONTRACT,
					verifyEvidence: async () => {
						throw new Error("UNEXPECTED_EVIDENCE_CALL");
					},
					inspectEvidenceTransaction: async () => {
						throw new Error("UNEXPECTED_EVIDENCE_CALL");
					},
				};
				const prepare = vi.fn(async () => ({
					txHash: BLOCK_HASH,
					rawTransaction: "0x02abcd",
				}));
				const broadcast = vi.fn(async () => BLOCK_HASH);
				const operator: DaoCaseOperator = {
					prepareContractCall: prepare,
					broadcast,
					receipt: async (hash) =>
						hash === priorHash && blockedReceipt !== "unsigned"
							? blockedReceipt
							: "pending",
				};
				expect(
					await new DaoCaseWorker(asNestedPool(client), chain, operator).run(),
				).toMatchObject({
					failed: 1,
					submitted: blockedReceipt === "pending" ? 0 : 1,
				});
				expect(prepare).not.toHaveBeenCalled();
				if (blockedReceipt === "pending")
					expect(broadcast).not.toHaveBeenCalled();
				else
					expect(broadcast).toHaveBeenCalledWith({
						txHash: BLOCK_HASH,
						rawTransaction: "0x02abcd",
					});
				expect(
					(
						await client.query(
							"SELECT status,tx_hash FROM dao_case_commands WHERE dispute_id=$1",
							[blocked.disputeId],
						)
					).rows[0],
				).toEqual({
					status:
						blockedReceipt === "unsigned"
							? "pending"
							: blockedReceipt === "pending"
								? "submitted"
								: blockedReceipt === "reverted"
									? "failed"
									: "confirmed",
					tx_hash: blockedReceipt === "unsigned" ? null : priorHash,
				});
			});
		},
	);
});

async function insertFixture(client: PoolClient) {
	const taskId = randomUUID();
	const runId = randomUUID();
	const disputeId = randomUUID();
	const now = new Date("2026-09-02T08:00:00.000Z");
	await client.query(
		`INSERT INTO tasks(
       id,publisher_id,title,description,acceptance_criteria,deliverable_format,category_id,
       category_version,currency,deadline,required_capability,visibility,status,status_version
     ) VALUES ($1,$2,'DAO 多 Agent 仲裁集成测试','验证利益冲突排除和原子分账。',
       '多数裁决只能生成一份守恒的资金计划','链上摘要与多 Agent 分账',$3,1,'USDC',
       '2026-12-31T00:00:00Z','需求、设计与开发','private','disputed',8)`,
		[taskId, PUBLISHER, CATEGORY_ID],
	);
	await client.query(
		`INSERT INTO task_workflow_runs(
       id,task_id,status,version,currency,total_budget_minor,quoted_total_minor,
       quote_confirmed_at,released_amount_minor,refundable_amount_minor
     ) VALUES ($1,$2,'disputed',4,'USDC',60000000,60000000,$3,0,60000000)`,
		[runId, taskId, now],
	);
	await client.query(
		`INSERT INTO escrow_intents(task_id,chain_id,contract_address,task_key,payer_wallet,amount_minor,status)
     VALUES ($1,31337,$2,$3,$4,60000000,'confirmed')`,
		[taskId, CONTRACT, taskKeyForTaskId(taskId), PUBLISHER],
	);
	await client.query(
		`INSERT INTO disputes(
       id,task_id,opened_by,reason,status,evidence_deadline,funds_frozen,created_at,updated_at
     ) VALUES ($1,$2,$3,'最终实现未完全满足验收标准','evidence_collection',$4,TRUE,$5,$5)`,
		[disputeId, taskId, PUBLISHER, new Date("2026-09-05T08:00:00.000Z"), now],
	);
	await client.query(
		`INSERT INTO dispute_evidence(id,dispute_id,submitted_by,party,description,attachments,created_at)
     VALUES ($1,$2,$3,'publisher','页面与设计稿存在明显偏差','[]'::jsonb,$4)`,
		[randomUUID(), disputeId, PUBLISHER, now],
	);

	const amounts = [20_000_000, 30_000_000, 10_000_000] as const;
	const kinds = ["requirements", "design", "coding"] as const;
	for (const [index, amount] of amounts.entries()) {
		const agentId = randomUUID();
		const nodeId = randomUUID();
		const distributionId = randomUUID();
		await client.query(
			`INSERT INTO agents(
         id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,
         pricing_type,price_amount,price_currency,service_endpoint,email,status
       ) VALUES ($1,$2,$3,$4,$5,'生成可验收的阶段产物',ARRAY['dao-test'],'fixed',$6,'USDC',
         'http://127.0.0.1:3999/execute',$7,'active')`,
			[
				agentId,
				PROVIDERS[index],
				PAYOUTS[index],
				`DAO 测试 Agent ${index + 1}`,
				CATEGORY_ID,
				amount,
				`dao-${agentId}@example.com`,
			],
		);
		await client.query(
			`INSERT INTO task_workflow_nodes(
         id,workflow_run_id,task_id,node_key,kind,title,description,category_id,tags,
         required_capability,input_contract,output_contract,budget_cap_minor,position_index,status,
         version
       ) VALUES ($1,$2,$3,$4,$4,$5,'DAO 仲裁资金测试',$6,ARRAY[$4],$5,'Input','Output',$7,$8,
         'disputed',3)`,
			[
				nodeId,
				runId,
				taskId,
				kinds[index],
				`阶段 ${index + 1}`,
				CATEGORY_ID,
				amount,
				index,
			],
		);
		await client.query(
			`INSERT INTO job_distribution_records(
         id,task_id,workflow_node_id,rule_version,input_fingerprint,input_snapshot,candidates,
         filter_reasons,final_selection_agent_id
       ) VALUES ($1,$2,$3,'ranking-v1',$4,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb,$5)`,
			[distributionId, taskId, nodeId, `dao-${randomUUID()}`, agentId],
		);
		await client.query(
			`UPDATE task_workflow_nodes
          SET selected_agent_id=$2,selection_record_id=$3,agreed_amount_minor=$4
        WHERE id=$1`,
			[nodeId, agentId, distributionId, amount],
		);
		await client.query(
			`INSERT INTO task_assignments(
         id,task_id,workflow_node_id,agent_id,distribution_record_id,agreed_amount_minor,status,
         version,assigned_by,accept_by,responded_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'accepted',2,'dao-integration-test',
         now()+interval '1 hour',now())`,
			[randomUUID(), taskId, nodeId, agentId, distributionId, amount],
		);
	}

	// 故意把第一个 Agent 提供者也登记为合格 DAO 成员，验证分案不是只按质押筛选，
	// 还会根据任务关系排除 provider 与 payout 钱包。
	for (const actor of [...NEUTRAL_MEMBERS, PROVIDERS[0]]) {
		await client.query(
			`INSERT INTO dao_memberships(
         actor_id,chain_id,contract_address,staked_amount_minor,eligible,exit_available_at,
         sync_tx_hash,sync_block_number,synced_at
       ) VALUES ($1,31337,$2,$3,TRUE,NULL,$4,100,$5) ON CONFLICT (actor_id) DO NOTHING`,
			[
				actor,
				DAO,
				(1_000n * 10n ** 18n).toString(),
				`0x${randomUUID().replaceAll("-", "").repeat(2)}`,
				now,
			],
		);
	}
	return { taskId, runId, disputeId, now };
}

function testAddresses(start: number, count: number): string[] {
	return Array.from(
		{ length: count },
		(_, index) => `0x${(start + index).toString(16).padStart(40, "0")}`,
	);
}

async function insertEligibleMemberships(
	client: PoolClient,
	actors: readonly string[],
	now: Date,
): Promise<void> {
	for (const actor of actors) {
		await client.query(
			`INSERT INTO dao_memberships(
         actor_id,chain_id,contract_address,staked_amount_minor,eligible,exit_available_at,
         sync_tx_hash,sync_block_number,synced_at
       ) VALUES ($1,31337,$2,$3,TRUE,NULL,$4,100,$5) ON CONFLICT (actor_id) DO NOTHING`,
			[
				actor,
				DAO,
				(1_000n * 10n ** 18n).toString(),
				`0x${randomUUID().replaceAll("-", "").repeat(2)}`,
				now,
			],
		);
	}
}

/**
 * 并发事务需要双方可见的已提交夹具，不能复用单连接 SAVEPOINT。仅在指定隔离库创建
 * 随机 schema，并原样应用权威 migration 保留全部 FK/触发器；search_path 无 public
 * 回退。清理仅删除本函数确实创建的 schema，不接触数据库或其他 schema 的业务记录。
 */
async function withIsolatedCaseSchema(
	pool: Pool,
	test: (
		observer: PoolClient,
		first: PoolClient,
		second: PoolClient,
	) => Promise<void>,
): Promise<void> {
	const observer = await pool.connect();
	const schema = `dao_final_${randomUUID().replaceAll("-", "")}`;
	let created = false;
	const clients: PoolClient[] = [];
	try {
		const database = await observer.query<{ name: string }>(
			"SELECT current_database() AS name",
		);
		// 默认仅允许本次隔离验收库；其他测试环境必须单独声明库名，不能从连接 URL 自动放行。
		const expectedDatabase =
			process.env.DAO_TEST_DATABASE_NAME ?? "aicp_admission_20260906";
		if (database.rows[0]?.name !== expectedDatabase)
			throw new Error("ISOLATED_DAO_DATABASE_REQUIRED");
		if (!/^dao_final_[0-9a-f]{32}$/.test(schema))
			throw new Error("INVALID_TEST_SCHEMA");
		await observer.query(`CREATE SCHEMA "${schema}"`);
		created = true;
		await observer.query(`SET search_path TO "${schema}", pg_catalog`);
		const directory = new URL(
			"../../../business-service/migrations/",
			import.meta.url,
		);
		const migrations = (await readdir(directory))
			.filter((file) => /^\d{4}_.+\.up\.sql$/.test(file))
			.sort();
		for (const file of migrations)
			await observer.query(await readFile(new URL(file, directory), "utf8"));
		// 缺表不得悄悄引用公共结构；从 PostgreSQL 元数据验证所有测试表外键仍在本 schema 内。
		const foreignKeys = await observer.query<{ escaped: string }>(
			`SELECT count(*)::text AS escaped FROM pg_constraint constraint_row
       JOIN pg_class local_table ON local_table.oid=constraint_row.conrelid
       JOIN pg_namespace local_schema ON local_schema.oid=local_table.relnamespace
       JOIN pg_class target_table ON target_table.oid=constraint_row.confrelid
       WHERE constraint_row.contype='f' AND local_schema.nspname=$1 AND target_table.relnamespace<>local_table.relnamespace`,
			[schema],
		);
		expect(foreignKeys.rows[0]?.escaped).toBe("0");
		const first = await pool.connect();
		clients.push(first);
		const second = await pool.connect();
		clients.push(second);
		for (const client of clients) {
			await client.query(`SET search_path TO "${schema}", pg_catalog`);
			await client.query("SET statement_timeout TO '10s'");
		}
		await test(observer, first, second);
	} finally {
		// 先关闭竞争连接，保证异常事务和锁不会阻塞 schema 清理；destroy 不归还带自定义路径的连接。
		for (const client of clients) client.release(true);
		try {
			await observer.query("ROLLBACK");
			if (created) await observer.query(`DROP SCHEMA "${schema}" CASCADE`);
		} finally {
			observer.release(true);
		}
	}
}

/** 链调用全部隔离；只有 PostgreSQL 锁竞争使用两个真实 session，业务夹具最终统一回滚。 */
async function caseLockFixture(client: PoolClient) {
	const fixture = await insertFixture(client);
	await registerChainCase(client, fixture.disputeId, fixture.taskId, {
		chainId: 31337n,
		contractAddress: DAO,
	});
	const chain: DaoCaseChainClient = {
		chainId: 31337n,
		contractAddress: DAO,
		read: async () => ({
			status: "none",
			taskKey: BLOCK_HASH,
			evidenceRoot: BLOCK_HASH,
			round: 0,
			evidenceDeadline: "0",
			deadline: "0",
			releaseBasisPoints: 0,
			firstReleaseBasisPoints: 0,
			appellant: PUBLISHER,
			rewardPerVoteMinor: "0",
			appealBondMinor: "0",
			appealFeeMinor: "0",
			bondPolicy: 0,
			requestId: "0",
			candidatesHash: BLOCK_HASH,
			panel: [],
			firstPanel: [],
			voteCount: 0,
			voters: [],
			blockNumber: "1",
			blockHash: BLOCK_HASH,
			blockTimestamp: "100",
		}),
		eligibleMembers: async () => [],
		verifyEscrowBinding: async () => undefined,
		hasVoted: async () => false,
		paymentToken: async () => CONTRACT,
		verifyEvidence: async () => {
			throw new Error("UNEXPECTED_EVIDENCE_CALL");
		},
		inspectEvidenceTransaction: async () => {
			throw new Error("UNEXPECTED_EVIDENCE_CALL");
		},
	};
	const prepare = vi.fn(async () => ({
		txHash: BLOCK_HASH,
		rawTransaction: "0x02abcd",
	}));
	const broadcast = vi.fn(async () => BLOCK_HASH);
	const operator: DaoCaseOperator = {
		prepareContractCall: prepare,
		broadcast,
		receipt: async () => "pending",
	};
	return {
		disputeId: fixture.disputeId,
		lockKey: "aicp:dao-case-operator:31337",
		prepare,
		broadcast,
		worker: new DaoCaseWorker(asNestedPool(client), chain, operator),
	};
}

/** 把 DaoService 的内部事务映射为 SAVEPOINT，使整个夹具仍可由外层事务统一回滚。 */
function asNestedPool(client: PoolClient): PoolLike {
	return {
		connect: async () => ({
			query: async (text, params) => {
				if (text === "BEGIN")
					return client.query("SAVEPOINT dao_service_nested");
				if (text === "COMMIT")
					return client.query("RELEASE SAVEPOINT dao_service_nested");
				if (text === "ROLLBACK") {
					await client.query("ROLLBACK TO SAVEPOINT dao_service_nested");
					return client.query("RELEASE SAVEPOINT dao_service_nested");
				}
				return client.query(text, [...params]);
			},
			release: () => undefined,
		}),
	};
}

/** 随机 schema 的 observer 使用自动提交；恢复服务需要在同一连接上开启真实短事务。 */
function asDirectPool(client: PoolClient): PoolLike {
	return {
		connect: async () => ({
			query: (text, params) => client.query(text, [...params]),
			release: () => undefined,
		}),
	};
}

function unusedChain(): DaoMembershipChainClient {
	return {
		chainId: 31_337n,
		contractAddress: DAO,
		ydTokenAddress: YD,
		verifyMembershipTransaction: async () => {
			throw new Error("本用例不应调用链上成员同步");
		},
	};
}

function workerConfig() {
	return { leaseMs: 60_000, maxAttempts: 3, baseRetryMs: 1_000 } as const;
}

/**
 * PgEscrowRepository 会自行开启事务；测试已在外层事务中，因此把内部事务映射为保存点，
 * 既验证真实确认逻辑，也确保用例结束后能一次回滚全部链下状态。
 */
function asEscrowDatabase(client: PoolClient): EscrowDatabase {
	const nested = asNestedPool(client);
	return {
		query: (text, params) => client.query(text, [...params]),
		connect: nested.connect,
	};
}

async function withRollbackClient(
	pool: Pool,
	test: (client: PoolClient) => Promise<void>,
): Promise<void> {
	const client = await pool.connect();
	await client.query("BEGIN");
	try {
		await test(client);
	} finally {
		await client.query("ROLLBACK");
		client.release();
	}
}

function requiredDatabaseUrl(): string {
	if (DATABASE_URL === undefined) throw new Error("DATABASE_URL_REQUIRED");
	return DATABASE_URL;
}

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("EXPECTED_VALUE");
	return value;
}
