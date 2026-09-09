import { keccak256, toUtf8Bytes } from "ethers";
import { z } from "zod";

import type { QueryExecutor } from "../db/pool";
import { PgDisputeRepository } from "../disputes/dispute-repository";
import type { DaoCaseChainClient } from "./dao-case-chain-client";
import { daoCaseInterface, daoEvidenceKey, evidenceContentHash } from "./dao-case-contract";
import { DaoServiceError } from "./dao-service";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("vote"), releaseBasisPoints: z.number().int().min(0).max(10_000), reasoning: z.string().trim().min(10).max(5000) }).strict(),
  z.object({ action: z.literal("appeal") }).strict(),
  z.object({ action: z.literal("evidence"), evidenceId: z.uuid() }).strict(),
  z.object({ action: z.literal("claimUsdc") }).strict(),
]);

/** 证据锚定确认与钱包交易准备使用不同返回结构，路由须先识别该明确动作再分发。 */
export const confirmEvidenceSchema = z.object({ action: z.literal("confirmEvidence"), evidenceId: z.uuid(), txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict();
export const inspectEvidenceSchema = z.object({ action: z.literal("inspectEvidence"), evidenceId: z.uuid(), txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict();

/** 已确认的原始承诺只能关联相同正文和提交者，伪造哈希、冒认他人交易和替换锚定均拒绝。 */
export async function confirmDaoEvidence(db: QueryExecutor, chain: DaoCaseChainClient, disputeId: string, actorId: string, raw: unknown) {
  const input = confirmEvidenceSchema.parse(raw);
  const result = await inspectEvidenceAttempt(db, chain, disputeId, actorId, input);
  if (result.status === "anchored") return { evidenceId: result.evidenceId, txHash: result.txHash, integrity: "anchored" };
  if (result.status === "pending") throw new DaoServiceError(409, "EVIDENCE_CONFIRMATIONS_PENDING", "证据交易仍未达到确认数，请保留原哈希后重试同步");
  if (result.status === "reverted") throw new DaoServiceError(409, "EVIDENCE_TRANSACTION_REVERTED", "证据交易已确认回滚，请核对后重新签名");
  throw new DaoServiceError(409, "EVIDENCE_TRANSACTION_INVALID", "交易不属于当前证据、钱包或案件合约");
}

/** 返回稳定的链上状态；只有 confirmed 会写锚定，reverted 只授予用户再次主动签名的资格。 */
export async function inspectDaoEvidence(db: QueryExecutor, chain: DaoCaseChainClient, disputeId: string, actorId: string, raw: unknown) {
  const input = inspectEvidenceSchema.parse(raw);
  return inspectEvidenceAttempt(db, chain, disputeId, actorId, input);
}

async function inspectEvidenceAttempt(
  db: QueryExecutor,
  chain: DaoCaseChainClient,
  disputeId: string,
  actorId: string,
  input: Readonly<{ evidenceId: string; txHash: string }>,
) {
  const actor = actorId.toLowerCase();
  await new PgDisputeRepository(db).read(disputeId, actor);
  const row = await db.query<{ case_key: string; content_hash: string; description: string; attachments: unknown; anchor_tx_hash: string | null }>(
    `SELECT chain.case_key,evidence.content_hash,evidence.description,evidence.attachments,evidence.anchor_tx_hash
     FROM dao_chain_cases chain JOIN dispute_evidence evidence ON evidence.dispute_id=chain.dispute_id
     WHERE chain.dispute_id=$1 AND evidence.id=$2 AND lower(evidence.submitted_by)=$3 AND chain.chain_id=$4 AND chain.contract_address=$5`,
    [disputeId, input.evidenceId, actor, chain.chainId.toString(), chain.contractAddress],
  );
  const evidence = row.rows[0];
  if (evidence === undefined) throw new DaoServiceError(404, "EVIDENCE_NOT_FOUND", "证据不存在");
  const txHash = input.txHash.toLowerCase();
  const expected = evidenceContentHash({ disputeId, evidenceId: input.evidenceId, submitter: actor, description: evidence.description, attachments: evidence.attachments });
  if (evidence.content_hash !== expected) throw new DaoServiceError(409, "EVIDENCE_INTEGRITY_MISMATCH", "证据内容与提交承诺不一致，请勿继续仲裁");
  if (evidence.anchor_tx_hash !== null) {
    if (evidence.anchor_tx_hash !== txHash) throw new DaoServiceError(409, "EVIDENCE_ALREADY_ANCHORED", "证据已有链上承诺，不能替换交易");
    return { evidenceId: input.evidenceId, txHash, status: "anchored" as const, retryAllowed: false };
  }
  const transaction = await chain.inspectEvidenceTransaction(
    txHash, evidence.case_key, daoEvidenceKey(input.evidenceId), actor, expected,
  );
  if (transaction.status === "confirmed") {
    if (transaction.contentHash !== expected) throw new DaoServiceError(409, "EVIDENCE_INTEGRITY_MISMATCH", "链上承诺与证据正文不一致");
    await db.query("UPDATE dispute_evidence SET anchor_tx_hash=$2 WHERE id=$1", [input.evidenceId, txHash]);
    return { evidenceId: input.evidenceId, txHash, status: "anchored" as const, retryAllowed: false };
  }
  if (transaction.status === "pending") {
    return { evidenceId: input.evidenceId, txHash, status: "pending" as const, retryAllowed: false };
  }
  if (transaction.status === "invalid") {
    return { evidenceId: input.evidenceId, txHash, status: "invalid" as const, retryAllowed: false };
  }
  const snapshot = await chain.read(evidence.case_key);
  const retryAllowed = snapshot.status === "evidence"
    && BigInt(snapshot.blockTimestamp) < BigInt(snapshot.evidenceDeadline);
  return { evidenceId: input.evidenceId, txHash, status: "reverted" as const, retryAllowed };
}

/**
 * 将有权限的用户意图转换为确定性钱包交易，不替用户签名或广播。API 只编码白名单函数，
 * 不接受任意 to/calldata；客户端得到金额明细后仍需用户确认。链上再次检查状态与权限。
 */
export async function prepareDaoCaseAction(db: QueryExecutor, chain: DaoCaseChainClient, disputeId: string, actorId: string, raw: unknown) {
  const parsed = actionSchema.safeParse(raw);
  if (!parsed.success) throw new DaoServiceError(422, "VALIDATION_FAILED", "仲裁操作参数不完整");
  const actor = actorId.toLowerCase();
  // 复用卷宗可信读取权限；没有平台权限的当事人、小组成员仍可读证据，但不能直接裁决。
  const access = await new PgDisputeRepository(db).read(disputeId, actor);
  const stored = await db.query<{ case_key: string; chain_id: string; contract_address: string }>(
    "SELECT case_key,chain_id::text,contract_address FROM dao_chain_cases WHERE dispute_id=$1", [disputeId],
  );
  const row = stored.rows[0];
  if (row === undefined || row.chain_id !== chain.chainId.toString() || row.contract_address !== chain.contractAddress) {
    throw new DaoServiceError(409, "DAO_CHAIN_CASE_NOT_AVAILABLE", "本案尚未接入当前链上仲裁合约");
  }
  const snapshot = await chain.read(row.case_key);
  let data: string;
  let approvalAmountMinor = "0";
  const input = parsed.data;
  if (input.action === "vote") {
    if (snapshot.status !== "voting" || BigInt(snapshot.blockTimestamp) >= BigInt(snapshot.deadline)) throw closed();
    if (!snapshot.panel.includes(actor)) throw new DaoServiceError(403, "DAO_VOTE_FORBIDDEN", "当前钱包不在本轮仲裁小组中");
    if (await chain.hasVoted(row.case_key, snapshot.round, actor)) throw new DaoServiceError(409, "DAO_ALREADY_VOTED", "当前钱包已经投票");
    const reasoningHash = keccak256(toUtf8Bytes(input.reasoning));
    await db.query(
      `INSERT INTO dao_case_vote_reasons(dispute_id,round,actor_id,reasoning_hash,reasoning) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT DO NOTHING`, [disputeId, snapshot.round, actor, reasoningHash, input.reasoning],
    );
    data = daoCaseInterface.encodeFunctionData("vote", [row.case_key, input.releaseBasisPoints, reasoningHash]);
  } else if (input.action === "appeal") {
    if (snapshot.status !== "appeal_window" || BigInt(snapshot.blockTimestamp) >= BigInt(snapshot.deadline)) throw closed();
    // 角色 arbitator 可能同时是有权限的平台人员，不能据此排除其真实当事人身份。
    const party = await db.query(
      `SELECT 1 FROM disputes dispute JOIN tasks task ON task.id=dispute.task_id WHERE dispute.id=$1 AND (
       lower(task.publisher_id)=$2 OR EXISTS(SELECT 1 FROM task_assignments assignment JOIN agents agent ON agent.id=assignment.agent_id
         WHERE assignment.task_id=task.id AND assignment.status='accepted' AND lower(agent.provider_wallet_address)=$2))`, [disputeId, actor],
    );
    if (party.rows.length === 0) throw new DaoServiceError(403, "DAO_APPEAL_FORBIDDEN", "只有本案当事人可以申诉");
    if (snapshot.bondPolicy === 0) throw new DaoServiceError(409, "DAO_TERMS_NOT_CONFIGURED", "申诉费用与保证金规则尚未配置");
    approvalAmountMinor = (BigInt(snapshot.appealBondMinor) + BigInt(snapshot.appealFeeMinor)).toString();
    data = daoCaseInterface.encodeFunctionData("appeal", [row.case_key]);
  } else if (input.action === "evidence") {
    if (snapshot.status !== "evidence" || BigInt(snapshot.blockTimestamp) >= BigInt(snapshot.evidenceDeadline)) throw closed();
    const evidence = await db.query<{ description: string; attachments: unknown; content_hash: string | null }>(
      "SELECT description,attachments,content_hash FROM dispute_evidence WHERE id=$1 AND dispute_id=$2 AND lower(submitted_by)=$3",
      [input.evidenceId, disputeId, actor],
    );
    const entry = evidence.rows[0];
    if (entry === undefined) throw new DaoServiceError(404, "EVIDENCE_NOT_FOUND", "证据不存在或不属于当前钱包");
    const expected = evidenceContentHash({ disputeId, evidenceId: input.evidenceId, submitter: actor, description: entry.description, attachments: entry.attachments });
    if (entry.content_hash !== expected) throw new DaoServiceError(409, "EVIDENCE_INTEGRITY_MISMATCH", "证据内容与提交承诺不一致，请勿继续仲裁");
    data = daoCaseInterface.encodeFunctionData("submitEvidence", [row.case_key, daoEvidenceKey(input.evidenceId), expected]);
  } else {
    data = daoCaseInterface.encodeFunctionData("claimUsdc");
  }
  return {
    chainId: chain.chainId.toString(), to: chain.contractAddress, data, value: "0", action: input.action,
    approvalAmountMinor, appealBondMinor: snapshot.appealBondMinor, appealFeeMinor: snapshot.appealFeeMinor,
    bondPolicy: snapshot.bondPolicy, viewerRole: access.body.viewerRole,
    paymentTokenAddress: await chain.paymentToken(),
  };
}

/** 截止与状态变化统一为可恢复冲突，前端应刷新案件而非无限重发旧交易。 */
function closed() { return new DaoServiceError(409, "DAO_CASE_ACTION_CLOSED", "本案阶段已变化或操作期限已结束，请刷新案件"); }
