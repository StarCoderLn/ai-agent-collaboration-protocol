import { randomBytes, randomUUID } from "node:crypto";

import { getAddress, solidityPackedKeccak256 } from "ethers";
import { z } from "zod";

import { PgAuditLogWriter } from "../audit/audit-log-writer";
import type { PoolLike, QueryExecutor } from "../db/pool";
import { withTransaction } from "../db/pool";
import {
	ArbitrationSettlementError,
	buildArbitrationSettlementPlan,
	loadArbitrationSettlementContext,
} from "../disputes/arbitration-settlement";
import { emitTaskEvent } from "../tasks/task-event-repository";
import {
	createCandidatePoolSnapshot,
	normalizeFoundingArbitrators,
} from "./dao-candidate-pool";
import { hasDaoCaseSchema } from "./dao-case-schema";
import type {
	DaoMembershipChainClient,
	DaoMembershipSnapshot,
} from "./dao-chain-client";

const transactionHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const voteSchema = z
	.object({
		decision: z.enum(["release", "partial_release", "refund"]),
		releaseBasisPoints: z.number().int().min(0).max(10_000),
		agentResponsibility: z.enum([
			"agent_at_fault",
			"agent_not_at_fault",
			"shared",
			"not_determined",
		]),
		reasoning: z.string().trim().min(10).max(5_000),
	})
	.strict()
	.superRefine((value, context) => {
		const valid =
			value.decision === "release"
				? value.releaseBasisPoints === 10_000
				: value.decision === "refund"
					? value.releaseBasisPoints === 0
					: value.releaseBasisPoints > 0 && value.releaseBasisPoints < 10_000;
		if (!valid)
			context.addIssue({
				code: "custom",
				path: ["releaseBasisPoints"],
				message: "裁决类型与结算比例不一致",
			});
	});

type DaoDecision = z.infer<typeof voteSchema>["decision"];
type AgentResponsibility = z.infer<typeof voteSchema>["agentResponsibility"];

export class DaoServiceError extends Error {
	/**
	 * 业务错误同时携带 HTTP 状态与稳定错误码。HTTP 层只能映射这些结构化信息，不能根据
	 * 中文消息猜测错误类型，否则前端重试和协议兼容会被易变文案绑死。
	 */
	constructor(
		readonly statusCode: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

/**
 * DAO 服务把链上成员资格与链下隐私仲裁封装成一个业务边界。调用方只提交交易哈希或
 * 投票意图；服务内部负责回执核验、利益冲突排除、法定人数和原子资金 outbox。
 */
export class DaoService {
	constructor(
		private readonly pool: PoolLike,
		private readonly db: QueryExecutor,
		private readonly chain: DaoMembershipChainClient,
		private readonly config: Readonly<{
			minimumStakeMinor: bigint;
			foundingArbitrators?: readonly string[];
		}>,
	) {
		if (config.minimumStakeMinor <= 0n)
			throw new Error("INVALID_DAO_SERVICE_CONFIG");
	}

	async overview(actorId: string): Promise<Readonly<Record<string, unknown>>> {
		const actor = normalizeAddress(actorId);
		const chainSchemaAvailable = await hasDaoCaseSchema(this.db);
		const [membership, cases, chainCases, candidatePool] = await Promise.all([
			this.db.query<MembershipRow>(
				`SELECT actor_id,staked_amount_minor::text,eligible,exit_available_at,sync_tx_hash,
                sync_block_number::text,synced_at
           FROM dao_memberships WHERE actor_id=$1`,
				[actor],
			),
			this.db.query<CaseRow>(
				`SELECT round.id::text AS round_id,round.dispute_id::text,dispute.task_id::text,
                task.title,round.status,round.quorum,round.panel_size,round.voting_deadline,
                EXISTS(SELECT 1 FROM dao_arbitration_votes vote
                  WHERE vote.round_id=round.id AND vote.actor_id=$1) AS has_voted,
                (SELECT count(*)::text FROM dao_arbitration_votes vote
                  WHERE vote.round_id=round.id) AS vote_count
           FROM dao_arbitration_panel_members panel
           JOIN dao_arbitration_rounds round ON round.id=panel.round_id
           JOIN disputes dispute ON dispute.id=round.dispute_id
           JOIN tasks task ON task.id=dispute.task_id
          WHERE panel.actor_id=$1
          ORDER BY CASE round.status WHEN 'voting' THEN 0 WHEN 'awaiting_panel' THEN 1 ELSE 2 END,
                   round.created_at DESC`,
				[actor],
			),
			chainSchemaAvailable
				? this.db.query<{
						dispute_id: string;
						task_id: string;
						title: string;
						status: string;
						snapshot: unknown;
					}>(
						`SELECT chain.dispute_id::text,dispute.task_id::text,task.title,chain.status,chain.snapshot
         FROM dao_chain_cases chain JOIN disputes dispute ON dispute.id=chain.dispute_id JOIN tasks task ON task.id=dispute.task_id
         WHERE chain.snapshot->'panel' ? $1 OR chain.snapshot->'firstPanel' ? $1 ORDER BY chain.updated_at DESC`,
						[actor],
					)
				: Promise.resolve({ rows: [] }),
			this.candidatePoolOverview(),
		]);
		return {
			chainId: this.chain.chainId.toString(),
			contractAddress: this.chain.contractAddress,
			ydTokenAddress: this.chain.ydTokenAddress,
			minimumStakeMinor: this.config.minimumStakeMinor.toString(),
			membership:
				membership.rows[0] === undefined
					? null
					: serializeMembership(membership.rows[0]),
			cases: cases.rows.map(serializeCase),
			chainCases: chainCases.rows.map((row) => ({
				disputeId: row.dispute_id,
				taskId: row.task_id,
				taskTitle: row.title,
				status: row.status,
			})),
			candidatePool,
		};
	}

	/**
	 * 页面展示的是数据库最近同步的候选池容量，不把它冒充链上实时资格；worker 在真正
	 * 请求 VRF 前仍会固定确认区块逐一复核。这里用于公开启动期与社区交接进度。
	 */
	async candidatePoolOverview(): Promise<Readonly<Record<string, unknown>>> {
		const founding = normalizeFoundingArbitrators(
			this.config.foundingArbitrators ?? [],
		);
		const eligible = (
			await this.db.query<{ actor_id: string }>(
				"SELECT actor_id FROM dao_memberships WHERE chain_id=$1 AND eligible=TRUE AND exit_available_at IS NULL ORDER BY actor_id",
				[this.chain.chainId.toString()],
			)
		).rows.map((row) => row.actor_id);
		const snapshot = createCandidatePoolSnapshot(founding, eligible);
		const foundingSet = new Set(snapshot.foundingArbitrators);
		return {
			phase: snapshot.phase,
			foundingConfiguredCount: snapshot.foundingArbitrators.length,
			foundingEligibleCount: new Set(
				eligible.filter((actor) => foundingSet.has(actor)),
			).size,
			communityEligibleCount: snapshot.communityEligibleAtOpen,
			mixedThreshold: snapshot.mixedThreshold,
			handoffThreshold: snapshot.handoffThreshold,
			selection: "chainlink_vrf",
			measuredFrom: "confirmed_membership_sync",
		} as const;
	}

	async syncMembership(
		actorId: string,
		raw: unknown,
		now: Date,
	): Promise<Readonly<Record<string, unknown>>> {
		const parsed = transactionHashSchema.safeParse(
			typeof raw === "object" && raw !== null && "txHash" in raw
				? raw.txHash
				: undefined,
		);
		if (!parsed.success)
			throw new DaoServiceError(
				422,
				"VALIDATION_FAILED",
				"会员交易哈希格式无效",
			);
		// 浏览器只上报交易哈希，资格、质押额和退出状态必须由服务端在对应回执区块重建。
		// 这条可信边界防止用户通过篡改请求体伪造 DAO 成员资格。
		let snapshot: DaoMembershipSnapshot;
		try {
			snapshot = await this.chain.verifyMembershipTransaction(
				parsed.data,
				actorId,
			);
		} catch (error) {
			throw chainError(error);
		}
		if (snapshot.minimumStakeMinor !== this.config.minimumStakeMinor) {
			throw new DaoServiceError(
				409,
				"DAO_STAKE_CONFIG_MISMATCH",
				"链上最低质押额与平台配置不一致",
			);
		}
		return withTransaction(this.pool, async (client) => {
			const stored = await upsertMembership(client, snapshot, now);
			// 新成员同步成功后立即尝试补齐尚未成组的案件。少于三名无冲突成员时案件保留
			// awaiting_panel，后续任一合格成员同步都可重试，不会丢失争议。
			await assignAwaitingPanels(client, now);
			await new PgAuditLogWriter(client).write({
				actorId: snapshot.actorId,
				actorType: "publisher",
				action: "dao.membership.sync",
				targetType: "dao_membership",
				targetId: snapshot.actorId,
				beforeSummary: {},
				afterSummary: {
					action: snapshot.action,
					eligible: snapshot.eligible,
					stakedAmountMinor: snapshot.stakedAmountMinor.toString(),
					syncTxHash: snapshot.syncTxHash,
					syncBlockNumber: snapshot.syncBlockNumber.toString(),
				},
			});
			return {
				chainId: this.chain.chainId.toString(),
				contractAddress: this.chain.contractAddress,
				ydTokenAddress: this.chain.ydTokenAddress,
				minimumStakeMinor: snapshot.minimumStakeMinor.toString(),
				membership: serializeMembership(stored),
			};
		});
	}

	async vote(
		roundId: string,
		actorId: string,
		raw: unknown,
		now: Date,
	): Promise<Readonly<Record<string, unknown>>> {
		if (!z.uuid().safeParse(roundId).success)
			throw new DaoServiceError(404, "DAO_CASE_NOT_FOUND", "仲裁案件不存在");
		const parsed = voteSchema.safeParse(raw);
		if (!parsed.success)
			throw new DaoServiceError(
				422,
				"VALIDATION_FAILED",
				"投票字段不完整或结算比例不合法",
			);
		const actor = normalizeAddress(actorId);
		// 锁定 round 后再写票和统计多数，确保两个并发的“最后一票”最多形成一份裁决。
		return withTransaction(this.pool, async (client) => {
			const roundResult = await client.query<LockedRoundRow>(
				`SELECT round.id::text AS round_id,round.dispute_id::text,dispute.task_id::text,
                round.status,round.quorum,round.panel_size,round.voting_deadline
           FROM dao_arbitration_rounds round
           JOIN disputes dispute ON dispute.id=round.dispute_id
          WHERE round.id=$1 FOR UPDATE OF round,dispute`,
				[roundId],
			);
			const round = roundResult.rows[0];
			if (round === undefined)
				throw new DaoServiceError(404, "DAO_CASE_NOT_FOUND", "仲裁案件不存在");
			if (round.status !== "voting")
				throw new DaoServiceError(
					409,
					"DAO_CASE_NOT_VOTING",
					"案件当前不能投票",
				);
			if (now > round.voting_deadline)
				throw new DaoServiceError(
					409,
					"DAO_VOTING_CLOSED",
					"案件投票期限已结束",
				);
			const panel = await client.query(
				"SELECT 1 FROM dao_arbitration_panel_members WHERE round_id=$1 AND actor_id=$2",
				[roundId, actor],
			);
			if (panel.rows[0] === undefined)
				throw new DaoServiceError(
					403,
					"DAO_VOTE_FORBIDDEN",
					"当前钱包不在本案仲裁小组中",
				);
			const voteId = randomUUID();
			try {
				await client.query(
					`INSERT INTO dao_arbitration_votes(
             id,round_id,actor_id,decision,release_basis_points,agent_responsibility,reasoning,created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
					[
						voteId,
						roundId,
						actor,
						parsed.data.decision,
						parsed.data.releaseBasisPoints,
						parsed.data.agentResponsibility,
						parsed.data.reasoning,
						now,
					],
				);
			} catch (error) {
				if (databaseCode(error) === "23505")
					throw new DaoServiceError(
						409,
						"DAO_ALREADY_VOTED",
						"当前钱包已经提交过本案投票",
					);
				throw error;
			}
			const votes = await client.query<VoteRow>(
				`SELECT id::text,actor_id,decision,release_basis_points,agent_responsibility,reasoning,created_at
           FROM dao_arbitration_votes WHERE round_id=$1 ORDER BY created_at,id`,
				[roundId],
			);
			const outcome = resolveOutcome(votes.rows, round.quorum);
			if (outcome === null) {
				return {
					roundId,
					status: "voting",
					voteCount: votes.rows.length,
					quorum: round.quorum,
					decision: null,
				};
			}
			let decision: Readonly<Record<string, unknown>>;
			try {
				decision = await finalizeDaoDecision(
					client,
					round,
					outcome,
					votes.rows,
					now,
				);
			} catch (error) {
				if (error instanceof ArbitrationSettlementError) {
					throw new DaoServiceError(409, error.code, error.message);
				}
				throw error;
			}
			return {
				roundId,
				status: "decided",
				voteCount: votes.rows.length,
				quorum: round.quorum,
				decision,
			};
		});
	}
}

/**
 * 创建争议时同步建立 DAO 案件。分案与争议写入共用事务，确保资金已冻结却找不到案件
 * 的非法组合不可出现；成员不足不是事务失败，而是可恢复的 awaiting_panel 状态。
 */
export async function createDaoRoundForDispute(
	db: QueryExecutor,
	disputeId: string,
	taskId: string,
	now: Date,
): Promise<{ roundId: string; status: "awaiting_panel" | "voting" }> {
	const config = await readDaoConfig(db);
	const roundId = randomUUID();
	const selectionSeed = `0x${randomBytes(32).toString("hex")}`;
	await db.query(
		`INSERT INTO dao_arbitration_rounds(
       id,dispute_id,selection_seed,panel_size,quorum,voting_deadline,status,created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,'awaiting_panel',$7)
     ON CONFLICT (dispute_id) DO NOTHING`,
		[
			roundId,
			disputeId,
			selectionSeed,
			config.panelSize,
			config.quorum,
			new Date(now.getTime() + config.votingWindowMs),
			now,
		],
	);
	const assigned = await assignRound(db, disputeId, taskId, now);
	return assigned;
}

async function upsertMembership(
	db: QueryExecutor,
	snapshot: DaoMembershipSnapshot,
	now: Date,
): Promise<MembershipRow> {
	// 只允许更高或相同区块覆盖缓存，避免延迟到达的旧交易把已退出成员重新标记为有效。
	// WHERE 未命中时 PostgreSQL 不返回行，因此下方必须回读数据库中已存在的新版本记录。
	const result = await db.query<MembershipRow>(
		`INSERT INTO dao_memberships(
       actor_id,chain_id,contract_address,staked_amount_minor,eligible,exit_available_at,
       sync_tx_hash,sync_block_number,synced_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (actor_id) DO UPDATE SET
       chain_id=EXCLUDED.chain_id,contract_address=EXCLUDED.contract_address,
       staked_amount_minor=EXCLUDED.staked_amount_minor,eligible=EXCLUDED.eligible,
       exit_available_at=EXCLUDED.exit_available_at,sync_tx_hash=EXCLUDED.sync_tx_hash,
       sync_block_number=EXCLUDED.sync_block_number,synced_at=EXCLUDED.synced_at
     WHERE dao_memberships.sync_block_number <= EXCLUDED.sync_block_number
     RETURNING actor_id,staked_amount_minor::text,eligible,exit_available_at,sync_tx_hash,
               sync_block_number::text,synced_at`,
		[
			snapshot.actorId,
			snapshot.chainId.toString(),
			snapshot.contractAddress,
			snapshot.stakedAmountMinor.toString(),
			snapshot.eligible,
			snapshot.exitAvailableAt,
			snapshot.syncTxHash,
			snapshot.syncBlockNumber.toString(),
			now,
		],
	);
	if (result.rows[0] !== undefined) return result.rows[0];
	const current = await db.query<MembershipRow>(
		`SELECT actor_id,staked_amount_minor::text,eligible,exit_available_at,sync_tx_hash,
            sync_block_number::text,synced_at FROM dao_memberships WHERE actor_id=$1`,
		[snapshot.actorId],
	);
	const row = current.rows[0];
	if (row === undefined) throw new Error("DAO_MEMBERSHIP_UPSERT_FAILED");
	return row;
}

async function assignAwaitingPanels(
	db: QueryExecutor,
	now: Date,
): Promise<void> {
	const config = await readDaoConfig(db);
	const rounds = await db.query<{ dispute_id: string; task_id: string }>(
		`SELECT round.dispute_id::text,dispute.task_id::text
       FROM dao_arbitration_rounds round JOIN disputes dispute ON dispute.id=round.dispute_id
      WHERE round.status='awaiting_panel' ORDER BY round.created_at,round.id FOR UPDATE OF round`,
		[],
	);
	for (const round of rounds.rows) {
		const assigned = await assignRound(
			db,
			round.dispute_id,
			round.task_id,
			now,
		);
		if (assigned.status === "voting") {
			await db.query(
				"UPDATE dao_arbitration_rounds SET voting_deadline=$2 WHERE id=$1",
				[assigned.roundId, new Date(now.getTime() + config.votingWindowMs)],
			);
		}
	}
}

async function readDaoConfig(
	db: QueryExecutor,
): Promise<{ panelSize: number; quorum: number; votingWindowMs: number }> {
	const result = await db.query<{
		panel_size: number;
		quorum: number;
		voting_window_seconds: number;
	}>(
		"SELECT panel_size,quorum,voting_window_seconds FROM dao_arbitration_config WHERE id=TRUE",
		[],
	);
	const row = required(result.rows[0], "DAO_CONFIG_NOT_FOUND");
	return {
		panelSize: row.panel_size,
		quorum: row.quorum,
		votingWindowMs: row.voting_window_seconds * 1_000,
	};
}

async function assignRound(
	db: QueryExecutor,
	disputeId: string,
	taskId: string,
	now: Date,
): Promise<{ roundId: string; status: "awaiting_panel" | "voting" }> {
	// 选择种子在创建案件时一次性固化。排序结果可审计、可重放，同一案件重试分案也不会
	// 因数据库返回顺序变化而更换仲裁成员。
	const roundResult = await db.query<{
		id: string;
		selection_seed: string;
		panel_size: number;
		status: string;
	}>(
		"SELECT id::text,selection_seed,panel_size,status FROM dao_arbitration_rounds WHERE dispute_id=$1 FOR UPDATE",
		[disputeId],
	);
	const round = roundResult.rows[0];
	if (round === undefined) throw new Error("DAO_ROUND_NOT_FOUND");
	if (round.status !== "awaiting_panel")
		return { roundId: round.id, status: "voting" };
	// 发布者、所有已接单 Agent 的运营钱包和收款钱包都属于利益相关方。这里集中排除，
	// 不能只排除最后一个 Agent，否则多 Agent 工作流的其他提供者可能进入仲裁小组。
	const participants = await db.query<{ actor_id: string }>(
		`SELECT lower(publisher_id) AS actor_id FROM tasks WHERE id=$1
     UNION
     SELECT lower(agent.provider_wallet_address) FROM task_assignments assignment
       JOIN agents agent ON agent.id=assignment.agent_id
      WHERE assignment.task_id=$1 AND assignment.status='accepted'
     UNION
     SELECT lower(agent.payout_wallet_address) FROM task_assignments assignment
       JOIN agents agent ON agent.id=assignment.agent_id
      WHERE assignment.task_id=$1 AND assignment.status='accepted'`,
		[taskId],
	);
	const excluded = participants.rows.map((row) => row.actor_id);
	const candidates = await db.query<{
		actor_id: string;
		staked_amount_minor: string;
	}>(
		`SELECT actor_id,staked_amount_minor::text FROM dao_memberships
      WHERE eligible=TRUE AND exit_available_at IS NULL
        AND NOT (actor_id=ANY($1::text[]))`,
		[excluded],
	);
	const selected = [...candidates.rows]
		.sort((left, right) =>
			selectionScore(round.selection_seed, left.actor_id).localeCompare(
				selectionScore(round.selection_seed, right.actor_id),
			),
		)
		.slice(0, round.panel_size);
	if (selected.length < round.panel_size)
		return { roundId: round.id, status: "awaiting_panel" };
	for (const [index, member] of selected.entries()) {
		await db.query(
			`INSERT INTO dao_arbitration_panel_members(
         round_id,actor_id,selection_order,selected_stake_minor,selected_at
       ) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (round_id,actor_id) DO NOTHING`,
			[round.id, member.actor_id, index + 1, member.staked_amount_minor, now],
		);
	}
	await db.query(
		"UPDATE dao_arbitration_rounds SET status='voting' WHERE id=$1",
		[round.id],
	);
	return { roundId: round.id, status: "voting" };
}

function resolveOutcome(
	votes: readonly VoteRow[],
	quorum: number,
): ResolvedOutcome | null {
	// 只有“同一裁决类型达到 quorum”才构成多数；总票数达到 quorum 但意见分散时继续等待。
	// 部分结算取多数票的中位比例，降低单个极端比例对最终资金分配的影响。
	const grouped = new Map<DaoDecision, VoteRow[]>();
	for (const vote of votes)
		grouped.set(vote.decision, [...(grouped.get(vote.decision) ?? []), vote]);
	const winner = [...grouped.entries()].find(
		([, decisionVotes]) => decisionVotes.length >= quorum,
	);
	if (winner === undefined) return null;
	const [decision, decisionVotes] = winner;
	const releaseBasisPoints =
		decision === "partial_release"
			? median(decisionVotes.map((vote) => vote.release_basis_points))
			: decision === "release"
				? 10_000
				: 0;
	return {
		decision,
		releaseBasisPoints,
		responsibility: responsibilityConsensus(decisionVotes),
		reasoning: decisionVotes
			.map((vote) => vote.reasoning.trim())
			.join("\n\n")
			.slice(0, 5_000),
	};
}

export async function finalizeDaoDecision(
	db: QueryExecutor,
	round: Readonly<Pick<LockedRoundRow, "round_id" | "task_id" | "dispute_id">>,
	outcome: ResolvedOutcome,
	allVotes: readonly VoteRow[],
	now: Date,
	chainProof?: Readonly<{
		chainId: string;
		contractAddress: string;
		caseKey: string;
		blockNumber: string;
		blockHash: string;
		evidenceRoot: string;
	}>,
): Promise<Readonly<Record<string, unknown>>> {
	if (chainProof === undefined && (await hasDaoCaseSchema(db))) {
		const chainCase = await db.query(
			"SELECT 1 FROM dao_chain_cases WHERE dispute_id=$1",
			[round.dispute_id],
		);
		if (chainCase.rows.length > 0)
			throw new DaoServiceError(
				409,
				"DAO_CHAIN_DECISION_REQUIRED",
				"新版案件只能消费已确认的链上终审裁决",
			);
	}
	// 裁决、资金计划和 outbox 必须在同一数据库事务中生成。链上 worker 只消费已固化计划，
	// 不得在广播时重新读取可变报价或重新统计投票，否则审计记录可能与实际转账分叉。
	const decisionId = randomUUID();
	const settlementContext = await loadArbitrationSettlementContext(
		db,
		round.task_id,
		round.dispute_id,
	);
	const releaseAmount =
		outcome.decision === "refund"
			? 0n
			: outcome.decision === "release"
				? settlementContext.escrowAmountMinor
				: (settlementContext.escrowAmountMinor *
						BigInt(outcome.releaseBasisPoints)) /
					10_000n;
	const plan = buildArbitrationSettlementPlan({
		context: settlementContext,
		disputeId: round.dispute_id,
		decisionId,
		decision: outcome.decision,
		releaseAmountMinor: releaseAmount,
		refundAmountMinor: settlementContext.escrowAmountMinor - releaseAmount,
		releaseBasisPoints: outcome.releaseBasisPoints,
		responsibility: outcome.responsibility,
		reason: outcome.reasoning,
		authority:
			chainProof === undefined
				? {
						source: "dao",
						roundId: round.round_id,
						voteIds: allVotes.map((vote) => vote.id),
					}
				: { source: "chain_dao", ...chainProof },
	});
	await db.query(
		`INSERT INTO arbitration_decisions(
       id,dispute_id,arbitrator_id,decision,release_amount_minor,refund_amount_minor,
       platform_fee_minor,agent_amount_minor,agent_responsibility,reason,execution_status,
       decided_at,decision_source,release_basis_points,decision_hash,evidence_root
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'decided',$11,'dao',$12,$13,$14)`,
		[
			decisionId,
			round.dispute_id,
			`dao:${round.round_id}`,
			outcome.decision,
			plan.releaseAmountMinor.toString(),
			plan.refundAmountMinor.toString(),
			outcome.decision === "refund" ? null : plan.platformFeeMinor.toString(),
			outcome.decision === "refund" ? null : plan.agentAmountMinor.toString(),
			outcome.responsibility,
			outcome.reasoning,
			now,
			outcome.releaseBasisPoints,
			plan.decisionHash,
			plan.evidenceRoot,
		],
	);
	// 全额退款与 Agent 分账使用不同合约入口。普通工作流退款没有 DAO 裁决哈希，不能
	// 复用来执行仲裁退款，否则链上记录无法证明该退款来自哪份裁决。
	if (outcome.decision === "refund") {
		await db.query(
			`INSERT INTO escrow_execution_jobs(
         task_id,source,source_ref,action,evidence_root,decision_hash,status,next_attempt_at
       ) VALUES ($1,'arbitration',$2,'dispute_refund',$3,$4,'pending',$5)`,
			[round.task_id, decisionId, plan.evidenceRoot, plan.decisionHash, now],
		);
	} else {
		await db.query(
			`INSERT INTO escrow_execution_jobs(
         task_id,source,source_ref,action,workflow_payouts,settlement_manifest_hash,
         evidence_root,decision_hash,status,next_attempt_at
       ) VALUES ($1,'arbitration',$2,'workflow_settle',$3::jsonb,$4,$5,$6,'pending',$7)`,
			[
				round.task_id,
				decisionId,
				JSON.stringify(plan.payouts),
				plan.settlementManifestHash,
				plan.evidenceRoot,
				plan.decisionHash,
				now,
			],
		);
	}
	await db.query(
		"UPDATE disputes SET status='decided',updated_at=$2 WHERE id=$1",
		[round.dispute_id, now],
	);
	// 新版案件不创建旧投票轮次，只有旧案更新此镜像；裁决和 outbox 的金额规则继续共用。
	if (chainProof === undefined)
		await db.query(
			"UPDATE dao_arbitration_rounds SET status='decided',evidence_root=$2,decided_at=$3 WHERE id=$1",
			[round.round_id, plan.evidenceRoot, now],
		);
	const task = await db.query<{ status_version: string }>(
		"UPDATE tasks SET status_version=status_version+1,updated_at=$2 WHERE id=$1 RETURNING status_version::text",
		[round.task_id, now],
	);
	const version = BigInt(
		required(task.rows[0], "TASK_NOT_FOUND").status_version,
	);
	await emitTaskEvent(db, {
		taskId: round.task_id,
		statusVersion: version,
		eventType: "task.dao_arbitration_decided",
		payload: {
			status: "disputed",
			disputeId: round.dispute_id,
			roundId: round.round_id,
			decisionId,
			decision: outcome.decision,
			releaseBasisPoints: outcome.releaseBasisPoints,
			decisionHash: plan.decisionHash,
			evidenceRoot: plan.evidenceRoot,
		},
		createdAt: now,
	});
	await new PgAuditLogWriter(db).write({
		actorId: `dao:${round.round_id}`,
		actorType: "system",
		action: "dao.arbitration.decided",
		targetType: "dispute",
		targetId: round.dispute_id,
		beforeSummary: {
			status: "evidence_collection",
			voteCount: allVotes.length,
		},
		afterSummary: {
			decisionId,
			decision: outcome.decision,
			releaseBasisPoints: outcome.releaseBasisPoints,
			releaseAmountMinor: plan.releaseAmountMinor.toString(),
			refundAmountMinor: plan.refundAmountMinor.toString(),
			decisionHash: plan.decisionHash,
			evidenceRoot: plan.evidenceRoot,
		},
	});
	return {
		id: decisionId,
		type: outcome.decision,
		releaseBasisPoints: outcome.releaseBasisPoints,
		releaseAmountMinor: plan.releaseAmountMinor.toString(),
		refundAmountMinor: plan.refundAmountMinor.toString(),
		decisionHash: plan.decisionHash,
		evidenceRoot: plan.evidenceRoot,
		executionStatus: "decided",
	};
}

function selectionScore(seed: string, actorId: string): string {
	return solidityPackedKeccak256(
		["bytes32", "address"],
		[seed, getAddress(actorId)],
	);
}

function responsibilityConsensus(
	votes: readonly VoteRow[],
): AgentResponsibility {
	const counts = new Map<AgentResponsibility, number>();
	for (const vote of votes)
		counts.set(
			vote.agent_responsibility,
			(counts.get(vote.agent_responsibility) ?? 0) + 1,
		);
	const sorted = [...counts.entries()].sort(
		(left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
	);
	if (sorted.length === 0 || (sorted[1]?.[1] ?? -1) === sorted[0]?.[1])
		return "not_determined";
	return required(sorted[0], "DAO_RESPONSIBILITY_NOT_FOUND")[0];
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	return required(
		sorted[Math.floor(sorted.length / 2)],
		"DAO_PARTIAL_RATIO_NOT_FOUND",
	);
}

function normalizeAddress(value: string): string {
	try {
		return getAddress(value).toLowerCase();
	} catch {
		throw new DaoServiceError(
			422,
			"INVALID_WALLET_ADDRESS",
			"钱包地址格式无效",
		);
	}
}

function chainError(error: unknown): DaoServiceError {
	const code = error instanceof Error ? error.message : "DAO_CHAIN_UNAVAILABLE";
	const messages: Readonly<Record<string, string>> = {
		DAO_TRANSACTION_NOT_FOUND: "链上尚未找到这笔 DAO 交易",
		DAO_TRANSACTION_REVERTED: "DAO 交易执行失败",
		DAO_TRANSACTION_CONTRACT_MISMATCH: "交易目标不是当前 DAO 合约",
		DAO_TRANSACTION_NOT_CONFIRMED: "DAO 交易尚未达到所需确认数",
		DAO_MEMBERSHIP_EVENT_NOT_FOUND: "交易中没有当前钱包的 DAO 成员事件",
		DAO_YD_TOKEN_MISMATCH: "DAO 合约绑定的 YD 代币与平台配置不一致",
	};
	return new DaoServiceError(
		code === "DAO_TRANSACTION_NOT_CONFIRMED" ? 409 : 422,
		code,
		messages[code] ?? "无法核验 DAO 链上成员状态",
	);
}

function databaseCode(error: unknown): string | null {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: null;
}

function serializeMembership(row: MembershipRow) {
	return {
		actorId: row.actor_id,
		stakedAmountMinor: row.staked_amount_minor,
		eligible: row.eligible,
		exitAvailableAt: row.exit_available_at?.toISOString() ?? null,
		syncTxHash: row.sync_tx_hash,
		syncBlockNumber: row.sync_block_number,
		syncedAt: row.synced_at.toISOString(),
	};
}

function serializeCase(row: CaseRow) {
	return {
		roundId: row.round_id,
		disputeId: row.dispute_id,
		taskId: row.task_id,
		taskTitle: row.title,
		status: row.status,
		quorum: row.quorum,
		panelSize: row.panel_size,
		votingDeadline: row.voting_deadline.toISOString(),
		hasVoted: row.has_voted,
		voteCount: Number(row.vote_count),
	};
}

function required<T>(value: T | undefined, code: string): T {
	if (value === undefined) throw new Error(code);
	return value;
}

type MembershipRow = {
	actor_id: string;
	staked_amount_minor: string;
	eligible: boolean;
	exit_available_at: Date | null;
	sync_tx_hash: string;
	sync_block_number: string;
	synced_at: Date;
};

type CaseRow = {
	round_id: string;
	dispute_id: string;
	task_id: string;
	title: string;
	status: "awaiting_panel" | "voting" | "decided" | "cancelled";
	quorum: number;
	panel_size: number;
	voting_deadline: Date;
	has_voted: boolean;
	vote_count: string;
};

type LockedRoundRow = CaseRow & { dispute_id: string; task_id: string };
type VoteRow = {
	id: string;
	actor_id: string;
	decision: DaoDecision;
	release_basis_points: number;
	agent_responsibility: AgentResponsibility;
	reasoning: string;
	created_at: Date;
};
type ResolvedOutcome = Readonly<{
	decision: DaoDecision;
	releaseBasisPoints: number;
	responsibility: AgentResponsibility;
	reasoning: string;
}>;
