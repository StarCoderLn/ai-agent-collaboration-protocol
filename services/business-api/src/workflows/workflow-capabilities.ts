import { z } from "zod";

import { PgAuditLogWriter } from "../audit/audit-log-writer";
import type { QueryExecutor } from "../db/pool";
import { Idempotency, PgIdempotencyStore, type ResponseSnapshot } from "../idempotency/idempotency-store";
import {
  MAX_MATCHING_TAG_COUNT,
  normalizeMatchingTags,
  validateMatchingTags,
} from "../platform/matching-tags";

const capabilityInputSchema = z.object({
  tags: z.array(z.string()).max(MAX_MATCHING_TAG_COUNT),
}).strict();

export type WorkflowCapabilityResult = Readonly<{
  statusCode: 200;
  body: Readonly<{
    taskId: string;
    nodeId: string;
    tags: readonly string[];
  }>;
}>;

export class WorkflowCapabilityError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code:
      | "VALIDATION_FAILED"
      | "IDEMPOTENCY_KEY_MISSING"
      | "WORKFLOW_NODE_NOT_FOUND"
      | "WORKFLOW_CAPABILITY_LOCKED",
    message: string,
  ) {
    super(message);
  }
}

/**
 * 在冻结 Agent 报价前更新单个工作节点的能力要求。服务端负责同义词归一、禁用词
 * 校验、所有权和状态锁定；浏览器只负责收集用户意图，不能直接写入匹配标签。
 *
 * 该命令不生成候选，也不修改预算或报价。调用方在命令成功后显式请求重匹配，既让
 * 两个副作用可独立重试，也确保能力修改的审计事实不会因匹配引擎暂时不可用而丢失。
 */
export async function updateOwnedWorkflowNodeCapabilities(
  db: QueryExecutor,
  input: Readonly<{
    taskId: string;
    nodeId: string;
    actorId: string;
    rawInput: unknown;
    idempotencyKey: string | undefined;
    updatedAt: Date;
  }>,
): Promise<WorkflowCapabilityResult> {
  const parsed = capabilityInputSchema.safeParse(input.rawInput);
  if (!parsed.success) {
    throw new WorkflowCapabilityError(422, "VALIDATION_FAILED", `能力标签最多 ${MAX_MATCHING_TAG_COUNT} 个`);
  }
  if (input.idempotencyKey === undefined || input.idempotencyKey.trim().length < 8 || input.idempotencyKey.length > 200) {
    throw new WorkflowCapabilityError(400, "IDEMPOTENCY_KEY_MISSING", "调整能力需求需要有效的幂等键");
  }

  const idempotency = new Idempotency(new PgIdempotencyStore(db));
  const reservation = await idempotency.checkAndReserve(
    input.idempotencyKey,
    `workflow.capabilities:${input.taskId}:${input.nodeId}`,
  );
  if (reservation.existing !== null) return reservation.existing as WorkflowCapabilityResult;
  if (!reservation.reserved) {
    throw new WorkflowCapabilityError(409, "WORKFLOW_CAPABILITY_LOCKED", "相同能力设置正在处理中");
  }

  const nodeResult = await db.query<{
    workflow_run_id: string;
    publisher_id: string;
    task_status: string;
    run_status: string;
    node_status: string;
    selected_agent_id: string | null;
    version: string;
    tags: string[];
  }>(
    `SELECT node.workflow_run_id::text,task.publisher_id,task.status AS task_status,
            run.status AS run_status,node.status AS node_status,
            node.selected_agent_id::text,node.version::text,node.tags
       FROM tasks task
       JOIN task_workflow_runs run ON run.task_id=task.id
       JOIN task_workflow_nodes node ON node.workflow_run_id=run.id AND node.id=$2
      WHERE task.id=$1
      FOR UPDATE OF task,run,node`,
    [input.taskId, input.nodeId],
  );
  const node = nodeResult.rows[0];
  if (node === undefined || node.publisher_id.toLocaleLowerCase() !== input.actorId.toLocaleLowerCase()) {
    // 不区分“不存在”和“越权”，避免利用节点接口枚举私密任务与工作流结构。
    throw new WorkflowCapabilityError(404, "WORKFLOW_NODE_NOT_FOUND", "工作节点不存在或无权访问");
  }
  if (node.task_status !== "planning" || node.run_status !== "planning"
    || node.node_status !== "selecting" || node.selected_agent_id !== null) {
    throw new WorkflowCapabilityError(409, "WORKFLOW_CAPABILITY_LOCKED", "该阶段已冻结 Agent 报价，不能再调整能力需求");
  }

  const taxonomy = await db.query<{ canonical_name: string; synonyms: string[]; forbidden: boolean }>(
    "SELECT canonical_name,synonyms,forbidden FROM tags",
    [],
  );
  const canonicalByAlias = new Map<string, string>();
  const forbiddenTags = new Set<string>();
  for (const tag of taxonomy.rows) {
    const canonical = tag.canonical_name.toLocaleLowerCase();
    canonicalByAlias.set(canonical, canonical);
    for (const alias of tag.synonyms) canonicalByAlias.set(alias.toLocaleLowerCase(), canonical);
    if (tag.forbidden) forbiddenTags.add(canonical);
  }
  const normalizedTags = normalizeMatchingTags(parsed.data.tags, canonicalByAlias);
  const issues = validateMatchingTags(normalizedTags, forbiddenTags);
  if (issues.length > 0) {
    throw new WorkflowCapabilityError(422, "VALIDATION_FAILED", issues[0]?.message ?? "能力标签不符合平台规则");
  }

  const nextVersion = BigInt(node.version) + 1n;
  await db.query(
    `UPDATE task_workflow_nodes
        SET tags=$3,version=$4,updated_at=$5
      WHERE task_id=$1 AND id=$2`,
    [input.taskId, input.nodeId, normalizedTags, nextVersion.toString(), input.updatedAt],
  );
  await db.query(
    `INSERT INTO workflow_node_events(workflow_node_id,task_id,node_version,event_type,payload,created_at)
     VALUES ($1,$2,$3,'capability_requirements_updated',$4::jsonb,$5)`,
    [input.nodeId, input.taskId, nextVersion.toString(), JSON.stringify({ tags: normalizedTags }), input.updatedAt],
  );

  const result: WorkflowCapabilityResult = {
    statusCode: 200,
    body: { taskId: input.taskId, nodeId: input.nodeId, tags: normalizedTags },
  };
  await new PgAuditLogWriter(db).write({
    actorId: input.actorId,
    actorType: "publisher",
    action: "workflow.capabilities.update",
    targetType: "workflow_node",
    targetId: input.nodeId,
    beforeSummary: { tags: node.tags },
    afterSummary: { tags: normalizedTags },
  });
  await idempotency.commit(input.idempotencyKey, result as ResponseSnapshot);
  return result;
}
