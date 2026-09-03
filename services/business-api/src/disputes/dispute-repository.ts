import { randomUUID } from "node:crypto";

import { PgAuditLogWriter } from "../audit/audit-log-writer";
import { createDaoRoundForDispute } from "../dao/dao-service";
import type { QueryExecutor } from "../db/pool";
import {
  decideDispute,
  openDispute,
  submitDisputeEvidence,
  type ArbitrationDecision,
  type DisputeRecord,
} from "../platform/disputes";
import { calculatePlatformFee, type TaskStatus } from "../platform/task-state";
import { emitTaskEvent } from "../tasks/task-event-repository";
import type { DecideDisputeInput, OpenDisputeInput, SubmitEvidenceInput } from "./dispute-input";
import {
  buildArbitrationSettlementPlan,
  loadArbitrationSettlementContext,
  type ArbitrationSettlementPlan,
} from "./arbitration-settlement";

export type DisputeResult = Readonly<{ statusCode: number; body: Readonly<Record<string, unknown>> }>;

export class DisputeRepositoryError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

export interface DisputeRepository {
  open(taskId: string, actorId: string, input: OpenDisputeInput, now: Date): Promise<DisputeResult>;
  submitEvidence(disputeId: string, actorId: string, input: SubmitEvidenceInput, now: Date): Promise<DisputeResult>;
  read(disputeId: string, actorId: string): Promise<DisputeResult>;
  decide(disputeId: string, actorId: string, input: DecideDisputeInput, now: Date): Promise<DisputeResult>;
}

type DisputeRow = {
  id: string; task_id: string; opened_by: string; reason: string;
  status: "evidence_collection" | "decided" | "executed" | "cancelled";
  evidence_deadline: Date; funds_frozen: boolean; created_at: Date; updated_at: Date;
};

/**
 * 争议聚合的唯一 PostgreSQL 写入口。任务锁、冻结、证据/决定、执行 outbox、审计和
 * task event 始终在同一个外层事务内；Handler 不直接 UPDATE 任一资金状态。
 */
export class PgDisputeRepository implements DisputeRepository {
  constructor(private readonly db: QueryExecutor) {}

  async open(taskId: string, actorId: string, input: OpenDisputeInput, now: Date): Promise<DisputeResult> {
    const contextResult = await this.db.query<{
      status: TaskStatus; status_version: string; publisher_id: string; agent_provider_ids: string[];
      evidence_window_seconds: number;
    }>(
      `SELECT task.status,task.status_version::text,task.publisher_id,
              ARRAY(SELECT DISTINCT lower(agent.provider_wallet_address) FROM task_assignments assignment
                JOIN agents agent ON agent.id=assignment.agent_id
               WHERE assignment.task_id=task.id AND assignment.status='accepted'
               ORDER BY lower(agent.provider_wallet_address)) AS agent_provider_ids,
              config.evidence_window_seconds
         FROM tasks task CROSS JOIN dispute_config config
        WHERE task.id=$1 AND config.id=TRUE FOR UPDATE OF task`,
      [taskId],
    );
    const context = contextResult.rows[0];
    if (context === undefined) throw notFound("TASK_NOT_FOUND", "任务不存在");
    if (context.agent_provider_ids.length === 0) throw new DisputeRepositoryError(409, "TASK_NOT_ASSIGNED", "任务尚无已接单 Agent");
    // 已广播的链上结算不可撤回。未广播的普通验收 outbox 在同一事务内取消，确保争议
    // 冻结后 worker 不会再领取旧任务。
    const irreversible = await this.db.query<{ status: string }>(
      `SELECT status FROM escrow_execution_jobs
        WHERE task_id=$1 AND source<>'arbitration'
          AND status IN ('processing','submitted','executed') LIMIT 1`,
      [taskId],
    );
    if (irreversible.rows[0] !== undefined) {
      throw new DisputeRepositoryError(409, "SETTLEMENT_ALREADY_SUBMITTED", "结算交易已提交链上，无法再发起争议");
    }
    const disputeId = randomUUID();
    let opened: ReturnType<typeof openDispute>;
    try {
      opened = openDispute({
        disputeId,
        actorId,
        reason: input.reason,
        now,
        evidenceWindowMs: context.evidence_window_seconds * 1_000,
        context: {
          taskId,
          taskStatus: context.status,
          publisherId: context.publisher_id,
          agentProviderIds: context.agent_provider_ids,
        },
      });
    } catch (error) { throw domainError(error); }

    await this.db.query(
      `INSERT INTO disputes(id,task_id,opened_by,reason,status,evidence_deadline,funds_frozen,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,$7)`,
      [disputeId, taskId, actorId, opened.dispute.reason, opened.dispute.status, opened.dispute.evidenceDeadline, now],
    );
    // 争议与 DAO 案件必须在同一事务产生；成员不足时明确保留等待成组状态，而不是
    // 回退到没有审计痕迹的临时人工处理。
    const daoRound = await createDaoRoundForDispute(this.db, disputeId, taskId, now);
    await this.db.query(
      `UPDATE escrow_execution_jobs SET status='cancelled',lock_token=NULL,lock_expires_at=NULL,updated_at=$2
        WHERE task_id=$1 AND source<>'arbitration' AND status IN ('pending','prepared','failed')`,
      [taskId, now],
    );
    const version = BigInt(context.status_version) + 1n;
    await this.db.query("UPDATE tasks SET status=$2,status_version=$3,updated_at=$4 WHERE id=$1", [taskId, opened.taskStatus, version.toString(), now]);
    let initialEvidenceId: string | null = null;
    if (input.initialEvidence !== undefined) {
      initialEvidenceId = await this.insertEvidence(
        opened.dispute,
        actorId,
        context.publisher_id,
        context.agent_provider_ids,
        input.initialEvidence,
        now,
      );
    }
    await emitTaskEvent(this.db, {
      taskId, statusVersion: version, eventType: "task.dispute_opened",
      payload: { status: opened.taskStatus, disputeId, evidenceDeadline: opened.dispute.evidenceDeadline.toISOString() }, createdAt: now,
    });
    await new PgAuditLogWriter(this.db).write({
      actorId, actorType: sameActor(actorId, context.publisher_id) ? "publisher" : "provider",
      action: "dispute.open", targetType: "dispute", targetId: disputeId,
      beforeSummary: { taskStatus: context.status },
      afterSummary: { taskStatus: opened.taskStatus, evidenceDeadline: opened.dispute.evidenceDeadline.toISOString(), initialEvidenceId },
    });
    return result(201, {
      disputeId, taskId, status: "evidence_collection", fundsFrozen: true,
      evidenceDeadline: opened.dispute.evidenceDeadline.toISOString(), taskStatus: opened.taskStatus,
      statusVersion: version.toString(), initialEvidenceId, daoRound,
    });
  }

  async submitEvidence(disputeId: string, actorId: string, input: SubmitEvidenceInput, now: Date): Promise<DisputeResult> {
    const context = await this.lockDisputeContext(disputeId);
    const evidenceId = await this.insertEvidence(context.dispute, actorId, context.publisherId, context.agentProviderIds, input, now);
    // status_version 是整个任务事件流的单调版本，不只表示 status 字段是否变化。
    // 证据提交虽然仍处于 disputed，但它是需要 SSE/Webhook 可靠送达的新任务事实；
    // 在已持有 task 行锁的事务里递增版本，可避免并发提交产生重复事件版本。
    const version = context.statusVersion + 1n;
    await this.db.query("UPDATE tasks SET status_version=$2,updated_at=$3 WHERE id=$1", [context.dispute.taskId, version.toString(), now]);
    await emitTaskEvent(this.db, {
      taskId: context.dispute.taskId, statusVersion: version,
      eventType: "task.dispute_evidence_submitted",
      payload: { status: "disputed", disputeId, evidenceId, submittedAt: now.toISOString() }, createdAt: now,
    });
    const party = sameActor(actorId, context.publisherId) ? "publisher" : "agent";
    await new PgAuditLogWriter(this.db).write({
      actorId, actorType: party === "publisher" ? "publisher" : "provider",
      action: "dispute.evidence.submit", targetType: "dispute", targetId: disputeId,
      beforeSummary: {}, afterSummary: { evidenceId, party, attachmentCount: input.attachments.length },
    });
    return result(201, { disputeId, evidenceId, party, submittedAt: now.toISOString(), statusVersion: version.toString() });
  }

  async read(disputeId: string, actorId: string): Promise<DisputeResult> {
    const access = await this.db.query<DisputeRow & {
      publisher_id: string;
      authorized_agent: boolean;
      platform_arbitrator: boolean;
      dao_panel_member: boolean;
      escrow_amount_minor: string | null;
    }>(
      `SELECT dispute.id::text,dispute.task_id::text,dispute.opened_by,dispute.reason,dispute.status,
              dispute.evidence_deadline,dispute.funds_frozen,dispute.created_at,dispute.updated_at,
              task.publisher_id,
              EXISTS(SELECT 1 FROM task_assignments assignment JOIN agents agent ON agent.id=assignment.agent_id
                WHERE assignment.task_id=task.id AND assignment.status='accepted'
                  AND lower(agent.provider_wallet_address)=lower($2)) AS authorized_agent,
              EXISTS(SELECT 1 FROM platform_actor_roles
                WHERE lower(actor_id)=lower($2) AND role='arbitrator') AS platform_arbitrator,
              EXISTS(SELECT 1 FROM dao_arbitration_rounds round
                JOIN dao_arbitration_panel_members panel ON panel.round_id=round.id
               WHERE round.dispute_id=dispute.id AND lower(panel.actor_id)=lower($2)) AS dao_panel_member
              ,(SELECT intent.amount_minor::text FROM escrow_intents intent WHERE intent.task_id=task.id) AS escrow_amount_minor
         FROM disputes dispute JOIN tasks task ON task.id=dispute.task_id WHERE dispute.id=$1`,
      [disputeId, actorId],
    );
    const dispute = access.rows[0];
    if (dispute === undefined) throw notFound("DISPUTE_NOT_FOUND", "争议不存在");
    if (
      !sameActor(actorId, dispute.publisher_id)
      && !dispute.authorized_agent
      && !dispute.platform_arbitrator
      && !dispute.dao_panel_member
    ) {
      throw notFound("DISPUTE_NOT_FOUND", "争议不存在");
    }
    const evidence = await this.db.query<{
      id: string; submitted_by: string; party: string; description: string; attachments: unknown; created_at: Date;
    }>(
      `SELECT id::text,submitted_by,party,description,attachments,created_at
         FROM dispute_evidence WHERE dispute_id=$1 ORDER BY created_at,id`,
      [disputeId],
    );
    const decision = await this.db.query<{
      id: string; arbitrator_id: string; decision: string; release_amount_minor: string | null;
      refund_amount_minor: string | null; platform_fee_minor: string | null; agent_amount_minor: string | null;
      agent_responsibility: string; reason: string; execution_status: string; execution_tx_hash: string | null;
      decided_at: Date; executed_at: Date | null;
    }>(
      `SELECT id::text,arbitrator_id,decision,release_amount_minor::text,refund_amount_minor::text,
              platform_fee_minor::text,agent_amount_minor::text,agent_responsibility,reason,
              execution_status,execution_tx_hash,decided_at,executed_at
         FROM arbitration_decisions WHERE dispute_id=$1`,
      [disputeId],
    );
    const daoRound = await this.db.query<{
      id: string; status: string; panel_size: number; quorum: number; evidence_root: string | null;
      voting_deadline: Date; decided_at: Date | null; panel_count: string; vote_count: string;
      release_votes: string; partial_release_votes: string; refund_votes: string; viewer_has_voted: boolean;
    }>(
      `SELECT round.id::text,round.status,round.panel_size,round.quorum,round.evidence_root,
              round.voting_deadline,round.decided_at,
              (SELECT count(*)::text FROM dao_arbitration_panel_members panel
                WHERE panel.round_id=round.id) AS panel_count,
              (SELECT count(*)::text FROM dao_arbitration_votes vote
                WHERE vote.round_id=round.id) AS vote_count,
              (SELECT count(*)::text FROM dao_arbitration_votes vote
                WHERE vote.round_id=round.id AND vote.decision='release') AS release_votes,
              (SELECT count(*)::text FROM dao_arbitration_votes vote
                WHERE vote.round_id=round.id AND vote.decision='partial_release') AS partial_release_votes,
              (SELECT count(*)::text FROM dao_arbitration_votes vote
                WHERE vote.round_id=round.id AND vote.decision='refund') AS refund_votes,
              EXISTS(SELECT 1 FROM dao_arbitration_votes vote
                WHERE vote.round_id=round.id AND lower(vote.actor_id)=lower($2)) AS viewer_has_voted
         FROM dao_arbitration_rounds round WHERE round.dispute_id=$1`,
      [disputeId, actorId],
    );
    const round = daoRound.rows[0];
    return result(200, {
      id: dispute.id, taskId: dispute.task_id, openedBy: dispute.opened_by, reason: dispute.reason,
      status: dispute.status, fundsFrozen: dispute.funds_frozen,
      escrowAmountMinor: dispute.escrow_amount_minor,
      evidenceDeadline: dispute.evidence_deadline.toISOString(), createdAt: dispute.created_at.toISOString(),
      evidence: evidence.rows.map((row) => ({
        id: row.id, submittedBy: row.submitted_by, party: row.party, description: row.description,
        attachments: row.attachments, createdAt: row.created_at.toISOString(),
      })),
      decision: decision.rows[0] === undefined ? null : serializeDecision(decision.rows[0]),
      // 平台仲裁员与 DAO 小组成员都可读卷宗，但只有平台角色能调用后台直接裁决接口。
      // 分开返回可防止 DAO 成员被 UI 误导到一个最终必然 403 的操作入口。
      viewerRole: dispute.platform_arbitrator || dispute.dao_panel_member
        ? "arbitrator"
        : sameActor(actorId, dispute.publisher_id) ? "publisher" : "agent",
      viewerCanPlatformDecide: dispute.platform_arbitrator,
      daoArbitration: round === undefined ? null : {
        roundId: round.id,
        status: round.status,
        panelSize: round.panel_size,
        panelCount: Number(round.panel_count),
        quorum: round.quorum,
        voteCount: Number(round.vote_count),
        votes: {
          release: Number(round.release_votes),
          partialRelease: Number(round.partial_release_votes),
          refund: Number(round.refund_votes),
        },
        viewerHasVoted: round.viewer_has_voted,
        evidenceRoot: round.evidence_root,
        votingDeadline: round.voting_deadline.toISOString(),
        decidedAt: round.decided_at?.toISOString() ?? null,
      },
    });
  }

  async decide(disputeId: string, actorId: string, input: DecideDisputeInput, now: Date): Promise<DisputeResult> {
    const context = await this.lockDisputeContext(disputeId);
    const role = await this.db.query("SELECT 1 FROM platform_actor_roles WHERE lower(actor_id)=lower($1) AND role='arbitrator'", [actorId]);
    const config = await this.db.query<{
      partial_release_enabled: boolean; fee_version: string; fee_basis_points: number; gas_fallback_minor: string;
      amount_minor: string; payee: string | null; has_workflow: boolean;
    }>(
      `SELECT dispute_config.partial_release_enabled,fee.version AS fee_version,fee.fee_basis_points,
              fee.gas_fallback_minor::text,intent.amount_minor::text,
              EXISTS(SELECT 1 FROM task_workflow_runs run WHERE run.task_id=$1) AS has_workflow,
              (SELECT agent.payout_wallet_address FROM task_assignments assignment JOIN agents agent ON agent.id=assignment.agent_id
                WHERE assignment.task_id=$1 AND assignment.status='accepted' ORDER BY assignment.assigned_at DESC LIMIT 1) AS payee
         FROM dispute_config CROSS JOIN platform_fee_config fee
         JOIN escrow_intents intent ON intent.task_id=$1
        WHERE dispute_config.id=TRUE AND fee.active=TRUE`,
      [context.dispute.taskId],
    );
    const money = config.rows[0];
    if (money === undefined) throw new DisputeRepositoryError(409, "ESCROW_NOT_READY", "托管信息尚未就绪");
    let decision: ArbitrationDecision;
    try {
      decision = decideDispute({
        decisionId: randomUUID(), dispute: context.dispute, actorId,
        actorRoles: role.rows[0] === undefined ? new Set() : new Set(["arbitrator"]),
        type: input.type, escrowAmountMinor: BigInt(money.amount_minor),
        releaseAmountMinor: input.releaseAmountMinor, refundAmountMinor: input.refundAmountMinor,
        agentResponsibility: input.agentResponsibility, reason: input.reason,
        partialReleaseEnabled: money.partial_release_enabled, now,
      });
    } catch (error) { throw domainError(error); }

    // 新多 Agent 任务必须复用 DAO 相同的比例分账和证据摘要；没有正式 workflow_run 的
    // 历史单 Agent 任务继续走旧执行格式，避免迁移后改变已经存在的争议恢复路径。
    let settlementPlan: ArbitrationSettlementPlan | null = null;
    let settlementBasisPoints: number | null = null;
    if (money.has_workflow) {
      try {
        const settlementContext = await loadArbitrationSettlementContext(this.db, context.dispute.taskId, disputeId);
        settlementBasisPoints = decision.type === "release"
          ? 10_000
          : decision.type === "refund"
            ? 0
            : Math.max(1, Math.min(9_999,
              Number(decision.releaseAmountMinor * 10_000n / settlementContext.escrowAmountMinor)));
        settlementPlan = buildArbitrationSettlementPlan({
          context: settlementContext,
          disputeId,
          decisionId: decision.id,
          decision: decision.type,
          releaseAmountMinor: decision.releaseAmountMinor,
          refundAmountMinor: decision.refundAmountMinor,
          releaseBasisPoints: settlementBasisPoints,
          responsibility: decision.agentResponsibility,
          reason: decision.reason,
          authority: { source: "platform", arbitratorId: actorId },
        });
      } catch (error) {
        throw domainError(error);
      }
    }
    if (!money.has_workflow && decision.type !== "refund" && money.payee === null) {
      throw new DisputeRepositoryError(409, "ESCROW_NOT_READY", "Agent 收款信息尚未就绪");
    }
    const legacyFee = settlementPlan === null && decision.type !== "refund"
      ? calculatePlatformFee(decision.releaseAmountMinor, {
        feeBasisPoints: BigInt(money.fee_basis_points), gasFallbackMinor: BigInt(money.gas_fallback_minor),
      })
      : null;
    const fee = settlementPlan?.platformFeeMinor ?? legacyFee;
    const agentAmount = settlementPlan?.agentAmountMinor
      ?? (legacyFee === null ? null : decision.releaseAmountMinor - legacyFee);
    await this.db.query(
      `INSERT INTO arbitration_decisions(
         id,dispute_id,arbitrator_id,decision,release_amount_minor,refund_amount_minor,
         platform_fee_minor,agent_amount_minor,agent_responsibility,reason,execution_status,decided_at,
         decision_source,release_basis_points,decision_hash,evidence_root
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'decided',$11,'platform',$12,$13,$14)`,
      [decision.id, disputeId, actorId, decision.type, decision.releaseAmountMinor.toString(), decision.refundAmountMinor.toString(),
        fee?.toString() ?? null, agentAmount?.toString() ?? null, decision.agentResponsibility, decision.reason, now,
        settlementBasisPoints,
        settlementPlan?.decisionHash ?? null, settlementPlan?.evidenceRoot ?? null],
    );
    await this.db.query("UPDATE disputes SET status='decided',updated_at=$2 WHERE id=$1", [disputeId, now]);
    if (settlementPlan !== null) {
      if (decision.type === "refund") {
        await this.db.query(
          `INSERT INTO escrow_execution_jobs(
             task_id,source,source_ref,action,evidence_root,decision_hash,status,next_attempt_at
           ) VALUES ($1,'arbitration',$2,'dispute_refund',$3,$4,'pending',$5)`,
          [context.dispute.taskId, decision.id, settlementPlan.evidenceRoot, settlementPlan.decisionHash, now],
        );
      } else {
        if (settlementPlan.settlementManifestHash === null) throw new Error("ARBITRATION_MANIFEST_REQUIRED");
        await this.db.query(
          `INSERT INTO escrow_execution_jobs(
             task_id,source,source_ref,action,workflow_payouts,settlement_manifest_hash,
             evidence_root,decision_hash,status,next_attempt_at
           ) VALUES ($1,'arbitration',$2,'workflow_settle',$3::jsonb,$4,$5,$6,'pending',$7)`,
          [context.dispute.taskId, decision.id, JSON.stringify(settlementPlan.payouts),
            settlementPlan.settlementManifestHash, settlementPlan.evidenceRoot, settlementPlan.decisionHash, now],
        );
      }
    } else {
      await this.db.query(
        `INSERT INTO escrow_execution_jobs(
           task_id,source,source_ref,action,payee,agent_gross_amount_minor,fee_amount_minor,status,next_attempt_at
         ) VALUES ($1,'arbitration',$2,$3,$4,$5,$6,'pending',$7)`,
        [context.dispute.taskId, decision.id, decision.type === "refund" ? "refund" : "release",
          decision.type === "refund" ? null : money.payee?.toLowerCase(),
          decision.type === "refund" ? null : decision.releaseAmountMinor.toString(), fee?.toString() ?? null, now],
      );
    }
    // 仲裁决定会改变任务的可执行资金事实，即使 task.status 仍是 disputed，也必须占用
    // 一个新的单调事件版本，供 SSE 续传和 Agent Webhook 精确去重。
    const version = context.statusVersion + 1n;
    await this.db.query("UPDATE tasks SET status_version=$2,updated_at=$3 WHERE id=$1", [context.dispute.taskId, version.toString(), now]);
    await emitTaskEvent(this.db, {
      taskId: context.dispute.taskId, statusVersion: version,
      eventType: "task.arbitration_decided",
      payload: { status: "disputed", disputeId, decisionId: decision.id, decision: decision.type, executionStatus: "decided" }, createdAt: now,
    });
    await new PgAuditLogWriter(this.db).write({
      actorId, actorType: "admin", action: "dispute.decision.create", targetType: "dispute", targetId: disputeId,
      beforeSummary: { status: "evidence_collection" },
      afterSummary: {
        status: "decided", decisionId: decision.id, decision: decision.type,
        releaseAmountMinor: decision.releaseAmountMinor.toString(), refundAmountMinor: decision.refundAmountMinor.toString(),
        platformFeeMinor: fee?.toString() ?? null, agentResponsibility: decision.agentResponsibility,
      },
    });
    return result(201, {
      disputeId, decisionId: decision.id, status: "decided", executionStatus: "decided",
      decision: decision.type, releaseAmountMinor: decision.releaseAmountMinor.toString(),
      refundAmountMinor: decision.refundAmountMinor.toString(), platformFeeMinor: fee?.toString() ?? null,
      agentAmountMinor: agentAmount?.toString() ?? null, statusVersion: version.toString(),
    });
  }

  private async lockDisputeContext(disputeId: string): Promise<{
    dispute: DisputeRecord; publisherId: string; agentProviderIds: readonly string[]; statusVersion: bigint;
  }> {
    const result = await this.db.query<DisputeRow & { publisher_id: string; agent_provider_ids: string[]; status_version: string }>(
      `SELECT dispute.id::text,dispute.task_id::text,dispute.opened_by,dispute.reason,dispute.status,
              dispute.evidence_deadline,dispute.funds_frozen,dispute.created_at,dispute.updated_at,
              task.publisher_id,task.status_version::text,
              ARRAY(SELECT DISTINCT lower(agent.provider_wallet_address)
                FROM task_assignments assignment JOIN agents agent ON agent.id=assignment.agent_id
               WHERE assignment.task_id=task.id AND assignment.status='accepted'
               ORDER BY lower(agent.provider_wallet_address)) AS agent_provider_ids
         FROM disputes dispute JOIN tasks task ON task.id=dispute.task_id
        WHERE dispute.id=$1 FOR UPDATE OF dispute,task`,
      [disputeId],
    );
    const row = result.rows[0];
    if (row === undefined) throw notFound("DISPUTE_NOT_FOUND", "争议不存在");
    if (row.agent_provider_ids.length === 0) throw new DisputeRepositoryError(409, "TASK_NOT_ASSIGNED", "任务尚无已接单 Agent");
    if (!row.funds_frozen && row.status !== "executed") throw new Error("DISPUTE_FREEZE_INVARIANT_BROKEN");
    return {
      dispute: {
        id: row.id, taskId: row.task_id, openedBy: row.opened_by, reason: row.reason,
        status: row.status, evidenceDeadline: row.evidence_deadline, fundsFrozen: true, createdAt: row.created_at,
      },
      publisherId: row.publisher_id,
      agentProviderIds: row.agent_provider_ids,
      statusVersion: BigInt(row.status_version),
    };
  }

  private async insertEvidence(
    dispute: DisputeRecord,
    actorId: string,
    publisherId: string,
    agentProviderIds: readonly string[],
    input: SubmitEvidenceInput,
    now: Date,
  ): Promise<string> {
    await validateEvidenceAttachments(this.db, dispute.taskId, input);
    const evidenceId = randomUUID();
    let evidence: ReturnType<typeof submitDisputeEvidence>;
    try {
      evidence = submitDisputeEvidence({
        evidenceId, dispute, actorId, publisherId, agentProviderIds,
        description: input.description, attachmentRefs: input.attachments.map((attachment) => attachment.storageRef), now,
      });
    } catch (error) { throw domainError(error); }
    await this.db.query(
      `INSERT INTO dispute_evidence(id,dispute_id,submitted_by,party,description,attachments,created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [evidence.id, dispute.id, evidence.submittedBy, evidence.party, evidence.description, JSON.stringify(input.attachments), now],
    );
    return evidence.id;
  }
}

async function validateEvidenceAttachments(db: QueryExecutor, taskId: string, input: SubmitEvidenceInput): Promise<void> {
  const result = await db.query<{ max_files: number | null; max_file_size_bytes: string | null; allowed_mime_types: string[] | null }>(
    `SELECT limits.max_files,limits.max_file_size_bytes::text,limits.allowed_mime_types
       FROM tasks task LEFT JOIN attachment_category_limits limits ON limits.category_id=task.category_id
      WHERE task.id=$1`,
    [taskId],
  );
  const limits = result.rows[0];
  if (limits === undefined) throw notFound("TASK_NOT_FOUND", "任务不存在");
  const maxFiles = limits.max_files ?? 10;
  const maxSize = BigInt(limits.max_file_size_bytes ?? String(20 * 1_048_576));
  const allowed = new Set((limits.allowed_mime_types ?? ["application/pdf", "image/png", "image/jpeg", "text/plain"]).map((value) => value.toLowerCase()));
  if (input.attachments.length > maxFiles) throw new DisputeRepositoryError(422, "EVIDENCE_ATTACHMENT_LIMIT", `证据附件不能超过 ${maxFiles} 个`);
  for (const attachment of input.attachments) {
    if (!allowed.has(attachment.mimeType) || BigInt(attachment.sizeBytes) > maxSize) {
      throw new DisputeRepositoryError(422, "EVIDENCE_ATTACHMENT_INVALID", `证据附件 ${attachment.name} 的格式或大小不符合任务分类限制`);
    }
  }
}

function serializeDecision(row: {
  id: string; arbitrator_id: string; decision: string; release_amount_minor: string | null;
  refund_amount_minor: string | null; platform_fee_minor: string | null; agent_amount_minor: string | null;
  agent_responsibility: string; reason: string; execution_status: string; execution_tx_hash: string | null;
  decided_at: Date; executed_at: Date | null;
}) {
  return {
    id: row.id, arbitratorId: row.arbitrator_id, type: row.decision,
    releaseAmountMinor: row.release_amount_minor, refundAmountMinor: row.refund_amount_minor,
    platformFeeMinor: row.platform_fee_minor, agentAmountMinor: row.agent_amount_minor,
    agentResponsibility: row.agent_responsibility, reason: row.reason,
    executionStatus: row.execution_status, executionTxHash: row.execution_tx_hash,
    decidedAt: row.decided_at.toISOString(), executedAt: row.executed_at?.toISOString() ?? null,
  };
}

function domainError(error: unknown): DisputeRepositoryError {
  const code = error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : error instanceof Error ? error.message : "DISPUTE_INVALID_OPERATION";
  const forbidden = code.includes("FORBIDDEN") || code === "ARBITRATION_FORBIDDEN";
  return new DisputeRepositoryError(forbidden ? 403 : 409, code, disputeMessage(code));
}
function disputeMessage(code: string): string {
  const messages: Readonly<Record<string, string>> = {
    DISPUTE_FORBIDDEN: "只有任务双方可以发起争议",
    INVALID_DISPUTE_INPUT: "争议原因或证据期限无效",
    INVALID_TASK_TRANSITION: "任务当前状态不能发起争议",
    DISPUTE_EVIDENCE_FORBIDDEN: "只有争议双方可以提交证据",
    EVIDENCE_COLLECTION_CLOSED: "证据收集已经结束",
    EVIDENCE_DEADLINE_PASSED: "证据提交期限已过",
    EVIDENCE_DESCRIPTION_REQUIRED: "证据说明不能为空",
    ARBITRATION_FORBIDDEN: "当前账户没有仲裁权限",
    DISPUTE_ALREADY_DECIDED: "争议已经作出决定",
    ARBITRATION_REASON_REQUIRED: "仲裁理由不完整",
    ARBITRATION_PAYOUT_NOT_CONSERVED: "仲裁金额之和必须等于托管金额",
    ARBITRATION_PAYOUT_MISMATCH: "仲裁类型与金额拆分不一致",
    PARTIAL_RELEASE_NOT_ALLOWED: "当前配置不允许部分支付",
  };
  return messages[code] ?? "争议操作与当前状态不一致";
}
function notFound(code: string, message: string): DisputeRepositoryError { return new DisputeRepositoryError(404, code, message); }
function result(statusCode: number, body: Readonly<Record<string, unknown>>): DisputeResult { return { statusCode, body }; }
function sameActor(left: string, right: string): boolean { return left.toLowerCase() === right.toLowerCase(); }
