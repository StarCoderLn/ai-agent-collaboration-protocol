import type { TaskStatus } from "./task-state";

export type TaskAudience = "publisher" | "assigned_agent" | "authorized_ops" | "public" | "unauthenticated";
export type AssignmentModeConfig =
  | Readonly<{ mode: "manual" }>
  | Readonly<{ mode: "automatic"; priceCapMinor: bigint; rankingBasis: string; fallbackOnFail: "manual" | "cancel" }>;
export type AcceptanceModeConfig =
  | Readonly<{ mode: "manual" }>
  | Readonly<{ mode: "automatic"; acceptorId: string; ruleVersion: string }>;

export type TaskRecordForAudience = Readonly<{
  id: string;
  publisherId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  deliverableFormat: string;
  categoryId: string;
  tags: readonly string[];
  visibility: "public" | "private";
  /** 规划期没有冻结报价；选完 Agent 后才回写准确金额。 */
  budgetMinMinor: bigint | null;
  budgetMaxMinor: bigint | null;
  currency: string;
  deadline: Date;
  requiredCapability: string;
  attachments: readonly Readonly<{ name: string; storageRef: string }>[];
  assignmentMode: AssignmentModeConfig;
  acceptanceMode: AcceptanceModeConfig;
  assignedAgentId: string | null;
  status: TaskStatus;
  createdAt: Date;
}>;

export class TaskNotVisibleError extends Error {
  readonly code = "TASK_NOT_FOUND";
  constructor() { super("任务不存在或无权查看"); }
}

/**
 * 市场列表、公开详情和发布预览必须调用同一个函数。公开字段采用显式白名单，新增
 * 内部字段默认不会外泄；私密任务对未授权访问统一返回“不存在”，不泄漏资源存在性。
 */
export function redactTaskForAudience(task: TaskRecordForAudience, audience: TaskAudience) {
  const hasFullAccess = audience === "publisher" || audience === "assigned_agent" || audience === "authorized_ops";
  if (task.visibility === "private" && !hasFullAccess) throw new TaskNotVisibleError();
  if (hasFullAccess) return { access: "full" as const, ...task };
  return {
    access: "public" as const,
    id: task.id,
    title: task.title,
    description: task.description,
    categoryId: task.categoryId,
    tags: task.tags,
    budgetMinMinor: task.budgetMinMinor,
    budgetMaxMinor: task.budgetMaxMinor,
    currency: task.currency,
    deadline: task.deadline,
    requiredCapability: task.requiredCapability,
    status: task.status,
    createdAt: task.createdAt,
  };
}

export function updateTaskModeSettings(input: Readonly<{
  status: TaskStatus;
  before: Readonly<{ visibility: "public" | "private"; assignmentMode: AssignmentModeConfig; acceptanceMode: AcceptanceModeConfig }>;
  after: Readonly<{ visibility: "public" | "private"; assignmentMode: AssignmentModeConfig; acceptanceMode: AcceptanceModeConfig }>;
}>) {
  if (isModeLocked(input.status)) throw new Error("TASK_MODE_LOCKED");
  validateAssignmentMode(input.after.assignmentMode);
  validateAcceptanceMode(input.after.acceptanceMode);
  return {
    settings: input.after,
    auditSummary: { before: input.before, after: input.after },
  } as const;
}

function isModeLocked(status: TaskStatus): boolean {
  return status === "executing" || status === "awaiting_review" || status === "rework"
    || status === "pending_settlement" || status === "settled" || status === "disputed"
    || status === "refunded" || status === "timed_out";
}

function validateAssignmentMode(mode: AssignmentModeConfig): void {
  if (mode.mode === "automatic" && (mode.priceCapMinor <= 0n || mode.rankingBasis.trim().length === 0)) {
    throw new Error("INVALID_AUTOMATIC_ASSIGNMENT_CONFIG");
  }
}

function validateAcceptanceMode(mode: AcceptanceModeConfig): void {
  if (mode.mode === "automatic" && (mode.acceptorId.trim().length === 0 || mode.ruleVersion.trim().length === 0)) {
    throw new Error("AUTOMATIC_ACCEPTOR_REQUIRED");
  }
}
