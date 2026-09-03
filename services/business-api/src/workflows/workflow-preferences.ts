import { z } from "zod";

import { PgAuditLogWriter } from "../audit/audit-log-writer";
import type { QueryExecutor } from "../db/pool";
import { Idempotency, PgIdempotencyStore, type ResponseSnapshot } from "../idempotency/idempotency-store";
import { MAX_TASK_BUDGET_MINOR, MIN_TASK_BUDGET_MINOR } from "../platform/mvp-money";
import { allocateWorkflowBudgetPreference } from "./workflow-planner";

const preferenceSchema = z.object({
  budgetPreferenceMinor: z.string().regex(/^\d+$/).nullable(),
}).strict();

export type WorkflowPreferenceResult = Readonly<{
  statusCode: 200;
  body: Readonly<{
    taskId: string;
    budgetPreferenceMinor: string | null;
    nodePreferences: readonly Readonly<{ nodeId: string; pricePreferenceMinor: string | null }>[];
  }>;
}>;

export class WorkflowPreferenceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code:
      | "VALIDATION_FAILED"
      | "IDEMPOTENCY_KEY_MISSING"
      | "TASK_NOT_FOUND"
      | "WORKFLOW_PREFERENCE_LOCKED"
      | "WORKFLOW_NOT_FOUND",
    message: string,
  ) {
    super(message);
  }
}

/**
 * 在候选选择前保存预算偏好并按节点权重拆分。偏好只写 price_preference 字段；函数
 * 从不触碰 budget_cap、agreed_amount 或 quoted_total，因而不能被误用为托管凭据。
 * 调用方必须传入事务内 client，使幂等记录、审计、run 和所有 node 同步提交。
 */
export async function updateOwnedWorkflowBudgetPreference(
  db: QueryExecutor,
  input: Readonly<{
    taskId: string;
    actorId: string;
    rawInput: unknown;
    idempotencyKey: string | undefined;
    updatedAt: Date;
  }>,
): Promise<WorkflowPreferenceResult> {
  const parsed = preferenceSchema.safeParse(input.rawInput);
  if (!parsed.success) {
    throw new WorkflowPreferenceError(422, "VALIDATION_FAILED", "预算上限格式不正确");
  }
  if (input.idempotencyKey === undefined || input.idempotencyKey.trim().length < 8 || input.idempotencyKey.length > 200) {
    throw new WorkflowPreferenceError(400, "IDEMPOTENCY_KEY_MISSING", "保存预算上限需要有效的幂等键");
  }
  const preference = parsed.data.budgetPreferenceMinor === null
    ? null
    : BigInt(parsed.data.budgetPreferenceMinor);
  if (preference !== null && (preference < MIN_TASK_BUDGET_MINOR || preference > MAX_TASK_BUDGET_MINOR)) {
    throw new WorkflowPreferenceError(422, "VALIDATION_FAILED", "预算上限须在 1–100,000 USDC 之间");
  }

  const idempotency = new Idempotency(new PgIdempotencyStore(db));
  const reservation = await idempotency.checkAndReserve(
    input.idempotencyKey,
    `workflow.budget-preference:${input.taskId}`,
  );
  if (reservation.existing !== null) return reservation.existing as WorkflowPreferenceResult;
  if (!reservation.reserved) {
    throw new WorkflowPreferenceError(409, "WORKFLOW_PREFERENCE_LOCKED", "相同预算设置正在处理中");
  }

  const runResult = await db.query<{
    id: string;
    publisher_id: string;
    task_status: string;
    run_status: string;
    budget_preference_minor: string | null;
  }>(
    `SELECT run.id::text,task.publisher_id,task.status AS task_status,run.status AS run_status,
            run.budget_preference_minor::text
       FROM tasks task
       JOIN task_workflow_runs run ON run.task_id=task.id
      WHERE task.id=$1
      FOR UPDATE OF task,run`,
    [input.taskId],
  );
  const run = runResult.rows[0];
  if (run === undefined || run.publisher_id.toLocaleLowerCase() !== input.actorId.toLocaleLowerCase()) {
    throw new WorkflowPreferenceError(404, "TASK_NOT_FOUND", "任务不存在或无权访问");
  }
  if (run.task_status !== "planning" || run.run_status !== "planning") {
    throw new WorkflowPreferenceError(409, "WORKFLOW_PREFERENCE_LOCKED", "报价确认后不能再修改预算偏好");
  }

  const nodesResult = await db.query<{
    id: string;
    price_preference_weight: number;
    selected_agent_id: string | null;
  }>(
    `SELECT id::text,price_preference_weight,selected_agent_id::text
       FROM task_workflow_nodes
      WHERE workflow_run_id=$1
      ORDER BY position_index,id
      FOR UPDATE`,
    [run.id],
  );
  if (nodesResult.rows.length === 0) {
    throw new WorkflowPreferenceError(409, "WORKFLOW_NOT_FOUND", "工作流尚未生成完整节点");
  }
  if (nodesResult.rows.some((node) => node.selected_agent_id !== null)) {
    throw new WorkflowPreferenceError(409, "WORKFLOW_PREFERENCE_LOCKED", "已有阶段选定 Agent，请先保持当前冻结报价");
  }

  const amounts = preference === null
    ? nodesResult.rows.map(() => null)
    : allocateWorkflowBudgetPreference(
      preference,
      nodesResult.rows.map((node) => node.price_preference_weight),
    );
  await db.query(
    `UPDATE task_workflow_runs
        SET budget_preference_minor=$2,version=version+1,updated_at=$3
      WHERE id=$1`,
    [run.id, preference?.toString() ?? null, input.updatedAt],
  );
  const nodePreferences: Array<{ nodeId: string; pricePreferenceMinor: string | null }> = [];
  for (const [index, node] of nodesResult.rows.entries()) {
    const amount = amounts[index] ?? null;
    await db.query(
      `UPDATE task_workflow_nodes
          SET price_preference_minor=$2,version=version+1,updated_at=$3
        WHERE id=$1`,
      [node.id, amount?.toString() ?? null, input.updatedAt],
    );
    nodePreferences.push({ nodeId: node.id, pricePreferenceMinor: amount?.toString() ?? null });
  }

  const result: WorkflowPreferenceResult = {
    statusCode: 200,
    body: {
      taskId: input.taskId,
      budgetPreferenceMinor: preference?.toString() ?? null,
      nodePreferences,
    },
  };
  await new PgAuditLogWriter(db).write({
    actorId: input.actorId,
    actorType: "publisher",
    action: "workflow.budget-preference.update",
    targetType: "workflow_run",
    targetId: run.id,
    beforeSummary: { budgetPreferenceMinor: run.budget_preference_minor },
    afterSummary: { budgetPreferenceMinor: result.body.budgetPreferenceMinor },
  });
  await idempotency.commit(input.idempotencyKey, result as ResponseSnapshot);
  return result;
}
