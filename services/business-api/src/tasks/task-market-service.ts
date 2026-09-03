import { z } from "zod";

import { TaskNotVisibleError } from "../platform/visibility";
import { TaskServiceError, type TaskServiceResult } from "./task-service";
import { IncompleteTaskProjectionError, projectStoredTask, projectStoredTaskOwnerSummary } from "./task-presentation";
import type { TaskReadRepository } from "./task-repository";

const taskStatusSchema = z.enum([
  "draft", "awaiting_escrow", "matching", "awaiting_agent_acceptance", "executing",
  "execution_failed", "awaiting_review", "rework", "pending_settlement", "settled", "disputed", "refunded", "timed_out",
]);
const uuidSchema = z.string().uuid();

/** 公开市场只输出 public 白名单投影；分页有硬上限，防止一次查询拖垮数据库。 */
export async function listTaskMarket(url: string, repository: TaskReadRepository): Promise<TaskServiceResult> {
  const params = new URL(url).searchParams;
  const keyword = (params.get("keyword") ?? "").trim();
  if ([...keyword].length > 100) throw new TaskServiceError(422, "VALIDATION_FAILED", "关键词最多 100 个字符");
  const categoryId = optionalParsed(params.get("category"), uuidSchema, "任务分类格式不正确");
  const status = optionalParsed(params.get("status"), taskStatusSchema, "任务状态筛选值不正确");
  const tag = normalizeOptional(params.get("tag"), 60, "标签最多 60 个字符");
  const limit = boundedInteger(params.get("limit"), 20, 1, 50, "limit");
  const offset = boundedInteger(params.get("offset"), 0, 0, 10_000, "offset");
  const page = await repository.listPublicMarket({ keyword, categoryId, tag, status, limit, offset });
  return {
    statusCode: 200,
    body: { tasks: page.tasks.map((task) => projectStoredTask(task, "public")), total: page.total, limit, offset },
  };
}

/**
 * 公开任务即使由发布者本人读取，也返回与市场列表相同的 public 字段集合；发布者的
 * 完整内容由 preview/工作台读取。私密任务则只允许发布者或当前已分配 Agent 的钱包。
 */
export async function getTaskDetail(
  taskId: string,
  actorId: string | null,
  repository: TaskReadRepository,
): Promise<TaskServiceResult> {
  const record = await repository.findForAudience(taskId);
  if (record === null) throw new TaskServiceError(404, "TASK_NOT_FOUND", "任务不存在或无权访问");
  try {
    if (record.task.visibility === "public") {
      return { statusCode: 200, body: { task: projectStoredTask(record.task, "public"), access: "public" } };
    }
    const normalizedActor = actorId?.toLocaleLowerCase() ?? null;
    const audience = normalizedActor !== null && record.task.publisherId.toLocaleLowerCase() === normalizedActor
      ? "publisher"
      : normalizedActor !== null && record.assignedProviderWallets.some((wallet) => wallet.toLocaleLowerCase() === normalizedActor)
        ? "assigned_agent"
        : "unauthenticated";
    return { statusCode: 200, body: { task: projectStoredTask(record.task, audience), access: audience } };
  } catch (error) {
    if (error instanceof TaskNotVisibleError || error instanceof IncompleteTaskProjectionError) {
      throw new TaskServiceError(404, "TASK_NOT_FOUND", "任务不存在或无权访问");
    }
    throw error;
  }
}

export async function getMarketStats(repository: TaskReadRepository): Promise<TaskServiceResult> {
  return { statusCode: 200, body: { source: "public_market", stats: await repository.readMarketStats() } };
}

export async function getPublisherTaskStats(actorId: string, repository: TaskReadRepository): Promise<TaskServiceResult> {
  return { statusCode: 200, body: { source: "publisher_tasks", stats: await repository.readPublisherStats(actorId) } };
}

/** 发布者任务列表包含草稿/私密任务，身份只能由 HTTP 层的 SIWE 会话注入。 */
export async function listPublisherTasks(
  actorId: string,
  url: string,
  repository: TaskReadRepository,
): Promise<TaskServiceResult> {
  const params = new URL(url).searchParams;
  const limit = boundedInteger(params.get("limit"), 50, 1, 100, "limit");
  const offset = boundedInteger(params.get("offset"), 0, 0, 10_000, "offset");
  const tasks = await repository.listOwnedTasks(actorId, limit, offset);
  return { statusCode: 200, body: { tasks: tasks.map(projectStoredTaskOwnerSummary), limit, offset } };
}

function optionalParsed<Schema extends z.ZodType>(raw: string | null, schema: Schema, message: string): z.output<Schema> | null {
  if (raw === null || raw.trim().length === 0) return null;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new TaskServiceError(422, "VALIDATION_FAILED", message);
  return parsed.data;
}

function normalizeOptional(raw: string | null, maxLength: number, message: string): string | null {
  if (raw === null || raw.trim().length === 0) return null;
  const normalized = raw.trim().toLocaleLowerCase();
  if ([...normalized].length > maxLength) throw new TaskServiceError(422, "VALIDATION_FAILED", message);
  return normalized;
}

function boundedInteger(raw: string | null, fallback: number, minimum: number, maximum: number, field: string): number {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new TaskServiceError(422, "VALIDATION_FAILED", `${field} 必须是整数`);
  const value = Number.parseInt(raw, 10);
  if (value < minimum || value > maximum) throw new TaskServiceError(422, "VALIDATION_FAILED", `${field} 超出允许范围`);
  return value;
}
