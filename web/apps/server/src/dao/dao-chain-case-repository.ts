import { keccak256, toUtf8Bytes } from "ethers";
import { z } from "zod";

import { PgAuditLogWriter } from "../audit/audit-log-writer";
import type { QueryExecutor } from "../db/pool";
import { loadArbitrationSettlementContext } from "../disputes/arbitration-settlement";
import { createCandidatePoolSnapshot } from "./dao-candidate-pool";
import {
	type ChainCaseSnapshot,
	chainCaseSnapshotSchema,
	daoCaseInterface,
	daoCaseKey,
} from "./dao-case-contract";
import { finalizeDaoDecision } from "./dao-service";

export type DaoCaseRegistrationConfig = Readonly<{
	chainId: bigint;
	contractAddress: string;
	foundingArbitrators?: readonly string[];
}>;

export class DaoCaseRecoveryError extends Error {
	constructor(
		readonly statusCode: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export type RetryFailedCaseCommandInput = Readonly<{
	commandId: string;
	expectedErrorCode: string;
	resolutionCode:
		| "rpc_recovered"
		| "configuration_repaired"
		| "capacity_restored"
		| "dependency_recovered";
}>;

export type RetryRevertedCaseCommandInput = Readonly<{
	commandId: string;
	expectedErrorCode: string;
	expectedTxHash: string;
	resolutionCode: RetryFailedCaseCommandInput["resolutionCode"];
}>;

export type ResolveFinalReorgInput = Readonly<{
	disputeId: string;
	expectedAlertId: string;
	resolutionCode: "canonical_final_restored";
}>;

export async function loadRevertedCaseCommand(
	db: QueryExecutor,
	input: RetryRevertedCaseCommandInput,
): Promise<
	Readonly<{ caseKey: string; chainId: string; contractAddress: string }>
> {
	const row = (
		await db.query<{
			status: string;
			error_code: string | null;
			tx_hash: string | null;
			raw_transaction: string | null;
			case_key: string;
			chain_id: string;
			contract_address: string;
			attempt_status: string | null;
		}>(
			`SELECT command.status,command.error_code,command.tx_hash,command.raw_transaction,chain.case_key,
            chain.chain_id::text,chain.contract_address,
            attempt.status AS attempt_status
       FROM dao_case_commands command
       JOIN dao_chain_cases chain ON chain.dispute_id=command.dispute_id
       LEFT JOIN dao_case_command_attempts attempt
         ON attempt.command_id=command.id AND attempt.tx_hash=command.tx_hash
      WHERE command.id=$1`,
			[input.commandId],
		)
	).rows[0];
	assertRevertedCommandState(row, input);
	return {
		caseKey: row.case_key,
		chainId: row.chain_id,
		contractAddress: row.contract_address,
	};
}

/**
 * 只有链节点已确认旧签名回滚、且当前阶段仍需要同一逻辑动作时，才清除当前指针重新排队。
 * 旧签名本体保留在 attempts 表；调用方传入的快照必须来自当前配置链的确认读取。
 */
export async function retryRevertedCaseCommand(
	db: QueryExecutor,
	input: RetryRevertedCaseCommandInput,
	rawSnapshot: unknown,
	config: DaoCaseRegistrationConfig,
): Promise<
	Readonly<{
		commandId: string;
		disputeId: string;
		commandKey: string;
		status: "pending";
		nextAttemptNo: number;
	}>
> {
	const snapshot = chainCaseSnapshotSchema.parse(rawSnapshot);
	const row = (
		await db.query<{
			id: string;
			dispute_id: string;
			command_key: string;
			status: string;
			error_code: string | null;
			tx_hash: string | null;
			raw_transaction: string | null;
			case_status: string;
			snapshot: unknown;
			case_key: string;
			task_key: string;
			chain_id: string;
			contract_address: string;
			operations_frozen: boolean;
			attempt_status: string | null;
			attempts: string;
		}>(
			`SELECT command.id::text,command.dispute_id::text,command.command_key,command.status,command.error_code,
            command.tx_hash,command.raw_transaction,chain.status AS case_status,chain.snapshot,chain.case_key,
            chain.task_key,chain.chain_id::text,chain.contract_address,attempt.status AS attempt_status,
            (SELECT count(*)::text FROM dao_case_command_attempts history WHERE history.command_id=command.id) AS attempts,
            EXISTS(SELECT 1 FROM reconciliation_alerts alert JOIN disputes dispute ON dispute.task_id=alert.task_id
              WHERE dispute.id=chain.dispute_id AND alert.resolved_at IS NULL AND alert.operations_frozen=TRUE) AS operations_frozen
       FROM dao_case_commands command
       JOIN dao_chain_cases chain ON chain.dispute_id=command.dispute_id
       LEFT JOIN dao_case_command_attempts attempt
         ON attempt.command_id=command.id AND attempt.tx_hash=command.tx_hash
      WHERE command.id=$1 FOR UPDATE OF command,chain`,
			[input.commandId],
		)
	).rows[0];
	assertRevertedCommandState(row, input);
	if (
		row.chain_id !== config.chainId.toString() ||
		row.contract_address !== config.contractAddress ||
		(snapshot.status !== "none" && snapshot.taskKey !== row.task_key)
	) {
		throw new DaoCaseRecoveryError(
			409,
			"DAO_CHAIN_CASE_BINDING_MISMATCH",
			"链上案件与当前恢复配置不一致",
		);
	}
	if (row.operations_frozen)
		throw new DaoCaseRecoveryError(
			409,
			"DAO_OPERATIONS_FROZEN",
			"案件存在未解决的链上对账冻结",
		);
	if (!commandApplicableToConfirmedSnapshot(row.command_key, snapshot)) {
		throw new DaoCaseRecoveryError(
			409,
			"DAO_COMMAND_NO_LONGER_APPLICABLE",
			"当前链上阶段已不再允许重试此命令",
		);
	}
	const attempts = Number(row.attempts);
	if (!Number.isSafeInteger(attempts) || attempts >= 5) {
		throw new DaoCaseRecoveryError(
			409,
			"DAO_COMMAND_ATTEMPTS_EXHAUSTED",
			"案件命令已达到最大签名尝试次数",
		);
	}
	await db.query(
		`UPDATE dao_case_commands SET status='pending',tx_hash=NULL,raw_transaction=NULL,error_code=NULL,updated_at=now()
      WHERE id=$1`,
		[row.id],
	);
	await db.query(
		`UPDATE dao_chain_cases SET last_error_code=(SELECT error_code FROM dao_case_commands
      WHERE dispute_id=$1 AND status='failed' ORDER BY updated_at DESC LIMIT 1),updated_at=now() WHERE dispute_id=$1`,
		[row.dispute_id],
	);
	await new PgAuditLogWriter(db).write({
		actorId: "dao-operations",
		actorType: "system",
		action: "dao.case_command.retry_reverted",
		targetType: "dao_case_command",
		targetId: row.id,
		beforeSummary: {
			disputeId: row.dispute_id,
			commandKey: row.command_key,
			status: row.status,
			errorCode: row.error_code,
			txHash: row.tx_hash,
			attemptNo: attempts,
		},
		afterSummary: {
			status: "pending",
			preservedTxHash: row.tx_hash,
			nextAttemptNo: attempts + 1,
			resolutionCode: input.resolutionCode,
		},
	});
	return {
		commandId: row.id,
		disputeId: row.dispute_id,
		commandKey: row.command_key,
		status: "pending",
		nextAttemptNo: attempts + 1,
	};
}

export async function loadFinalReorgCase(
	db: QueryExecutor,
	input: ResolveFinalReorgInput,
): Promise<
	Readonly<{ caseKey: string; chainId: string; contractAddress: string }>
> {
	const row = (
		await db.query<{
			case_key: string;
			chain_id: string;
			contract_address: string;
			alert_id: string;
			code: string | null;
			operations_frozen: boolean;
		}>(
			`SELECT chain.case_key,chain.chain_id::text,chain.contract_address,
            alert.id::text AS alert_id,alert.discrepancy_summary->>'code' AS code,alert.operations_frozen
       FROM dao_chain_cases chain JOIN disputes dispute ON dispute.id=chain.dispute_id
       JOIN reconciliation_alerts alert ON alert.task_id=dispute.task_id AND alert.resolved_at IS NULL
      WHERE chain.dispute_id=$1`,
			[input.disputeId],
		)
	).rows[0];
	assertFinalReorgAlert(row, input);
	return {
		caseKey: row.case_key,
		chainId: row.chain_id,
		contractAddress: row.contract_address,
	};
}

/** 仅在确认链重新给出完全相同的最终裁决时解除冻结；不同结果继续交由人工治理。 */
export async function resolveRestoredFinalReorg(
	db: QueryExecutor,
	input: ResolveFinalReorgInput,
	rawSnapshot: unknown,
	config: DaoCaseRegistrationConfig,
	now: Date,
): Promise<
	Readonly<{
		disputeId: string;
		alertId: string;
		status: "resolved";
		restoredJobs: number;
	}>
> {
	const snapshot = chainCaseSnapshotSchema.parse(rawSnapshot);
	const row = (
		await db.query<{
			task_id: string;
			task_key: string;
			status: string;
			snapshot: unknown;
			chain_id: string;
			contract_address: string;
			alert_id: string;
			code: string | null;
			operations_frozen: boolean;
		}>(
			`SELECT dispute.task_id::text,chain.task_key,chain.status,chain.snapshot,chain.chain_id::text,chain.contract_address,
            alert.id::text AS alert_id,alert.discrepancy_summary->>'code' AS code,alert.operations_frozen
       FROM dao_chain_cases chain JOIN disputes dispute ON dispute.id=chain.dispute_id
       JOIN tasks task ON task.id=dispute.task_id
       JOIN reconciliation_alerts alert ON alert.task_id=dispute.task_id AND alert.resolved_at IS NULL
      WHERE chain.dispute_id=$1 FOR UPDATE OF task,chain,alert`,
			[input.disputeId],
		)
	).rows[0];
	assertFinalReorgAlert(row, input);
	const previous = chainCaseSnapshotSchema.safeParse(row.snapshot);
	if (
		row.chain_id !== config.chainId.toString() ||
		row.contract_address !== config.contractAddress ||
		row.status !== "final" ||
		!previous.success ||
		snapshot.status !== "final" ||
		snapshot.taskKey !== row.task_key ||
		!sameCanonicalFinal(previous.data, snapshot)
	) {
		throw new DaoCaseRecoveryError(
			409,
			"DAO_CANONICAL_FINAL_MISMATCH",
			"当前确认链未恢复原最终裁决，冻结不能解除",
		);
	}
	await db.query(
		`UPDATE dao_chain_cases SET snapshot=$2::jsonb,synced_block_number=$3,synced_block_hash=$4,
            last_error_code=(SELECT error_code FROM dao_case_commands WHERE dispute_id=$1 AND status='failed'
              ORDER BY updated_at DESC LIMIT 1),updated_at=$5 WHERE dispute_id=$1`,
		[
			input.disputeId,
			JSON.stringify(snapshot),
			snapshot.blockNumber,
			snapshot.blockHash,
			now,
		],
	);
	await db.query(
		"UPDATE reconciliation_alerts SET operations_frozen=FALSE,resolved_at=$2 WHERE id=$1 AND resolved_at IS NULL",
		[row.alert_id, now],
	);
	const restored = await db.query(
		`UPDATE escrow_execution_jobs job SET status='pending',last_error_code=NULL,next_attempt_at=$2,
            lock_token=NULL,lock_expires_at=NULL,updated_at=$2
       FROM arbitration_decisions decision
      WHERE decision.dispute_id=$1 AND job.source='arbitration' AND job.source_ref=decision.id
        AND job.status='dead_letter' AND job.last_error_code='ESCROW_OPERATIONS_FROZEN'`,
		[input.disputeId, now],
	);
	await new PgAuditLogWriter(db).write({
		actorId: "dao-operations",
		actorType: "system",
		action: "dao.final_reorg.resolve",
		targetType: "reconciliation_alert",
		targetId: row.alert_id,
		beforeSummary: {
			disputeId: input.disputeId,
			code: row.code,
			operationsFrozen: true,
			previousBlockHash: previous.data.blockHash,
		},
		afterSummary: {
			resolutionCode: input.resolutionCode,
			canonicalBlockHash: snapshot.blockHash,
			canonicalBlockNumber: snapshot.blockNumber,
			restoredJobs: restored.rowCount ?? 0,
		},
	});
	return {
		disputeId: input.disputeId,
		alertId: row.alert_id,
		status: "resolved",
		restoredJobs: restored.rowCount ?? 0,
	};
}

function assertRevertedCommandState(
	row:
		| Readonly<{
				status: string;
				error_code: string | null;
				tx_hash: string | null;
				raw_transaction: string | null;
				attempt_status: string | null;
		  }>
		| undefined,
	input: RetryRevertedCaseCommandInput,
): asserts row is NonNullable<typeof row> {
	if (row === undefined)
		throw new DaoCaseRecoveryError(
			404,
			"DAO_COMMAND_NOT_FOUND",
			"案件推进命令不存在",
		);
	if (
		row.status !== "failed" ||
		row.error_code !== input.expectedErrorCode ||
		row.tx_hash !== input.expectedTxHash.toLowerCase()
	) {
		throw new DaoCaseRecoveryError(
			409,
			"DAO_COMMAND_STATE_CHANGED",
			"命令状态、错误原因或交易哈希已经变化，请刷新后重新核对",
		);
	}
	if (row.raw_transaction === null || row.attempt_status !== "reverted") {
		throw new DaoCaseRecoveryError(
			409,
			"DAO_REVERTED_ATTEMPT_NOT_RECORDED",
			"回滚交易的不可变尝试记录尚未就绪",
		);
	}
}

function assertFinalReorgAlert(
	row:
		| Readonly<{
				alert_id: string;
				code: string | null;
				operations_frozen: boolean;
		  }>
		| undefined,
	input: ResolveFinalReorgInput,
): asserts row is NonNullable<typeof row> {
	if (row === undefined)
		throw new DaoCaseRecoveryError(
			404,
			"DAO_REORG_ALERT_NOT_FOUND",
			"未找到待处理的 DAO 重组冻结",
		);
	if (
		row.alert_id !== input.expectedAlertId ||
		row.code !== "DAO_FINAL_DECISION_REORGED" ||
		!row.operations_frozen
	) {
		throw new DaoCaseRecoveryError(
			409,
			"DAO_REORG_ALERT_STATE_CHANGED",
			"重组告警已变化，请刷新后重新核对",
		);
	}
}

/** 规范恢复必须保持全部案件语义；区块位置可因重组变化，但小组、票、费用和时限不能变。 */
function sameCanonicalFinal(
	previous: ChainCaseSnapshot,
	current: ChainCaseSnapshot,
): boolean {
	const {
		blockNumber: _previousNumber,
		blockHash: _previousHash,
		blockTimestamp: _previousTime,
		...previousCase
	} = previous;
	const {
		blockNumber: _currentNumber,
		blockHash: _currentHash,
		blockTimestamp: _currentTime,
		...currentCase
	} = current;
	return JSON.stringify(previousCase) === JSON.stringify(currentCase);
}

/**
 * 运营只能重新排队尚未签名且当前链阶段仍需要的命令。已生成原始交易的命令可能占用
 * operator nonce，清空后重签会制造双重广播；重组冻结则必须先走独立链上核对流程。
 * expectedErrorCode 是乐观锁，避免运营依据旧页面覆盖 worker 刚写入的新失败原因。
 */
export async function retryUnsignedCaseCommand(
	db: QueryExecutor,
	input: RetryFailedCaseCommandInput,
): Promise<
	Readonly<{
		commandId: string;
		disputeId: string;
		commandKey: string;
		status: "pending";
	}>
> {
	const result = await db.query<{
		id: string;
		dispute_id: string;
		command_key: string;
		status: string;
		error_code: string | null;
		tx_hash: string | null;
		raw_transaction: string | null;
		case_status: string;
		snapshot: unknown;
		operations_frozen: boolean;
	}>(
		`SELECT command.id::text,command.dispute_id::text,command.command_key,command.status,command.error_code,
            command.tx_hash,command.raw_transaction,chain.status AS case_status,chain.snapshot,
            EXISTS(SELECT 1 FROM reconciliation_alerts alert JOIN disputes dispute ON dispute.task_id=alert.task_id
              WHERE dispute.id=chain.dispute_id AND alert.resolved_at IS NULL AND alert.operations_frozen=TRUE) AS operations_frozen
       FROM dao_case_commands command JOIN dao_chain_cases chain ON chain.dispute_id=command.dispute_id
      WHERE command.id=$1 FOR UPDATE OF command,chain`,
		[input.commandId],
	);
	const row = result.rows[0];
	if (row === undefined)
		throw new DaoCaseRecoveryError(
			404,
			"DAO_COMMAND_NOT_FOUND",
			"案件推进命令不存在",
		);
	if (row.status !== "failed" || row.error_code !== input.expectedErrorCode) {
		throw new DaoCaseRecoveryError(
			409,
			"DAO_COMMAND_STATE_CHANGED",
			"命令状态或错误原因已经变化，请刷新后重新核对",
		);
	}
	if (row.tx_hash !== null || row.raw_transaction !== null) {
		throw new DaoCaseRecoveryError(
			409,
			"DAO_SIGNED_COMMAND_RETRY_FORBIDDEN",
			"已签名命令必须保留原交易并核对回执",
		);
	}
	if (row.operations_frozen) {
		throw new DaoCaseRecoveryError(
			409,
			"DAO_OPERATIONS_FROZEN",
			"案件存在未解决的链上对账冻结",
		);
	}
	if (!commandStillApplicable(row.command_key, row.case_status, row.snapshot)) {
		throw new DaoCaseRecoveryError(
			409,
			"DAO_COMMAND_NO_LONGER_APPLICABLE",
			"当前链上阶段已不再允许执行此命令",
		);
	}

	await db.query(
		"UPDATE dao_case_commands SET status='pending',error_code=NULL,updated_at=now() WHERE id=$1",
		[row.id],
	);
	await db.query(
		`UPDATE dao_chain_cases SET last_error_code=(SELECT error_code FROM dao_case_commands
      WHERE dispute_id=$1 AND status='failed' ORDER BY updated_at DESC LIMIT 1),updated_at=now() WHERE dispute_id=$1`,
		[row.dispute_id],
	);
	await new PgAuditLogWriter(db).write({
		actorId: "dao-operations",
		actorType: "system",
		action: "dao.case_command.retry",
		targetType: "dao_case_command",
		targetId: row.id,
		beforeSummary: {
			disputeId: row.dispute_id,
			commandKey: row.command_key,
			status: row.status,
			errorCode: row.error_code,
		},
		afterSummary: { status: "pending", resolutionCode: input.resolutionCode },
	});
	return {
		commandId: row.id,
		disputeId: row.dispute_id,
		commandKey: row.command_key,
		status: "pending",
	};
}

function commandStillApplicable(
	commandKey: string,
	caseStatus: string,
	rawSnapshot: unknown,
): boolean {
	if (commandKey === "open")
		return caseStatus === "pending_registration" && rawSnapshot === null;
	const match =
		/^([12]):(requestPanel|selectPanel|closeRound|finalizeUnappealed|enterRecovery|finalizeRecovery)$/.exec(
			commandKey,
		);
	if (match === null || rawSnapshot === null) return false;
	const snapshot = chainCaseSnapshotSchema.safeParse(rawSnapshot);
	return (
		snapshot.success &&
		snapshot.data.round === Number(match[1]) &&
		nextCaseAction(snapshot.data) === match[2]
	);
}

/** 确认链尚无案件时 open 仍可重试；数据库镜像的 pending_registration 不能用于这里。 */
function commandApplicableToConfirmedSnapshot(
	commandKey: string,
	snapshot: ChainCaseSnapshot,
): boolean {
	if (commandKey === "open") return snapshot.status === "none";
	const match =
		/^([12]):(requestPanel|selectPanel|closeRound|finalizeUnappealed|enterRecovery|finalizeRecovery)$/.exec(
			commandKey,
		);
	return (
		match !== null &&
		snapshot.round === Number(match[1]) &&
		nextCaseAction(snapshot) === match[2]
	);
}

/**
 * 冻结事务中的新版案件入口：参与方、任务键和初始证据根一次性固化，开案命令同事务
 * 写入 outbox。没有此配置时保持既有案件流程，不将老部署伪装成支持 VRF 的新合约。
 */
export async function registerChainCase(
	db: QueryExecutor,
	disputeId: string,
	taskId: string,
	config: DaoCaseRegistrationConfig,
): Promise<void> {
	const context = await loadArbitrationSettlementContext(db, taskId, disputeId);
	const task = await db.query<{ task_key: string }>(
		"SELECT task_key FROM escrow_intents WHERE task_id=$1",
		[taskId],
	);
	const taskKey = task.rows[0]?.task_key;
	if (taskKey === undefined) throw new Error("ESCROW_NOT_READY");
	const participants = await db.query<{ actor_id: string }>(
		`SELECT lower(publisher_id) AS actor_id FROM tasks WHERE id=$1
     UNION SELECT lower(agent.provider_wallet_address) FROM task_assignments assignment JOIN agents agent ON agent.id=assignment.agent_id
       WHERE assignment.task_id=$1 AND assignment.status='accepted'
     UNION SELECT lower(agent.payout_wallet_address) FROM task_assignments assignment JOIN agents agent ON agent.id=assignment.agent_id
       WHERE assignment.task_id=$1 AND assignment.status='accepted'`,
		[taskId],
	);
	const parties = z
		.array(z.string().regex(/^0x[0-9a-f]{40}$/))
		.min(1)
		.max(65)
		.parse(participants.rows.map((row) => row.actor_id).sort());
	const authorized = await db.query<{ actor_id: string }>(
		`SELECT lower(publisher_id) AS actor_id FROM tasks WHERE id=$1
     UNION SELECT lower(agent.provider_wallet_address) FROM task_assignments assignment JOIN agents agent ON agent.id=assignment.agent_id
       WHERE assignment.task_id=$1 AND assignment.status='accepted' ORDER BY actor_id`,
		[taskId],
	);
	const root = keccak256(
		toUtf8Bytes(
			JSON.stringify(
				{ version: "aicp-case-baseline-v1", disputeId, context },
				(_key, value: unknown) =>
					typeof value === "bigint" ? value.toString() : value,
			),
		),
	);
	const caseKey = daoCaseKey(disputeId);
	const eligible =
		config.foundingArbitrators === undefined ||
		config.foundingArbitrators.length === 0
			? []
			: (
					await db.query<{ actor_id: string }>(
						"SELECT actor_id FROM dao_memberships WHERE chain_id=$1 AND eligible=TRUE AND exit_available_at IS NULL ORDER BY actor_id",
						[config.chainId.toString()],
					)
				).rows.map((row) => row.actor_id);
	const candidatePoolPolicy = createCandidatePoolSnapshot(
		config.foundingArbitrators ?? [],
		eligible,
	);
	await db.query(
		`INSERT INTO dao_chain_cases(
       dispute_id,chain_id,contract_address,case_key,task_key,initial_evidence_root,parties,candidate_pool_policy
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
		[
			disputeId,
			config.chainId.toString(),
			config.contractAddress,
			caseKey,
			taskKey,
			root,
			JSON.stringify(parties),
			JSON.stringify(candidatePoolPolicy),
		],
	);
	await enqueueCaseCommand(
		db,
		disputeId,
		"open",
		daoCaseInterface.encodeFunctionData("openCase", [
			caseKey,
			taskKey,
			authorized.rows.map((row) => row.actor_id),
			parties,
			root,
		]),
	);
}

/** 动作键绑定轮次，worker 重启或用户重复同步不会再创建一次同类交易。 */
export async function enqueueCaseCommand(
	db: QueryExecutor,
	disputeId: string,
	key: string,
	data: string,
): Promise<void> {
	await db.query(
		`INSERT INTO dao_case_commands(dispute_id,command_key,calldata) VALUES ($1,$2,$3)
     ON CONFLICT (dispute_id,command_key) DO NOTHING`,
		[disputeId, key, data.toLowerCase()],
	);
}

/**
 * 链状态同步与裁决落库共享任务聚合锁；只允许消费已确认快照的 Final 状态，申诉窗口
 * 不创建任何付款 outbox。平台直接裁决入口也必须查询此绑定，不能绕过该权威状态源。
 */
export async function projectChainCase(
	db: QueryExecutor,
	disputeId: string,
	rawSnapshot: unknown,
	config: DaoCaseRegistrationConfig,
	now: Date,
): Promise<void> {
	const snapshot = chainCaseSnapshotSchema.parse(rawSnapshot);
	const result = await db.query<{
		task_id: string;
		task_key: string;
		case_key: string;
		chain_id: string;
		contract_address: string;
		synced_block_number: string | null;
		synced_block_hash: string | null;
		snapshot: unknown;
		status: string;
		dispute_status: string;
	}>(
		`SELECT chain.task_key,chain.case_key,chain.chain_id::text,chain.contract_address,chain.synced_block_number::text,
            chain.status,chain.snapshot,chain.synced_block_hash,dispute.task_id::text,dispute.status AS dispute_status
       FROM dao_chain_cases chain JOIN disputes dispute ON dispute.id=chain.dispute_id JOIN tasks task ON task.id=dispute.task_id
      WHERE chain.dispute_id=$1 FOR UPDATE OF task,dispute,chain`,
		[disputeId],
	);
	const row = result.rows[0];
	if (row === undefined) throw new Error("DAO_CHAIN_CASE_NOT_FOUND");
	if (
		row.chain_id !== config.chainId.toString() ||
		row.contract_address !== config.contractAddress ||
		(snapshot.status !== "none" && snapshot.taskKey !== row.task_key)
	)
		throw new Error("DAO_CHAIN_CASE_BINDING_MISMATCH");
	if (
		row.synced_block_number !== null &&
		BigInt(snapshot.blockNumber) < BigInt(row.synced_block_number)
	)
		return;
	if (
		(row.status === "final" || row.dispute_status !== "evidence_collection") &&
		snapshot.status !== "final"
	) {
		throw new Error("DAO_FINAL_DECISION_REORGED");
	}
	// 只有尚未确认开案的 None 才可继续等待；终审后案件消失同样属于重组，必须先阻断资金路径。
	if (snapshot.status === "none") return;
	if (row.status === "final" && row.snapshot !== null) {
		const previous = chainCaseSnapshotSchema.parse(row.snapshot);
		if (
			previous.evidenceRoot !== snapshot.evidenceRoot ||
			previous.releaseBasisPoints !== snapshot.releaseBasisPoints ||
			(row.synced_block_number === snapshot.blockNumber &&
				row.synced_block_hash !== snapshot.blockHash)
		) {
			throw new Error("DAO_FINAL_DECISION_REORGED");
		}
	}
	await db.query(
		`UPDATE dao_chain_cases SET status=$2,snapshot=$3::jsonb,synced_block_number=$4,synced_block_hash=$5,
            last_error_code=(SELECT error_code FROM dao_case_commands WHERE dispute_id=$1 AND status='failed' ORDER BY updated_at DESC LIMIT 1),
            updated_at=$6 WHERE dispute_id=$1`,
		[
			disputeId,
			snapshot.status,
			JSON.stringify(snapshot),
			snapshot.blockNumber,
			snapshot.blockHash,
			now,
		],
	);
	// 证据时限取自真实开案区块，不能使用链下排队时刻提前剥夺当事人的提交时间。
	await db.query(
		"UPDATE disputes SET evidence_deadline=to_timestamp($2::numeric) WHERE id=$1",
		[disputeId, snapshot.evidenceDeadline],
	);
	if (snapshot.status !== "final") return;
	const existing = await db.query(
		"SELECT 1 FROM arbitration_decisions WHERE dispute_id=$1",
		[disputeId],
	);
	if (existing.rows.length > 0) return;
	const bps = snapshot.releaseBasisPoints;
	await finalizeDaoDecision(
		db,
		{ round_id: disputeId, dispute_id: disputeId, task_id: row.task_id },
		{
			decision:
				bps === 0 ? "refund" : bps === 10_000 ? "release" : "partial_release",
			releaseBasisPoints: bps,
			// 链上比例投票没有责任归属票，不用金额推测“谁有过错”写入 Agent 训练/信誉数据。
			responsibility: "not_determined",
			reasoning:
				"依据已确认的 DAO 链上终审裁决执行，完整理由与证据以案件卷宗及链上承诺为准。",
		},
		[],
		now,
		{
			chainId: config.chainId.toString(),
			contractAddress: config.contractAddress,
			caseKey: row.case_key,
			blockNumber: snapshot.blockNumber,
			blockHash: snapshot.blockHash,
			evidenceRoot: snapshot.evidenceRoot,
		},
	);
}

/**
 * 自动推进只使用已确认链时间。缺成员、等待 VRF、终审无多数均不生成伪造裁决；费用
 * 由合约快照决定，worker 不替用户发起申诉或批准代币。
 */
export function nextCaseAction(
	snapshot: ChainCaseSnapshot,
):
	| "requestPanel"
	| "selectPanel"
	| "closeRound"
	| "finalizeUnappealed"
	| "enterRecovery"
	| "finalizeRecovery"
	| null {
	const now = BigInt(snapshot.blockTimestamp);
	if (
		snapshot.status === "voting" &&
		snapshot.voteCount === snapshot.panel.length
	)
		return "closeRound";
	if (snapshot.status === "voting" && now >= BigInt(snapshot.deadline))
		return "closeRound";
	if (snapshot.status === "appeal_window" && now >= BigInt(snapshot.deadline))
		return "finalizeUnappealed";
	if (
		!["none", "final", "stalled", "recovery"].includes(snapshot.status) &&
		snapshot.recoveryEligibleAt != null &&
		now >= BigInt(snapshot.recoveryEligibleAt)
	)
		return "enterRecovery";
	if (
		snapshot.status === "awaiting_panel" ||
		(snapshot.status === "evidence" && now >= BigInt(snapshot.evidenceDeadline))
	)
		return "requestPanel";
	if (snapshot.status === "randomness_ready") return "selectPanel";
	if (snapshot.status === "recovery" && now >= BigInt(snapshot.deadline))
		return "finalizeRecovery";
	return null;
}
