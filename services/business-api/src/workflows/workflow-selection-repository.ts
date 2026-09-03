import { z } from "zod";

import { PgAuditLogWriter } from "../audit/audit-log-writer";
import type { PoolLike, QueryExecutor } from "../db/pool";
import { withTransaction } from "../db/pool";
import { Idempotency, PgIdempotencyStore, type ResponseSnapshot } from "../idempotency/idempotency-store";
import { transitionTaskStatus } from "../platform/task-state";
import { emitTaskEvent } from "../tasks/task-event-repository";
import { transitionWorkflowNode } from "./workflow-state";

const frozenCandidateSchema = z
  .object({
    agentId: z.string().uuid(),
    quoteMinor: z.string().regex(/^\d+$/),
  })
  .passthrough();

type SelectionRow = {
  publisher_id: string;
  task_status: string;
  task_status_version: string;
  workflow_run_id: string;
  run_status: string;
  quoted_total_minor: string | null;
  node_status: "selecting" | "selected";
  node_version: string;
  selected_agent_id: string | null;
  agreed_amount_minor: string | null;
  distribution_id: string;
  candidates: unknown;
};

type EscrowSelectionLockRow = Readonly<{
  status:
    | "prepared"
    | "submitted"
    | "pending_confirmation"
    | "confirmed"
    | "partially_released"
    | "released"
    | "refunded"
    | "failed"
    | "needs_review";
  deposit_tx_hash: string | null;
  chain_event_exists: boolean;
}>;

export type WorkflowSelectionResult = Readonly<{
  statusCode: number;
  body: Readonly<{
    taskId: string;
    nodeId: string;
    agentId: string;
    agreedAmountMinor: string;
    selectedNodeCount: number;
    totalNodeCount: number;
    quotedTotalMinor: string | null;
    taskStatus: "planning" | "awaiting_escrow";
  }>;
}>;

export interface WorkflowSelectionRepository {
  select(
    input: Readonly<{
      taskId: string;
      nodeId: string;
      agentId: string;
      actorId: string;
      idempotencyKey: string;
      selectedAt: Date;
    }>,
  ): Promise<WorkflowSelectionResult>;
}

export type WorkflowSelectionErrorCode =
  | "SELECTION_IN_PROGRESS"
  | "WORKFLOW_NODE_NOT_FOUND"
  | "WORKFLOW_SELECTION_LOCKED"
  | "CANDIDATE_SNAPSHOT_INVALID"
  | "CANDIDATE_NOT_FOUND";

export class WorkflowSelectionRepositoryError extends Error {
  constructor(
    readonly code: WorkflowSelectionErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/**
 * 把“冻结节点报价”和“全部节点完成后开放托管”收进同一事务。调用方只提交候选 ID；
 * 报价、候选快照、总价和状态版本全部从加锁后的数据库事实计算，浏览器不能伪造金额。
 */
export class PgWorkflowSelectionRepository implements WorkflowSelectionRepository {
  constructor(private readonly pool: PoolLike) {}

  async select(
    input: Readonly<{
      taskId: string;
      nodeId: string;
      agentId: string;
      actorId: string;
      idempotencyKey: string;
      selectedAt: Date;
    }>,
  ): Promise<WorkflowSelectionResult> {
    return withTransaction(this.pool, async (client) => {
      const idempotency = new Idempotency(new PgIdempotencyStore(client));
      const reservation = await idempotency.checkAndReserve(
        input.idempotencyKey,
        `workflow.candidate.select:${input.taskId}:${input.nodeId}`,
      );
      if (reservation.existing !== null) return asSelectionResult(reservation.existing);
      if (!reservation.reserved) {
        throw new WorkflowSelectionRepositoryError("SELECTION_IN_PROGRESS", "相同选择正在处理中，请稍后刷新任务", 409);
      }

      const locked = await client.query<SelectionRow>(
        `SELECT task.publisher_id,task.status AS task_status,task.status_version::text AS task_status_version,
                run.id::text AS workflow_run_id,run.status AS run_status,
                run.quoted_total_minor::text,
                node.status AS node_status,node.version::text AS node_version,
                node.selected_agent_id::text,node.agreed_amount_minor::text,
                distribution.id::text AS distribution_id,distribution.candidates
           FROM tasks task
           JOIN task_workflow_runs run ON run.task_id=task.id
           JOIN task_workflow_nodes node ON node.workflow_run_id=run.id AND node.id=$2
           JOIN LATERAL (
             SELECT record.id,record.candidates
               FROM job_distribution_records record
              WHERE record.workflow_node_id=node.id
              ORDER BY record.created_at DESC,record.id DESC LIMIT 1
           ) distribution ON TRUE
          WHERE task.id=$1
          FOR UPDATE OF task,run,node,distribution`,
        [input.taskId, input.nodeId],
      );
      const row = locked.rows[0];
      if (row === undefined || row.publisher_id.toLowerCase() !== input.actorId.toLowerCase()) {
        throw new WorkflowSelectionRepositoryError("WORKFLOW_NODE_NOT_FOUND", "工作节点不存在或无权访问", 404);
      }
      const taskAllowsSelection = row.task_status === "planning" || row.task_status === "awaiting_escrow";
      const nodeAllowsSelection = row.node_status === "selecting" || row.node_status === "selected";
      if (!taskAllowsSelection || row.run_status !== "planning" || !nodeAllowsSelection) {
        throw new WorkflowSelectionRepositoryError(
          "WORKFLOW_SELECTION_LOCKED",
          "该工作流已结束选人，不能再修改报价",
          409,
        );
      }

      // task 行先于 intent 行加锁，与 prepareIntent 保持统一锁顺序。只有明确失败、没有
      // Deposit 哈希且链同步器从未看到事件的意图才可改选；Approve 只改变授权额度，
      // 不会移动 USDC，因此这种失败记录可以安全复用。任何已广播或链上未知状态继续锁定。
      const escrowLock = await client.query<EscrowSelectionLockRow>(
        `SELECT intent.status,intent.deposit_tx_hash,
                EXISTS(SELECT 1 FROM escrow_sync sync WHERE sync.task_id=intent.task_id) AS chain_event_exists
           FROM escrow_intents intent WHERE intent.task_id=$1 FOR UPDATE`,
        [input.taskId],
      );
      const escrow = escrowLock.rows[0] ?? null;
      const safelyFailedBeforeBroadcast =
        escrow !== null && escrow.status === "failed" && escrow.deposit_tx_hash === null && !escrow.chain_event_exists;
      if (row.task_status === "awaiting_escrow" && escrow !== null && !safelyFailedBeforeBroadcast) {
        throw new WorkflowSelectionRepositoryError(
          "WORKFLOW_SELECTION_LOCKED",
          "USDC 存入交易可能已经开始；请先确认托管失败且没有待处理交易",
          409,
        );
      }
      const parsedCandidates = z.array(frozenCandidateSchema).safeParse(row.candidates);
      if (!parsedCandidates.success) {
        throw new WorkflowSelectionRepositoryError("CANDIDATE_SNAPSHOT_INVALID", "候选快照损坏，无法安全冻结报价", 409);
      }
      const candidate = parsedCandidates.data.find((item) => item.agentId === input.agentId);
      if (candidate === undefined || BigInt(candidate.quoteMinor) <= 0n) {
        throw new WorkflowSelectionRepositoryError("CANDIDATE_NOT_FOUND", "该 Agent 不在当前有效候选中", 409);
      }

      // 用户重复点击当前选择时直接返回数据库事实。这个分支仍提交幂等快照，但不会增加
      // 节点/任务版本，也不会生成“重新选择”事件，避免前端重试制造虚假审计记录。
      if (row.selected_agent_id === input.agentId && row.agreed_amount_minor === candidate.quoteMinor) {
        const currentTotals = await readWorkflowTotals(client, row.workflow_run_id);
        const unchangedResult: WorkflowSelectionResult = {
          statusCode: 200,
          body: {
            taskId: input.taskId,
            nodeId: input.nodeId,
            agentId: input.agentId,
            agreedAmountMinor: candidate.quoteMinor,
            selectedNodeCount: Number(currentTotals.selected_count),
            totalNodeCount: Number(currentTotals.total_count),
            quotedTotalMinor: row.quoted_total_minor,
            taskStatus: row.task_status as "planning" | "awaiting_escrow",
          },
        };
        await idempotency.commit(input.idempotencyKey, unchangedResult);
        return unchangedResult;
      }

      const replacingSelection = row.selected_agent_id !== null;
      const nextNodeStatus =
        row.node_status === "selecting"
          ? transitionWorkflowNode("selecting", { type: "candidate_selected" })
          : "selected";
      const nextNodeVersion = BigInt(row.node_version) + 1n;
      await client.query(
        `UPDATE task_workflow_nodes
            SET selected_agent_id=$3,selection_record_id=$4,agreed_amount_minor=$5,
                budget_cap_minor=$5,status=$6,version=$7,updated_at=$8
          WHERE id=$1 AND task_id=$2`,
        [
          input.nodeId,
          input.taskId,
          input.agentId,
          row.distribution_id,
          candidate.quoteMinor,
          nextNodeStatus,
          nextNodeVersion.toString(),
          input.selectedAt,
        ],
      );
      await client.query("UPDATE job_distribution_records SET final_selection_agent_id=$2 WHERE id=$1", [
        row.distribution_id,
        input.agentId,
      ]);
      await client.query(
        `INSERT INTO workflow_node_events(workflow_node_id,task_id,node_version,event_type,payload,created_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
        [
          input.nodeId,
          input.taskId,
          nextNodeVersion.toString(),
          replacingSelection ? "candidate_reselected" : "candidate_selected",
          JSON.stringify({
            agentId: input.agentId,
            previousAgentId: row.selected_agent_id,
            distributionRecordId: row.distribution_id,
            agreedAmountMinor: candidate.quoteMinor,
            previousAgreedAmountMinor: row.agreed_amount_minor,
          }),
          input.selectedAt,
        ],
      );

      const total = await readWorkflowTotals(client, row.workflow_run_id);
      const selectedCount = Number(total.selected_count);
      const totalCount = Number(total.total_count);
      const allSelected = totalCount > 0 && selectedCount === totalCount;
      let taskStatus: "planning" | "awaiting_escrow" = "planning";
      let quotedTotalMinor: string | null = null;
      let nextTaskVersion = BigInt(row.task_status_version);
      if (allSelected) {
        const quote = BigInt(total.quoted_total_minor);
        quotedTotalMinor = quote.toString();
        nextTaskVersion += 1n;
        if (row.task_status === "planning") {
          const transitioned = transitionTaskStatus("planning", {
            type: "workflow_quote_confirmed",
            amountMinor: quote,
          });
          if (transitioned !== "awaiting_escrow") throw new Error("WORKFLOW_QUOTE_TRANSITION_INVALID");
          taskStatus = transitioned;
        } else {
          // 托管前改选只修订报价，不把任务退回 planning。这样生命周期仍然只有一个
          // “待托管”阶段，页面和资金仓储无需理解额外的临时状态。
          taskStatus = "awaiting_escrow";
        }
        await client.query(
          `UPDATE task_workflow_runs
              SET quoted_total_minor=$2,total_budget_minor=$2,refundable_amount_minor=$2,
                  quote_confirmed_at=$3,version=version+1,updated_at=$3
            WHERE id=$1`,
          [row.workflow_run_id, quotedTotalMinor, input.selectedAt],
        );
        await client.query(
          `UPDATE tasks
              SET status=$2,status_version=$3,pricing_type='fixed',
                  budget_min_minor=$4,budget_max_minor=$4,updated_at=$5
            WHERE id=$1`,
          [input.taskId, taskStatus, nextTaskVersion.toString(), quotedTotalMinor, input.selectedAt],
        );
        if (safelyFailedBeforeBroadcast) {
          // 失败意图仍保留链配置和 taskKey，但金额必须与新选择同步更新。后续 retry
          // 只会基于这个新金额重新生成 Approve/Deposit，旧页面按旧金额登记会被拒绝。
          await client.query(
            `UPDATE escrow_intents
                SET amount_minor=$2,failure_reason='Agent 已更换，请重新开始托管',updated_at=$3
              WHERE task_id=$1 AND status='failed' AND deposit_tx_hash IS NULL`,
            [input.taskId, quotedTotalMinor, input.selectedAt],
          );
        }
        await emitTaskEvent(client, {
          taskId: input.taskId,
          statusVersion: nextTaskVersion,
          eventType: row.task_status === "planning" ? "task.workflow_quote_confirmed" : "task.workflow_quote_revised",
          payload:
            row.task_status === "planning"
              ? { quotedTotalMinor, selectedNodeCount: selectedCount }
              : {
                  nodeId: input.nodeId,
                  previousAgentId: row.selected_agent_id,
                  agentId: input.agentId,
                  previousQuotedTotalMinor: row.quoted_total_minor,
                  quotedTotalMinor,
                  selectedNodeCount: selectedCount,
                },
          createdAt: input.selectedAt,
        });
      }

      const result: WorkflowSelectionResult = {
        statusCode: 200,
        body: {
          taskId: input.taskId,
          nodeId: input.nodeId,
          agentId: input.agentId,
          agreedAmountMinor: candidate.quoteMinor,
          selectedNodeCount: selectedCount,
          totalNodeCount: totalCount,
          quotedTotalMinor,
          taskStatus,
        },
      };
      await new PgAuditLogWriter(client).write({
        actorId: input.actorId,
        actorType: "publisher",
        action: replacingSelection ? "workflow.candidate.replace" : "workflow.candidate.select",
        targetType: "workflow_node",
        targetId: input.nodeId,
        beforeSummary: {
          nodeStatus: row.node_status,
          agentId: row.selected_agent_id,
          agreedAmountMinor: row.agreed_amount_minor,
          taskStatus: row.task_status,
          quotedTotalMinor: row.quoted_total_minor,
        },
        afterSummary: {
          nodeStatus: nextNodeStatus,
          agentId: input.agentId,
          agreedAmountMinor: candidate.quoteMinor,
          taskStatus,
          quotedTotalMinor,
        },
      });
      await idempotency.commit(input.idempotencyKey, result);
      return result;
    });
  }
}

function asSelectionResult(snapshot: ResponseSnapshot): WorkflowSelectionResult {
  return snapshot as WorkflowSelectionResult;
}

function required<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new Error(code);
  return value;
}

type WorkflowTotals = Readonly<{
  selected_count: string;
  total_count: string;
  quoted_total_minor: string;
}>;

/** 总报价始终由已冻结节点金额求和，禁止调用方维护第二份容易漂移的累计值。 */
async function readWorkflowTotals(db: QueryExecutor, workflowRunId: string): Promise<WorkflowTotals> {
  const totals = await db.query<WorkflowTotals>(
    `SELECT count(*) FILTER (WHERE selected_agent_id IS NOT NULL)::text AS selected_count,
            count(*)::text AS total_count,
            COALESCE(sum(agreed_amount_minor),0)::text AS quoted_total_minor
       FROM task_workflow_nodes WHERE workflow_run_id=$1`,
    [workflowRunId],
  );
  return required(totals.rows[0], "WORKFLOW_TOTAL_NOT_FOUND");
}
