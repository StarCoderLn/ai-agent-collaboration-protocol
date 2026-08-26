import { Buffer } from "node:buffer";

import type { QueryExecutor } from "../db/pool";
import { reportExecutionProgress, requestTaskRework, submitTaskResults, type ExecutionSnapshot } from "../platform/execution";
import { calculatePlatformFee, transitionTaskStatus, type TaskStatus } from "../platform/task-state";
import type { AcceptancePreviewInput, AcceptResultInput, ExecutionStatusInput, ResultSubmissionInput, ReworkInput } from "./execution-input";
import { ExecutionServiceError, type ExecutionRepository } from "./execution-service";
import type { TaskServiceResult } from "./task-service";
import { emitTaskEvent } from "./task-event-repository";

type LockedExecutionRow = {
  status: TaskStatus;
  status_version: string;
  deadline: Date;
  assignment_status: string;
  assigned_agent_id: string;
  progress: number | null;
  last_reported_at: Date | null;
  rework_count: string;
  max_rework_count: number;
};

type CallbackInboxRow = {
  task_id: string;
  assignment_id: string;
  operation: string;
  request_fingerprint: string;
  response_snapshot: TaskServiceResult;
};

type ResultRow = {
  id: string;
  submission_batch: string;
  batch_no: number;
  result_index: number;
  summary: string;
  artifact_kind: "inline" | "file";
  body_or_file_ref: string;
  mime_type: string;
  size_bytes: string;
  generated_at: Date;
  note: string | null;
  is_latest: boolean;
  submitted_at: Date;
};

type AcceptanceTermsRow = {
  status: TaskStatus;
  status_version: string;
  assignment_id: string;
  agreed_amount_minor: string;
  fee_version: string;
  fee_basis_points: number;
  gas_fallback_minor: string;
  escrow_amount_wei: string;
  payout_wallet_address: string;
};

type SettlementTerms = Readonly<{
  grossAmountMinor: string;
  platformFeeMinor: string;
  agentAmountMinor: string;
  feeRuleVersion: string;
}>;

const INLINE_MIME_TYPES = new Set(["text/plain", "text/markdown", "application/json", "text/html"]);
const DEFAULT_FILE_MIME_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "text/plain"]);
const DEFAULT_FILE_SIZE_BYTES = 20n * 1_048_576n;

/**
 * 该仓储必须使用事务内 QueryExecutor。任务行锁、结果/返工/验收写入、task_events 与
 * Agent callback inbox 都位于同一个事务，任何一步失败都不会留下“状态已变但证据缺失”。
 */
export class PgExecutionRepository implements ExecutionRepository {
  constructor(private readonly db: QueryExecutor) {}

  async reportStatus(taskId: string, input: ExecutionStatusInput, idempotencyKey: string, fingerprint: string): Promise<TaskServiceResult> {
    const locked = await this.lockExecution(taskId, input.assignmentId, input.agentId);
    const replay = await this.callbackReplay(idempotencyKey, "execution_status", taskId, input.assignmentId, fingerprint);
    if (replay !== null) return replay;
    assertExecutionReady(locked);
    if (input.state === "failed") {
      return this.recordExecutionFailure(taskId, input, idempotencyKey, fingerprint, locked);
    }
    const snapshot = executionSnapshot(locked);
    let next: ExecutionSnapshot;
    try { next = reportExecutionProgress(snapshot, input.progress); }
    catch (error) { throw executionDomainError(error); }
    const executionState = input.state ?? "running";
    const attentionMessage = input.state === "needs_input" ? input.message : null;
    const version = BigInt(locked.status_version) + 1n;
    await this.db.query("UPDATE tasks SET status_version=$2,updated_at=now() WHERE id=$1", [taskId, version.toString()]);
    await this.db.query(
      `INSERT INTO task_execution_state(
         task_id,assignment_id,progress,last_reported_at,execution_state,estimated_completion_at,attention_message
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (task_id) DO UPDATE SET assignment_id=EXCLUDED.assignment_id,
         progress=EXCLUDED.progress,last_reported_at=EXCLUDED.last_reported_at,
         execution_state=EXCLUDED.execution_state,estimated_completion_at=EXCLUDED.estimated_completion_at,
         attention_message=EXCLUDED.attention_message,failure_code=NULL,failed_at=NULL,updated_at=now()`,
      [taskId, input.assignmentId, next.progress, new Date(input.reportedAt), executionState,
        input.estimatedCompletionAt === undefined ? null : new Date(input.estimatedCompletionAt),
        attentionMessage],
    );
    await this.writeEvent(taskId, version, executionState === "needs_input" ? "task.input_requested" : "task.execution_progress", {
      status: locked.status, progress: next.progress, executionState,
      reportedAt: input.reportedAt, estimatedCompletionAt: input.estimatedCompletionAt ?? null,
      ...(attentionMessage === null ? {} : { message: attentionMessage }),
      assignmentId: input.assignmentId,
    });
    const result = resultOf(200, {
      taskId, status: locked.status, statusVersion: version.toString(), progress: next.progress,
      executionState, lastReportedAt: input.reportedAt,
      estimatedCompletionAt: input.estimatedCompletionAt ?? null,
      attentionMessage,
    });
    await this.saveCallback(idempotencyKey, taskId, input.assignmentId, "execution_status", fingerprint, result);
    return result;
  }

  private async recordExecutionFailure(
    taskId: string,
    input: Extract<ExecutionStatusInput, { state: "failed" }>,
    idempotencyKey: string,
    fingerprint: string,
    locked: LockedExecutionRow,
  ): Promise<TaskServiceResult> {
    let nextStatus: TaskStatus;
    try {
      nextStatus = transitionTaskStatus(locked.status, {
        type: "execution_failed",
        failureCode: input.failureCode,
      });
    } catch (error) { throw executionDomainError(error); }
    const version = BigInt(locked.status_version) + 1n;
    const reportedAt = new Date(input.reportedAt);
    await this.db.query(
      "UPDATE tasks SET status=$2,status_version=$3,updated_at=now() WHERE id=$1",
      [taskId, nextStatus, version.toString()],
    );
    await this.db.query(
      `INSERT INTO task_execution_state(
         task_id,assignment_id,progress,last_reported_at,execution_state,failure_code,failed_at
       ) VALUES ($1,$2,$3,$4,'failed',$5,$4)
       ON CONFLICT (task_id) DO UPDATE SET assignment_id=EXCLUDED.assignment_id,
         last_reported_at=EXCLUDED.last_reported_at,execution_state='failed',
         failure_code=EXCLUDED.failure_code,failed_at=EXCLUDED.failed_at,
         estimated_completion_at=NULL,attention_message=NULL,updated_at=now()`,
      [taskId, input.assignmentId, locked.progress ?? 0, reportedAt, input.failureCode],
    );
    await this.writeEvent(taskId, version, "task.execution_failed", {
      status: nextStatus,
      failureCode: input.failureCode,
      reportedAt: input.reportedAt,
      assignmentId: input.assignmentId,
    });
    const result = resultOf(200, {
      taskId,
      status: nextStatus,
      statusVersion: version.toString(),
      progress: locked.progress ?? 0,
      executionState: "failed",
      failureCode: input.failureCode,
      failedAt: input.reportedAt,
    });
    await this.saveCallback(idempotencyKey, taskId, input.assignmentId, "execution_status", fingerprint, result);
    return result;
  }

  async submitResults(taskId: string, input: ResultSubmissionInput, idempotencyKey: string, fingerprint: string): Promise<TaskServiceResult> {
    const locked = await this.lockExecution(taskId, input.assignmentId, input.agentId);
    const replay = await this.callbackReplay(idempotencyKey, "result_submit", taskId, input.assignmentId, fingerprint);
    if (replay !== null) return replay;
    assertExecutionReady(locked);
    const limits = await this.resultLimits(taskId);
    const formats = input.results.map((entry) => entry.mimeType.toLocaleLowerCase());
    validateArtifacts(input, limits.allowedFileMimeTypes, limits.maxFileSizeBytes);
    let next: ExecutionSnapshot;
    try { next = submitTaskResults(executionSnapshot(locked), formats, limits.allowedMimeTypes); }
    catch (error) { throw executionDomainError(error); }

    const batchRow = await this.db.query<{ batch_no: number; submission_batch: string }>(
      `SELECT COALESCE(max(batch_no),0)::int + 1 AS batch_no, gen_random_uuid()::text AS submission_batch
         FROM task_results WHERE task_id=$1`,
      [taskId],
    );
    const batch = required(batchRow.rows[0], "RESULT_BATCH_NOT_CREATED");
    await this.db.query("UPDATE task_results SET is_latest=FALSE WHERE task_id=$1 AND is_latest=TRUE", [taskId]);
    const stored: Array<Record<string, unknown>> = [];
    for (const [index, artifact] of input.results.entries()) {
      const content = artifact.kind === "inline" ? artifact.content : artifact.storageRef;
      const size = artifact.kind === "inline" ? BigInt(Buffer.byteLength(artifact.content, "utf8")) : BigInt(artifact.sizeBytes);
      const inserted = await this.db.query<ResultRow>(
        `INSERT INTO task_results (
           task_id,assignment_id,submission_batch,batch_no,result_index,summary,artifact_kind,
           body_or_file_ref,mime_type,size_bytes,generated_at,note
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id::text,submission_batch::text,batch_no,result_index,summary,artifact_kind,
           body_or_file_ref,mime_type,size_bytes::text,generated_at,note,is_latest,submitted_at`,
        [taskId, input.assignmentId, batch.submission_batch, batch.batch_no, index + 1,
          artifact.summary, artifact.kind, content, artifact.mimeType.toLocaleLowerCase(), size.toString(),
          new Date(artifact.generatedAt), artifact.note ?? null],
      );
      stored.push(serializeResult(required(inserted.rows[0], "RESULT_NOT_INSERTED"), true));
    }
    const version = BigInt(locked.status_version) + 1n;
    await this.db.query("UPDATE tasks SET status=$2,status_version=$3,updated_at=now() WHERE id=$1", [taskId, next.status, version.toString()]);
    await this.db.query(
      `INSERT INTO task_execution_state(task_id,assignment_id,progress,last_reported_at)
       VALUES ($1,$2,100,now())
       ON CONFLICT (task_id) DO UPDATE SET assignment_id=EXCLUDED.assignment_id,progress=100,
         execution_state='running',estimated_completion_at=NULL,attention_message=NULL,
         failure_code=NULL,failed_at=NULL,updated_at=now()`,
      [taskId, input.assignmentId],
    );
    await this.writeEvent(taskId, version, "task.results_submitted", {
      status: next.status, batchNo: batch.batch_no, submissionBatch: batch.submission_batch,
      resultIds: stored.map((entry) => entry.id),
    });
    const result = resultOf(201, {
      taskId, status: next.status, statusVersion: version.toString(), batchNo: batch.batch_no,
      submissionBatch: batch.submission_batch, results: stored,
    });
    await this.saveCallback(idempotencyKey, taskId, input.assignmentId, "result_submit", fingerprint, result);
    return result;
  }

  async listResults(taskId: string, actorId: string): Promise<TaskServiceResult> {
    await this.assertPublisher(taskId, actorId);
    const rows = await this.db.query<ResultRow>(
      `SELECT id::text,submission_batch::text,batch_no,result_index,summary,artifact_kind,
              body_or_file_ref,mime_type,size_bytes::text,generated_at,note,is_latest,submitted_at
         FROM task_results WHERE task_id=$1 ORDER BY batch_no DESC,result_index`,
      [taskId],
    );
    return resultOf(200, { taskId, results: rows.rows.map((row) => serializeResult(row, true)) });
  }

  async previewAcceptance(taskId: string, input: AcceptancePreviewInput, actorId: string): Promise<TaskServiceResult> {
    const terms = await this.readAcceptanceTerms(taskId, input.resultId, actorId, false);
    assertAwaitingReview(terms.status);
    const settlement = settlementOf(terms);
    return resultOf(200, {
      taskId,
      resultId: input.resultId,
      status: "awaiting_review",
      statusVersion: terms.status_version,
      settlement,
    });
  }

  async accept(taskId: string, input: AcceptResultInput, actorId: string): Promise<TaskServiceResult> {
    const terms = await this.readAcceptanceTerms(taskId, input.resultId, actorId, true);
    let nextStatus: TaskStatus;
    try { nextStatus = transitionTaskStatus(terms.status, { type: "result_accepted" }); }
    catch (error) { throw executionDomainError(error); }
    const settlement = settlementOf(terms);
    assertFreshAcceptancePreview(input, terms.status_version, settlement);
    const gross = BigInt(settlement.grossAmountMinor);
    const fee = BigInt(settlement.platformFeeMinor);
    const agentAmount = BigInt(settlement.agentAmountMinor);
    const acceptance = await this.db.query<{ id: string; created_at: Date }>(
      `INSERT INTO task_acceptances (
         task_id,result_id,assignment_id,accepted_by,gross_amount_minor,platform_fee_minor,
         agent_amount_minor,fee_rule_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id::text,created_at`,
      [taskId, input.resultId, terms.assignment_id, actorId, gross.toString(), fee.toString(), agentAmount.toString(), terms.fee_version],
    );
    const acceptanceId = required(acceptance.rows[0], "ACCEPTANCE_NOT_INSERTED").id;
    await this.db.query(
      `INSERT INTO escrow_execution_jobs(
         task_id,source,source_ref,action,payee,agent_gross_amount_wei,fee_amount_wei,status,next_attempt_at
       ) VALUES ($1,'acceptance',$2,'release',$3,$4,$5,'pending',now())`,
      [taskId, acceptanceId, terms.payout_wallet_address.toLowerCase(), gross.toString(), fee.toString()],
    );
    const version = BigInt(terms.status_version) + 1n;
    await this.db.query("UPDATE tasks SET status=$2,status_version=$3,updated_at=now() WHERE id=$1", [taskId, nextStatus, version.toString()]);
    await this.writeEvent(taskId, version, "task.result_accepted", {
      status: nextStatus, resultId: input.resultId, ...settlement,
    });
    return resultOf(200, {
      acceptanceId,
      taskId, resultId: input.resultId, status: nextStatus, statusVersion: version.toString(),
      settlement,
    });
  }

  private async readAcceptanceTerms(
    taskId: string,
    resultId: string,
    actorId: string,
    lockTask: boolean,
  ): Promise<AcceptanceTermsRow> {
    const rows = await this.db.query<AcceptanceTermsRow>(
      `SELECT task.status,task.status_version::text,result.assignment_id::text,
              assignment.agreed_amount_minor::text,fee.version AS fee_version,
              fee.fee_basis_points,fee.gas_fallback_minor::text,
              intent.amount_wei::text AS escrow_amount_wei,agent.payout_wallet_address
         FROM tasks task
         JOIN task_results result ON result.task_id=task.id
         JOIN task_assignments assignment ON assignment.id=result.assignment_id AND assignment.status='accepted'
         JOIN agents agent ON agent.id=assignment.agent_id
         JOIN escrow_intents intent ON intent.task_id=result.task_id AND intent.status='confirmed'
         JOIN platform_fee_config fee ON fee.active=TRUE
        WHERE task.id=$1 AND lower(task.publisher_id)=lower($2)
          AND result.id=$3 AND result.is_latest=TRUE
        ${lockTask ? "FOR UPDATE OF task" : ""}`,
      [taskId, actorId, resultId],
    );
    const row = rows.rows[0];
    if (row === undefined) throw new ExecutionServiceError(404, "RESULT_NOT_FOUND", "结果不存在、无权访问或不是最新版本");
    return row;
  }

  async requestRework(taskId: string, input: ReworkInput, actorId: string): Promise<TaskServiceResult> {
    const taskRows = await this.db.query<{
      status: TaskStatus; status_version: string; deadline: Date; rework_count: string; max_rework_count: number;
    }>(
      `SELECT task.status,task.status_version::text,task.deadline,
              (SELECT count(*)::text FROM rework_requests WHERE task_id=task.id) AS rework_count,
              config.max_rework_count
         FROM tasks task CROSS JOIN rework_config config
        WHERE task.id=$1 AND lower(task.publisher_id)=lower($2) AND config.id=TRUE FOR UPDATE OF task`,
      [taskId, actorId],
    );
    const task = taskRows.rows[0];
    if (task === undefined) throw notFound();
    const result = await this.db.query<{ assignment_id: string }>(
      "SELECT assignment_id::text FROM task_results WHERE id=$1 AND task_id=$2 AND is_latest=TRUE",
      [input.resultId, taskId],
    );
    if (result.rows[0] === undefined) throw new ExecutionServiceError(404, "RESULT_NOT_FOUND", "结果不存在或不是最新版本");
    let next: ExecutionSnapshot;
    const requestNo = Number.parseInt(task.rework_count, 10) + 1;
    try {
      next = requestTaskRework({
        status: task.status, progress: 100, deadline: task.deadline,
        reworkCount: requestNo - 1, maxReworkCount: task.max_rework_count,
      }, "repository-generated");
    } catch (error) { throw executionDomainError(error); }
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO rework_requests(task_id,result_id,request_no,reason,requested_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id::text`,
      [taskId, input.resultId, requestNo, input.reason, actorId],
    );
    const requestId = required(inserted.rows[0], "REWORK_NOT_INSERTED").id;
    const version = BigInt(task.status_version) + 1n;
    await this.db.query("UPDATE tasks SET status=$2,status_version=$3,updated_at=now() WHERE id=$1", [taskId, next.status, version.toString()]);
    await this.db.query("UPDATE task_execution_state SET progress=95,updated_at=now() WHERE task_id=$1", [taskId]);
    // 返工原因必须进入发给已分配 Agent 的签名事件，否则 Agent 只能盲目重跑同一输入。
    // 该内容已经过 10–2,000 字符边界校验，仍不进入基础设施日志。
    await this.writeEvent(taskId, version, "task.rework_requested", {
      status: next.status, requestId, resultId: input.resultId, requestNo, reason: input.reason,
    });
    return resultOf(201, { taskId, requestId, requestNo, status: next.status, statusVersion: version.toString() });
  }

  async readStatus(taskId: string, actorId: string): Promise<TaskServiceResult> {
    const row = await this.db.query<{
      status: TaskStatus; status_version: string; progress: number | null; last_reported_at: Date | null;
      execution_state: "running" | "needs_input" | "failed" | null;
      estimated_completion_at: Date | null; attention_message: string | null;
      failure_code: string | null; failed_at: Date | null; event_id: string | null;
    }>(
      `SELECT task.status,task.status_version::text,state.progress,state.last_reported_at,
              state.execution_state,state.estimated_completion_at,state.attention_message,
              state.failure_code,state.failed_at,
              (SELECT max(id)::text FROM task_events WHERE task_id=task.id) AS event_id
         FROM tasks task LEFT JOIN task_execution_state state ON state.task_id=task.id
        WHERE task.id=$1 AND lower(task.publisher_id)=lower($2)`,
      [taskId, actorId],
    );
    const current = row.rows[0];
    if (current === undefined) throw notFound();
    return resultOf(200, {
      taskId, status: current.status, statusVersion: current.status_version,
      progress: current.progress ?? 0, lastReportedAt: current.last_reported_at?.toISOString() ?? null,
      executionState: current.execution_state ?? "running",
      estimatedCompletionAt: current.estimated_completion_at?.toISOString() ?? null,
      attentionMessage: current.attention_message,
      failureCode: current.failure_code,
      failedAt: current.failed_at?.toISOString() ?? null,
      lastEventId: current.event_id,
    });
  }

  private async lockExecution(taskId: string, assignmentId: string, agentId: string): Promise<LockedExecutionRow> {
    const rows = await this.db.query<LockedExecutionRow>(
      `SELECT task.status,task.status_version::text,task.deadline,
              assignment.status AS assignment_status,assignment.agent_id::text AS assigned_agent_id,
              state.progress,state.last_reported_at,
              (SELECT count(*)::text FROM rework_requests WHERE task_id=task.id) AS rework_count,
              config.max_rework_count
         FROM tasks task
         JOIN task_assignments assignment ON assignment.task_id=task.id AND assignment.id=$2
         CROSS JOIN rework_config config
         LEFT JOIN task_execution_state state ON state.task_id=task.id
        WHERE task.id=$1 AND assignment.agent_id=$3 AND config.id=TRUE FOR UPDATE OF task`,
      [taskId, assignmentId, agentId],
    );
    const row = rows.rows[0];
    if (row === undefined || row.assignment_status !== "accepted" || row.assigned_agent_id !== agentId) {
      throw new ExecutionServiceError(404, "ASSIGNMENT_NOT_FOUND", "任务分配不存在或无权上报");
    }
    return row;
  }

  private async callbackReplay(key: string, operation: string, taskId: string, assignmentId: string, fingerprint: string): Promise<TaskServiceResult | null> {
    const rows = await this.db.query<CallbackInboxRow>(
      `SELECT task_id::text,assignment_id::text,operation,request_fingerprint,response_snapshot
         FROM agent_callback_inbox WHERE idempotency_key=$1`,
      [key],
    );
    const row = rows.rows[0];
    if (row === undefined) return null;
    if (row.operation !== operation || row.task_id !== taskId || row.assignment_id !== assignmentId || row.request_fingerprint !== fingerprint) {
      throw new ExecutionServiceError(409, "IDEMPOTENCY_KEY_REUSED", "幂等键已用于其他回调内容");
    }
    return row.response_snapshot;
  }

  private async saveCallback(key: string, taskId: string, assignmentId: string, operation: string, fingerprint: string, result: TaskServiceResult): Promise<void> {
    await this.db.query(
      `INSERT INTO agent_callback_inbox(idempotency_key,task_id,assignment_id,operation,request_fingerprint,response_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [key, taskId, assignmentId, operation, fingerprint, JSON.stringify(result)],
    );
  }

  private async resultLimits(taskId: string): Promise<{
    maxFileSizeBytes: bigint;
    allowedFileMimeTypes: ReadonlySet<string>;
    allowedMimeTypes: ReadonlySet<string>;
  }> {
    const rows = await this.db.query<{ max_file_size_bytes: string | null; allowed_mime_types: string[] | null }>(
      `SELECT limits.max_file_size_bytes::text,limits.allowed_mime_types
         FROM tasks task LEFT JOIN attachment_category_limits limits ON limits.category_id=task.category_id
        WHERE task.id=$1`,
      [taskId],
    );
    const row = required(rows.rows[0], "TASK_RESULT_LIMITS_NOT_FOUND");
    const allowedFileMimeTypes = new Set((row.allowed_mime_types ?? [...DEFAULT_FILE_MIME_TYPES]).map((value) => value.toLocaleLowerCase()));
    return {
      maxFileSizeBytes: row.max_file_size_bytes === null ? DEFAULT_FILE_SIZE_BYTES : BigInt(row.max_file_size_bytes),
      allowedFileMimeTypes,
      allowedMimeTypes: new Set([...INLINE_MIME_TYPES, ...allowedFileMimeTypes]),
    };
  }

  private async assertPublisher(taskId: string, actorId: string): Promise<void> {
    const rows = await this.db.query("SELECT 1 FROM tasks WHERE id=$1 AND lower(publisher_id)=lower($2)", [taskId, actorId]);
    if (rows.rows[0] === undefined) throw notFound();
  }

  private writeEvent(taskId: string, version: bigint, eventType: string, payload: Record<string, unknown>): Promise<unknown> {
    return emitTaskEvent(this.db, { taskId, statusVersion: version, eventType, payload, createdAt: new Date() });
  }
}

function executionSnapshot(row: LockedExecutionRow): ExecutionSnapshot {
  return {
    status: row.status,
    progress: row.progress ?? 0,
    deadline: row.deadline,
    reworkCount: Number.parseInt(row.rework_count, 10),
    maxReworkCount: row.max_rework_count,
  };
}

function assertAwaitingReview(status: TaskStatus): void {
  if (status !== "awaiting_review") {
    throw new ExecutionServiceError(409, "TASK_NOT_AWAITING_REVIEW", "任务当前没有可验收的最新交付");
  }
}

function settlementOf(terms: AcceptanceTermsRow): SettlementTerms {
  const gross = BigInt(terms.agreed_amount_minor);
  if (gross > BigInt(terms.escrow_amount_wei)) {
    throw new ExecutionServiceError(409, "SETTLEMENT_EXCEEDS_ESCROW", "成交金额超过已确认托管金额");
  }
  const fee = calculatePlatformFee(gross, {
    feeBasisPoints: BigInt(terms.fee_basis_points),
    gasFallbackMinor: BigInt(terms.gas_fallback_minor),
  });
  return {
    grossAmountMinor: gross.toString(),
    platformFeeMinor: fee.toString(),
    agentAmountMinor: (gross - fee).toString(),
    feeRuleVersion: terms.fee_version,
  };
}

function assertFreshAcceptancePreview(input: AcceptResultInput, statusVersion: string, settlement: SettlementTerms): void {
  const expected = input.expectedSettlement;
  if (input.expectedStatusVersion !== statusVersion
    || expected.grossAmountMinor !== settlement.grossAmountMinor
    || expected.platformFeeMinor !== settlement.platformFeeMinor
    || expected.agentAmountMinor !== settlement.agentAmountMinor
    || expected.feeRuleVersion !== settlement.feeRuleVersion) {
    throw new ExecutionServiceError(
      409,
      "ACCEPTANCE_PREVIEW_STALE",
      "验收条件已经变化，请刷新金额明细后重新确认",
      true,
    );
  }
}

/**
 * Agent 接单确认与 Business 任务迁移跨越持久化 outbox 边界。已接单分配暂时搭配下面两种
 * 较早任务状态时，表示传播延迟而不是终态协议违规。把区别集中在这里，既允许回调客户端
 * 安全重试，也能继续正常拒绝到达验收或结算状态后的迟到回调。
 */
function assertExecutionReady(row: LockedExecutionRow): void {
  if (row.status === "matching" || row.status === "awaiting_agent_acceptance") {
    throw new ExecutionServiceError(
      409,
      "EXECUTION_NOT_READY",
      "Agent 已接单，任务执行状态仍在同步，请使用相同幂等键稍后重试",
      true,
    );
  }
}

function validateArtifacts(input: ResultSubmissionInput, allowedFiles: ReadonlySet<string>, maxFileSize: bigint): void {
  for (const artifact of input.results) {
    const mime = artifact.mimeType.toLocaleLowerCase();
    const allowed = artifact.kind === "inline" ? INLINE_MIME_TYPES : allowedFiles;
    if (!allowed.has(mime)) throw new ExecutionServiceError(422, "RESULT_FORMAT_INVALID", `不支持结果格式 ${mime}`);
    if (artifact.kind === "file" && BigInt(artifact.sizeBytes) > maxFileSize) {
      throw new ExecutionServiceError(422, "RESULT_FILE_TOO_LARGE", "结果文件超过分类大小限制");
    }
  }
}

function serializeResult(row: ResultRow, includeContent: boolean): Record<string, unknown> {
  return {
    id: row.id,
    submissionBatch: row.submission_batch,
    batchNo: row.batch_no,
    resultIndex: row.result_index,
    summary: row.summary,
    kind: row.artifact_kind,
    ...(includeContent ? { content: row.body_or_file_ref } : {}),
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    generatedAt: row.generated_at.toISOString(),
    note: row.note,
    isLatest: row.is_latest,
    submittedAt: row.submitted_at.toISOString(),
  };
}

function executionDomainError(error: unknown): ExecutionServiceError {
  const message = error instanceof Error ? error.message : "EXECUTION_INVALID";
  const map: Record<string, readonly [number, string]> = {
    TASK_NOT_EXECUTING: [409, "任务当前不在执行或返工状态"],
    PROGRESS_REGRESSION: [409, "执行进度不能倒退、越界或重复无效值"],
    RESULT_COUNT_INVALID: [422, "每批必须提交 1–3 个结果"],
    RESULT_FORMAT_INVALID: [422, "结果格式不在允许范围内"],
    REWORK_LIMIT_REACHED: [409, "返工次数已达到上限"],
    INVALID_TASK_TRANSITION: [409, "任务当前状态不能执行该操作"],
  };
  const mapped = map[message] ?? [409, "任务当前状态不能执行该操作"];
  return new ExecutionServiceError(mapped[0], message === "REWORK_LIMIT_REACHED" ? "REWORK_LIMIT_EXCEEDED" : message, mapped[1]);
}

function notFound(): ExecutionServiceError {
  return new ExecutionServiceError(404, "TASK_NOT_FOUND", "任务不存在或无权访问");
}
function resultOf(statusCode: number, body: Record<string, unknown>): TaskServiceResult { return { statusCode, body }; }
function required<Row>(row: Row | undefined, code: string): Row {
  if (row === undefined) throw new Error(code);
  return row;
}
