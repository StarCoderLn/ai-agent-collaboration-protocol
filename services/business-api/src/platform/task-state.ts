/**
 * Feature 4–13 共用的任务主状态机。任何仓储写路径必须先调用本模块；数据库中的
 * `tasks.status` 只是持久化结果，不允许各 Route Handler 自行拼接 UPDATE 状态。
 */
export type TaskStatus =
  | "draft" | "awaiting_escrow" | "matching" | "awaiting_agent_acceptance"
  | "executing" | "awaiting_review" | "rework" | "pending_settlement"
  | "execution_failed" | "settled" | "disputed" | "refunded" | "timed_out";

export type TaskTransitionEvent =
  | { type: "submit" }
  | { type: "escrow_confirmed"; txHash: string }
  | { type: "assignment_locked"; assignmentId: string }
  | { type: "agent_accepted"; assignmentId: string }
  | { type: "assignment_failed" }
  | { type: "execution_retry_requested"; assignmentId: string }
  | { type: "execution_failed"; failureCode: "MODEL_EXECUTION_FAILED" }
  | { type: "result_submitted"; resultId: string }
  | { type: "rework_requested"; requestId: string }
  | { type: "result_accepted" }
  | { type: "settlement_confirmed"; txHash: string }
  | { type: "workflow_settlement_confirmed"; txHash: string }
  | { type: "dispute_opened"; disputeId: string }
  | { type: "arbitration_release_confirmed"; txHash: string }
  | { type: "arbitration_refund_confirmed"; txHash: string }
  | { type: "deadline_elapsed" };

const transitions: Readonly<Record<TaskStatus, Readonly<Partial<Record<TaskTransitionEvent["type"], TaskStatus>>>>> = {
  draft: { submit: "awaiting_escrow" },
  awaiting_escrow: { escrow_confirmed: "matching" },
  // 正式工作流的细粒度执行状态由 task_workflow_runs/nodes 承载；tasks.status 在该模式
  // 下只是市场与通知投影，因此最终链上结算可以从 matching 投影直接进入 settled。
  matching: { assignment_locked: "awaiting_agent_acceptance", workflow_settlement_confirmed: "settled", deadline_elapsed: "timed_out" },
  awaiting_agent_acceptance: { agent_accepted: "executing", assignment_failed: "matching", deadline_elapsed: "timed_out" },
  // 执行中也允许争议：例如 Agent 已声明开始执行但长期不响应。争议一旦创建，
  // 后续资金操作只能由仲裁路径触发，不能继续走普通超时结算。
  executing: { result_submitted: "awaiting_review", execution_failed: "execution_failed", workflow_settlement_confirmed: "settled", deadline_elapsed: "timed_out", dispute_opened: "disputed" },
  awaiting_review: { rework_requested: "rework", result_accepted: "pending_settlement", workflow_settlement_confirmed: "settled", dispute_opened: "disputed" },
  rework: { result_submitted: "awaiting_review", execution_failed: "execution_failed", deadline_elapsed: "timed_out" },
  pending_settlement: { settlement_confirmed: "settled", workflow_settlement_confirmed: "settled", dispute_opened: "disputed" },
  // 执行失败不会自动退款或释放托管资金；由双方举证后通过争议状态机决定资金去向。
  // 重新执行必须先由分发服务取消旧的 accepted assignment 并写入持久化事实；状态机
  // 只消费该事实回到 matching，不允许 Route Handler 直接把失败状态改回执行中。
  execution_failed: { execution_retry_requested: "matching", dispute_opened: "disputed" },
  settled: {},
  disputed: { arbitration_release_confirmed: "settled", arbitration_refund_confirmed: "refunded" },
  refunded: {},
  // 超时后的资金仍可能需要双方举证和人工裁决，因此它不是争议入口的终态。
  timed_out: { dispute_opened: "disputed" },
};

export class InvalidTaskTransitionError extends Error {
  readonly code = "INVALID_TASK_TRANSITION";
  constructor(readonly from: TaskStatus, readonly event: TaskTransitionEvent) { super(`${from} cannot apply ${event.type}`); }
}

export function transitionTaskStatus(from: TaskStatus, event: TaskTransitionEvent): TaskStatus {
  const next = transitions[from][event.type];
  if (next === undefined) throw new InvalidTaskTransitionError(from, event);
  return next;
}

export type PlatformFeeConfig = { feeBasisPoints: bigint; gasFallbackMinor: bigint };

/** 唯一手续费算法，预览与结算都只调用这里；金额全程使用最小单位 bigint。 */
export function calculatePlatformFee(amountMinor: bigint, config: PlatformFeeConfig): bigint {
  if (amountMinor <= 0n || config.feeBasisPoints < 0n || config.feeBasisPoints > 10_000n || config.gasFallbackMinor < 0n) throw new Error("INVALID_FEE_INPUT");
  const proportional = (amountMinor * config.feeBasisPoints + 9_999n) / 10_000n;
  const fee = proportional > config.gasFallbackMinor ? proportional : config.gasFallbackMinor;
  return fee > amountMinor ? amountMinor : fee;
}

export type TaskValidationInput = { title: string; description: string; tags: readonly string[]; budgetMinor: bigint; deadline: Date };
export type TaskValidationConfig = { minExecutionPeriodMs: number; minBudgetMinor: bigint; maxBudgetMinor: bigint; forbiddenTags: ReadonlySet<string> };
export function validateTaskInput(input: TaskValidationInput, now: Date, config: TaskValidationConfig): readonly string[] {
  const errors: string[] = [];
  if ([...input.title].length < 6) errors.push("TITLE_TOO_SHORT");
  if ([...input.description].length < 30) errors.push("DESCRIPTION_TOO_SHORT");
  if (input.budgetMinor < config.minBudgetMinor || input.budgetMinor > config.maxBudgetMinor) errors.push("BUDGET_OUT_OF_RANGE");
  if (input.deadline.getTime() < now.getTime() + config.minExecutionPeriodMs) errors.push("DEADLINE_TOO_SOON");
  if (input.tags.some((tag) => config.forbiddenTags.has(tag))) errors.push("FORBIDDEN_TAG");
  return errors;
}

export function shouldTimeout(status: TaskStatus, deadline: Date, now: Date): boolean {
  // Feature 11 v3 明确只扫描待匹配、待接单、执行中；返工拥有独立时限配置，不能
  // 被原始任务 deadline 的扫描器误伤，待托管则由链上确认超时负责。
  return deadline.getTime() <= now.getTime() && (status === "matching" || status === "awaiting_agent_acceptance" || status === "executing");
}
