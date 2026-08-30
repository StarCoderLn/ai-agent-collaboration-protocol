import { MVP_CURRENCY } from "./mvp-money";
import { normalizeMatchingTags, validateMatchingTags } from "./matching-tags";

export type TaskPricing =
  | Readonly<{ type: "fixed"; amountMinor: bigint }>
  | Readonly<{ type: "range"; minAmountMinor: bigint; maxAmountMinor: bigint }>;

export type TaskAttachment = Readonly<{
  name: string;
  mimeType: string;
  sizeBytes: bigint;
  storageRef: string;
}>;

export type AttachmentLimit = Readonly<{
  maxFiles: number;
  maxFileSizeBytes: bigint;
  allowedMimeTypes: ReadonlySet<string>;
}>;

export type TaskValidationConfig = Readonly<{
  minExecutionPeriodMs: number;
  minBudgetMinor: bigint;
  maxBudgetMinor: bigint;
  forbiddenTags: ReadonlySet<string>;
  attachmentLimit: AttachmentLimit;
}>;

export type TaskDraft = Readonly<{
  title: string;
  description: string;
  acceptanceCriteria: string;
  deliverableFormat: string;
  categoryId: string;
  tags: readonly string[];
  pricing: TaskPricing;
  currency: string;
  deadline: Date;
  requiredCapability: string;
  attachments: readonly TaskAttachment[];
}>;

export type EditableTaskDraft = Readonly<Omit<TaskDraft, "categoryId" | "pricing" | "deadline"> & {
  categoryId: string | null;
  pricing: TaskPricing | null;
  deadline: Date | null;
}>;

export type TaskFieldError = Readonly<{ field: string; code: string; message: string }>;

export type CompleteTaskDraftResult =
  | Readonly<{ success: true; draft: TaskDraft }>
  | Readonly<{ success: false; issues: readonly TaskFieldError[] }>;

const EXECUTABLE_MIME_TYPES = new Set([
  "application/x-msdownload",
  "application/x-executable",
  "application/x-mach-binary",
  "application/java-archive",
  "application/x-sh",
]);
const EXECUTABLE_EXTENSIONS = /\.(?:exe|dll|dmg|pkg|app|sh|bat|cmd|com|msi|jar)$/i;

/**
 * 发布、编辑和附件上传共用的校验入口。所有可调整阈值都由调用方从数据库配置传入；
 * 可执行文件禁令是跨分类安全红线，不能被某个分类的 MIME 白名单放开。
 */
export function validateTaskDraft(input: TaskDraft, now: Date, config: TaskValidationConfig): readonly TaskFieldError[] {
  const errors: TaskFieldError[] = [];
  if ([...input.title.trim()].length < 6) errors.push(error("title", "TITLE_TOO_SHORT", "标题至少需要 6 个字符"));
  // 用户可以只用标题启动需求澄清流程；说明字段只保证非空，短需求的结构化与补全由
  // 首个 PRD Agent 负责，不能把 Agent 的工作提前转嫁给任务发布者。
  if (input.description.trim().length === 0) errors.push(error("description", "DESCRIPTION_REQUIRED", "任务说明不能为空"));
  if (input.acceptanceCriteria.trim().length < 10) errors.push(error("acceptanceCriteria", "ACCEPTANCE_CRITERIA_REQUIRED", "请提供可量化的验收标准"));
  if (input.deliverableFormat.trim().length === 0) errors.push(error("deliverableFormat", "DELIVERABLE_FORMAT_REQUIRED", "请填写交付格式"));
  if (input.requiredCapability.trim().length === 0) errors.push(error("requiredCapability", "REQUIRED_CAPABILITY_REQUIRED", "请填写所需能力"));
  if (input.currency !== MVP_CURRENCY) {
    errors.push(error("currency", "CURRENCY_UNSUPPORTED", "任务预算、报价与托管仅支持 USDC"));
  }
  if (input.deadline.getTime() < now.getTime() + config.minExecutionPeriodMs) {
    errors.push(error("deadline", "DEADLINE_TOO_SOON", `截止时间至少应晚于当前 ${Math.ceil(config.minExecutionPeriodMs / 60_000)} 分钟`));
  }
  validatePricing(input.pricing, config, errors);
  errors.push(...validateMatchingTags(input.tags, config.forbiddenTags)
    .map((issue) => error("tags", issue.code, issue.message)));
  errors.push(...validateTaskAttachments(input.attachments, config.attachmentLimit));
  return errors;
}

/**
 * 草稿到可发布任务只有这一处类型收窄。预览、市场投影和提交命令共用它，避免某个
 * 入口忘记检查分类、预算或截止时间就把半成品当成正式任务。
 */
export function inspectTaskDraftCompleteness(input: EditableTaskDraft): CompleteTaskDraftResult {
  const issues: TaskFieldError[] = [];
  if (input.categoryId === null) issues.push(error("categoryId", "CATEGORY_REQUIRED", "请选择任务分类"));
  if (input.pricing === null) issues.push(error("pricing", "PRICING_REQUIRED", "请填写任务预算"));
  if (input.deadline === null) issues.push(error("deadline", "DEADLINE_REQUIRED", "请填写任务截止时间"));
  if (issues.length > 0 || input.categoryId === null || input.pricing === null || input.deadline === null) {
    return { success: false, issues };
  }
  return { success: true, draft: { ...input, categoryId: input.categoryId, pricing: input.pricing, deadline: input.deadline } };
}

export function requireCompleteTaskDraft(input: EditableTaskDraft): TaskDraft {
  const result = inspectTaskDraftCompleteness(input);
  if (!result.success) {
    const incomplete = new Error("INCOMPLETE_TASK_DRAFT");
    Object.assign(incomplete, { issues: result.issues });
    throw incomplete;
  }
  return result.draft;
}

/** 标签同义词只在这个边界归一化，后续匹配、展示和持久化都消费 canonical 值。 */
export function normalizeTaskTags(
  tags: readonly string[],
  canonicalByAlias: ReadonlyMap<string, string>,
): readonly string[] {
  return normalizeMatchingTags(tags, canonicalByAlias);
}

/**
 * 附件上传和最终发布共用同一校验。这个公开入口让草稿在已有分类时立即拒绝超限或
 * 可执行文件，而不是等用户最后提交才发现附件不可用。
 */
export function validateTaskAttachments(
  attachments: readonly TaskAttachment[],
  limit: AttachmentLimit,
): readonly TaskFieldError[] {
  const errors: TaskFieldError[] = [];
  validateAttachments(attachments, limit, errors);
  return errors;
}

function validatePricing(pricing: TaskPricing, config: TaskValidationConfig, errors: TaskFieldError[]): void {
  if (pricing.type === "fixed") {
    if (pricing.amountMinor < config.minBudgetMinor || pricing.amountMinor > config.maxBudgetMinor) {
      errors.push(error("pricing.amountMinor", "BUDGET_OUT_OF_RANGE", "固定预算不在平台允许范围内"));
    }
    return;
  }
  if (pricing.minAmountMinor < config.minBudgetMinor || pricing.maxAmountMinor > config.maxBudgetMinor
    || pricing.minAmountMinor > pricing.maxAmountMinor) {
    errors.push(error("pricing", "BUDGET_RANGE_INVALID", "预算区间无效或超出平台允许范围"));
  }
}

function validateAttachments(attachments: readonly TaskAttachment[], limit: AttachmentLimit, errors: TaskFieldError[]): void {
  if (attachments.length > limit.maxFiles) {
    errors.push(error("attachments", "ATTACHMENT_COUNT_EXCEEDED", `该分类最多允许 ${limit.maxFiles} 个附件`));
  }
  for (const [index, attachment] of attachments.entries()) {
    const field = `attachments.${index}`;
    if (attachment.sizeBytes <= 0n || attachment.sizeBytes > limit.maxFileSizeBytes) {
      errors.push(error(field, "ATTACHMENT_SIZE_EXCEEDED", `该分类单个附件上限为 ${formatBytes(limit.maxFileSizeBytes)}`));
    }
    const mimeType = attachment.mimeType.toLocaleLowerCase();
    if (EXECUTABLE_MIME_TYPES.has(mimeType) || EXECUTABLE_EXTENSIONS.test(attachment.name)) {
      errors.push(error(field, "EXECUTABLE_ATTACHMENT_FORBIDDEN", "平台不接收可执行文件"));
    } else if (!limit.allowedMimeTypes.has(mimeType)) {
      errors.push(error(field, "ATTACHMENT_TYPE_NOT_ALLOWED", `该分类不支持 ${attachment.mimeType} 文件`));
    }
  }
}

function formatBytes(bytes: bigint): string {
  const mebibytes = Number(bytes / 1_048_576n);
  return mebibytes >= 1_024 ? `${(mebibytes / 1_024).toFixed(0)}GB` : `${mebibytes}MB`;
}

function error(field: string, code: string, message: string): TaskFieldError {
  return { field, code, message };
}
