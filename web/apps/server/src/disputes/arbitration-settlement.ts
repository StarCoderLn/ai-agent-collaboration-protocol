import { AbiCoder, getAddress, keccak256, toUtf8Bytes } from "ethers";
import { evidenceContentHash } from "../dao/dao-case-contract";
import type { QueryExecutor } from "../db/pool";
import { calculatePlatformFee } from "../platform/task-state";

export type ArbitrationSettlementContext = Readonly<{
	workflowRunId: string;
	escrowAmountMinor: bigint;
	feeVersion: string;
	feeBasisPoints: bigint;
	gasFallbackMinor: bigint;
	lines: readonly Readonly<{
		nodeId: string;
		agentId: string;
		agreedAmountMinor: bigint;
		payoutWalletAddress: string;
		resultId: string | null;
		artifactKind: string | null;
		mimeType: string | null;
		sizeBytes: string | null;
		bodyOrFileRef: string | null;
	}>[];
	evidence: readonly Readonly<{
		id: string;
		submittedBy: string;
		party: string;
		description: string;
		attachments: unknown;
	}>[];
}>;

export type ArbitrationSettlementPlan = Readonly<{
	payouts: readonly Readonly<{
		payee: string;
		grossAmountMinor: string;
		feeAmountMinor: string;
	}>[];
	releaseAmountMinor: bigint;
	refundAmountMinor: bigint;
	platformFeeMinor: bigint;
	agentAmountMinor: bigint;
	settlementManifestHash: string | null;
	evidenceRoot: string;
	decisionHash: string;
}>;

type DecisionAuthority =
	| Readonly<{ source: "dao"; roundId: string; voteIds: readonly string[] }>
	| Readonly<{
			source: "chain_dao";
			chainId: string;
			contractAddress: string;
			caseKey: string;
			blockNumber: string;
			blockHash: string;
			evidenceRoot: string;
	  }>
	| Readonly<{ source: "platform"; arbitratorId: string }>;

/**
 * 一次性读取仲裁结算所需的全部不可变事实。DAO 与平台仲裁都必须使用这份上下文，不能
 * 各自查询“最后一个 Agent”或重新解释报价，否则同一争议会因入口不同产生不同收款人。
 */
export async function loadArbitrationSettlementContext(
	db: QueryExecutor,
	taskId: string,
	disputeId: string,
): Promise<ArbitrationSettlementContext> {
	const money = await db.query<{
		workflow_run_id: string;
		escrow_amount_minor: string;
		fee_version: string;
		fee_basis_points: number;
		gas_fallback_minor: string;
	}>(
		`SELECT run.id::text AS workflow_run_id,intent.amount_minor::text AS escrow_amount_minor,
            fee.version AS fee_version,fee.fee_basis_points,fee.gas_fallback_minor::text
       FROM task_workflow_runs run
       JOIN escrow_intents intent ON intent.task_id=run.task_id
       JOIN platform_fee_config fee ON fee.active=TRUE
      WHERE run.task_id=$1 FOR UPDATE OF run,intent`,
		[taskId],
	);
	const terms = money.rows[0];
	if (terms === undefined)
		throw new ArbitrationSettlementError(
			"ARBITRATION_SETTLEMENT_NOT_READY",
			"任务托管或工作流账本尚未就绪",
		);

	const lines = await db.query<SettlementLineRow>(
		`SELECT node.id::text AS node_id,node.selected_agent_id::text AS agent_id,
            node.agreed_amount_minor::text,agent.payout_wallet_address,
            result.id::text AS result_id,result.artifact_kind,result.mime_type,
            result.size_bytes::text,result.body_or_file_ref
       FROM task_workflow_nodes node
       JOIN agents agent ON agent.id=node.selected_agent_id
       LEFT JOIN LATERAL (
         SELECT id,artifact_kind,mime_type,size_bytes,body_or_file_ref
           FROM workflow_node_results
          WHERE workflow_node_id=node.id AND is_latest ORDER BY submitted_at DESC,id DESC LIMIT 1
       ) result ON TRUE
      WHERE node.workflow_run_id=$1 ORDER BY node.position_index,node.id`,
		[terms.workflow_run_id],
	);
	if (
		lines.rows.length === 0 ||
		lines.rows.some(
			(line) => line.agent_id === null || line.agreed_amount_minor === null,
		)
	) {
		throw new ArbitrationSettlementError(
			"ARBITRATION_SETTLEMENT_NOT_READY",
			"工作流报价尚未完整冻结",
		);
	}

	const evidence = await db.query<EvidenceRow>(
		`SELECT id::text,submitted_by,party,description,attachments,to_jsonb(dispute_evidence)->>'content_hash' AS content_hash
       FROM dispute_evidence WHERE dispute_id=$1 ORDER BY created_at,id`,
		[disputeId],
	);
	for (const row of evidence.rows) {
		if (
			row.content_hash != null &&
			row.content_hash !==
				evidenceContentHash({
					disputeId,
					evidenceId: row.id,
					submitter: row.submitted_by,
					description: row.description,
					attachments: row.attachments,
				})
		)
			throw new ArbitrationSettlementError(
				"EVIDENCE_INTEGRITY_MISMATCH",
				"证据与原始承诺不一致，已阻止资金结算",
			);
	}
	return {
		workflowRunId: terms.workflow_run_id,
		escrowAmountMinor: BigInt(terms.escrow_amount_minor),
		feeVersion: terms.fee_version,
		feeBasisPoints: BigInt(terms.fee_basis_points),
		gasFallbackMinor: BigInt(terms.gas_fallback_minor),
		lines: lines.rows.map((line) => ({
			nodeId: line.node_id,
			agentId: requiredPresent(line.agent_id, "ARBITRATION_AGENT_REQUIRED"),
			agreedAmountMinor: BigInt(
				requiredPresent(
					line.agreed_amount_minor,
					"ARBITRATION_AMOUNT_REQUIRED",
				),
			),
			payoutWalletAddress: normalizeAddress(line.payout_wallet_address),
			resultId: line.result_id,
			artifactKind: line.artifact_kind,
			mimeType: line.mime_type,
			sizeBytes: line.size_bytes,
			bodyOrFileRef: line.body_or_file_ref,
		})),
		evidence: evidence.rows.map((row) => ({
			id: row.id,
			submittedBy: row.submitted_by,
			party: row.party,
			description: row.description,
			attachments: row.attachments,
		})),
	};
}

/**
 * 按裁决释放总额在所有已冻结 Agent 报价间做确定性比例分配。余数只补到最后一条非零
 * 分账，确保最小单位严格守恒；合约收到的总毛额始终等于裁决释放额，不会遗留来源不明
 * 的舍入差额。全额退款不生成 Agent 分账，改走带裁决哈希的 dispute_refund 入口。
 */
export function buildArbitrationSettlementPlan(
	input: Readonly<{
		context: ArbitrationSettlementContext;
		disputeId: string;
		decisionId: string;
		decision: "release" | "partial_release" | "refund";
		releaseAmountMinor: bigint;
		refundAmountMinor: bigint;
		releaseBasisPoints: number;
		responsibility:
			| "agent_at_fault"
			| "agent_not_at_fault"
			| "shared"
			| "not_determined";
		reason: string;
		authority: DecisionAuthority;
	}>,
): ArbitrationSettlementPlan {
	const { context } = input;
	if (
		input.releaseAmountMinor < BigInt(0) ||
		input.refundAmountMinor < BigInt(0) ||
		input.releaseAmountMinor + input.refundAmountMinor !==
			context.escrowAmountMinor ||
		input.releaseBasisPoints < 0 ||
		input.releaseBasisPoints > 10_000
	)
		throw new ArbitrationSettlementError(
			"ARBITRATION_PAYOUT_NOT_CONSERVED",
			"仲裁释放额与退款额不守恒",
		);

	const agreedTotal = context.lines.reduce(
		(sum, line) => sum + line.agreedAmountMinor,
		BigInt(0),
	);
	if (agreedTotal !== context.escrowAmountMinor) {
		throw new ArbitrationSettlementError(
			"ARBITRATION_QUOTE_NOT_CONSERVED",
			"多 Agent 冻结报价与托管金额不一致",
		);
	}
	const allocated = allocateGross(
		context.lines,
		input.releaseAmountMinor,
		agreedTotal,
	);
	if (allocated.length > 32) {
		throw new ArbitrationSettlementError(
			"ARBITRATION_PAYOUT_COUNT_INVALID",
			"仲裁分账超过单笔链上结算上限",
		);
	}
	const payouts = allocated.map((line) => {
		const fee = calculatePlatformFee(line.grossAmountMinor, {
			feeBasisPoints: context.feeBasisPoints,
			gasFallbackMinor: context.gasFallbackMinor,
		});
		return {
			payee: line.payee,
			grossAmountMinor: line.grossAmountMinor.toString(),
			feeAmountMinor: fee.toString(),
		};
	});
	const platformFeeMinor = payouts.reduce(
		(sum, payout) => sum + BigInt(payout.feeAmountMinor),
		BigInt(0),
	);
	const decisionHash = digest({
		disputeId: input.disputeId,
		decisionId: input.decisionId,
		decision: input.decision,
		releaseAmountMinor: input.releaseAmountMinor.toString(),
		refundAmountMinor: input.refundAmountMinor.toString(),
		releaseBasisPoints: input.releaseBasisPoints,
		responsibility: input.responsibility,
		reasonHash: textHash(input.reason.trim()),
		authority:
			input.authority.source === "dao"
				? { ...input.authority, voteIds: [...input.authority.voteIds].sort() }
				: input.authority,
	});
	const artifactRoot = digest({
		workflowRunId: context.workflowRunId,
		artifacts: context.lines.map((line) => ({
			nodeId: line.nodeId,
			agentId: line.agentId,
			resultId: line.resultId,
			artifactKind: line.artifactKind,
			mimeType: line.mimeType,
			sizeBytes: line.sizeBytes,
			bodyOrFileRef: line.bodyOrFileRef,
		})),
	});
	// 链上案件的证据根由当事人的追加承诺形成，资金执行必须使用该权威根；不能在结算时
	// 重新哈希数据库当前内容替换它，否则即使已被篡改的正文也会得到一份新的“有效证明”。
	const evidenceRoot =
		input.authority.source === "chain_dao"
			? input.authority.evidenceRoot
			: keccak256(
					coder.encode(
						["bytes32", "bytes32"],
						[artifactRoot, digest(context.evidence)],
					),
				);
	const settlementManifestHash =
		payouts.length === 0
			? null
			: keccak256(
					coder.encode(
						[
							"bytes32",
							"bytes32",
							"uint256",
							"tuple(address,uint256,uint256)[]",
						],
						[
							decisionHash,
							textHash(context.workflowRunId),
							input.releaseAmountMinor,
							payouts.map((payout) => [
								payout.payee,
								payout.grossAmountMinor,
								payout.feeAmountMinor,
							]),
						],
					),
				);
	return {
		payouts,
		releaseAmountMinor: input.releaseAmountMinor,
		refundAmountMinor: input.refundAmountMinor,
		platformFeeMinor,
		agentAmountMinor: input.releaseAmountMinor - platformFeeMinor,
		settlementManifestHash,
		evidenceRoot,
		decisionHash,
	};
}

export class ArbitrationSettlementError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

function allocateGross(
	lines: ArbitrationSettlementContext["lines"],
	target: bigint,
	agreedTotal: bigint,
): readonly Readonly<{ payee: string; grossAmountMinor: bigint }>[] {
	if (target === BigInt(0)) return [];
	let assigned = BigInt(0);
	return lines.flatMap((line, index) => {
		const gross =
			index === lines.length - 1
				? target - assigned
				: (target * line.agreedAmountMinor) / agreedTotal;
		assigned += gross;
		return gross === BigInt(0)
			? []
			: [{ payee: line.payoutWalletAddress, grossAmountMinor: gross }];
	});
}

const coder = AbiCoder.defaultAbiCoder();

function digest(value: unknown): string {
	return textHash(JSON.stringify(value));
}

function textHash(value: string): string {
	return keccak256(toUtf8Bytes(value));
}

function normalizeAddress(value: string): string {
	try {
		return getAddress(value).toLowerCase();
	} catch {
		throw new ArbitrationSettlementError(
			"ARBITRATION_PAYOUT_ADDRESS_INVALID",
			"Agent 收款钱包地址无效",
		);
	}
}

function requiredPresent<T>(value: T | null | undefined, code: string): T {
	if (value === null || value === undefined) throw new Error(code);
	return value;
}

type SettlementLineRow = {
	node_id: string;
	agent_id: string | null;
	agreed_amount_minor: string | null;
	payout_wallet_address: string;
	result_id: string | null;
	artifact_kind: string | null;
	mime_type: string | null;
	size_bytes: string | null;
	body_or_file_ref: string | null;
};

type EvidenceRow = {
	id: string;
	submitted_by: string;
	party: string;
	description: string;
	attachments: unknown;
	content_hash: string | null;
};
