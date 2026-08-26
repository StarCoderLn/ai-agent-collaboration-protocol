import { z } from "zod";

import { MVP_CURRENCY } from "../platform/mvp-money";
import { MAX_MATCHING_TAG_COUNT, MAX_MATCHING_TAG_LENGTH } from "../platform/matching-tags";
import type { AcceptanceModeConfig, AssignmentModeConfig } from "../platform/visibility";
import type { EditableTaskDraft, TaskAttachment, TaskPricing } from "../platform/task-validation";

const MAX_PG_BIGINT = 9_223_372_036_854_775_807n;
const integerString = z.string().regex(/^\d+$/).refine((value) => BigInt(value) <= MAX_PG_BIGINT, "金额超出 BIGINT 范围");
const uuid = z.string().uuid();

const attachmentSchema = z.object({
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(150),
  sizeBytes: integerString,
  storageRef: z.string().trim().min(1).max(2_000),
}).strict();

const pricingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fixed"), amountMinor: integerString }).strict(),
  z.object({ type: z.literal("range"), minAmountMinor: integerString, maxAmountMinor: integerString }).strict(),
]);

const assignmentModeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("manual") }).strict(),
  z.object({
    mode: z.literal("automatic"),
    priceCapMinor: integerString,
    rankingBasis: z.string().trim().min(1).max(200),
    fallbackOnFail: z.enum(["manual", "cancel"]),
  }).strict(),
]);

const acceptanceModeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("manual") }).strict(),
  z.object({
    mode: z.literal("automatic"),
    acceptorId: z.string().trim().min(1).max(200),
    ruleVersion: z.string().trim().min(1).max(100),
  }).strict(),
]);

/**
 * 草稿边界故意允许字段缺失：用户应当能先保存标题，再逐步补齐预算、分类和截止时间。
 * 字段的格式只要出现就必须正确；“是否已经完整、能否发布”由提交命令统一判断。
 */
const taskDraftPatchSchema = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(20_000).optional(),
  acceptanceCriteria: z.string().max(10_000).optional(),
  deliverableFormat: z.string().max(2_000).optional(),
  categoryId: uuid.optional(),
  tags: z.array(z.string().trim().min(1).max(MAX_MATCHING_TAG_LENGTH)).max(MAX_MATCHING_TAG_COUNT).optional(),
  pricing: pricingSchema.optional(),
  currency: z.literal(MVP_CURRENCY).optional(),
  deadline: z.string().datetime({ offset: true }).optional(),
  requiredCapability: z.string().max(2_000).optional(),
  attachments: z.array(attachmentSchema).max(20).optional(),
  visibility: z.enum(["public", "private"]).optional(),
  assignmentMode: assignmentModeSchema.optional(),
  acceptanceMode: acceptanceModeSchema.optional(),
}).strict();

const taskModeSettingsSchema = z.object({
  visibility: z.enum(["public", "private"]).optional(),
  assignmentMode: assignmentModeSchema.optional(),
  acceptanceMode: acceptanceModeSchema.optional(),
}).strict().refine(
  (value) => value.visibility !== undefined || value.assignmentMode !== undefined || value.acceptanceMode !== undefined,
  "至少提交一个模式设置",
);

// 资金已经托管后，预算、币种和任务正文不能再通过“重新匹配”入口改写。这里仅开放
// 会影响候选资格、但不会改变托管金额或交付契约的三个字段。
const taskMatchCriteriaPatchSchema = z.object({
  categoryId: uuid.optional(),
  tags: z.array(z.string().trim().min(1).max(MAX_MATCHING_TAG_LENGTH)).max(MAX_MATCHING_TAG_COUNT).optional(),
  deadline: z.string().datetime({ offset: true }).optional(),
}).strict().refine(
  (value) => value.categoryId !== undefined || value.tags !== undefined || value.deadline !== undefined,
  "至少提交一个匹配条件",
);

export type ParsedTaskDraftInput = Readonly<{
  draft: EditableTaskDraft;
  visibility: "public" | "private";
  assignmentMode: AssignmentModeConfig;
  acceptanceMode: AcceptanceModeConfig;
}>;

export type ParsedTaskDraftPatch = Readonly<{
  draft: Readonly<Partial<EditableTaskDraft>>;
  visibility?: "public" | "private";
  assignmentMode?: AssignmentModeConfig;
  acceptanceMode?: AcceptanceModeConfig;
}>;

export type ParseTaskDraftResult =
  | Readonly<{ success: true; data: ParsedTaskDraftInput }>
  | Readonly<{ success: false; issues: readonly Readonly<{ field: string; message: string }>[] }>;

export type ParseTaskDraftPatchResult =
  | Readonly<{ success: true; data: ParsedTaskDraftPatch }>
  | Readonly<{ success: false; issues: readonly Readonly<{ field: string; message: string }>[] }>;

export type ParsedTaskModeSettings = Readonly<{
  visibility?: "public" | "private";
  assignmentMode?: AssignmentModeConfig;
  acceptanceMode?: AcceptanceModeConfig;
}>;

export type ParseTaskModeSettingsResult =
  | Readonly<{ success: true; data: ParsedTaskModeSettings }>
  | Readonly<{ success: false; issues: readonly Readonly<{ field: string; message: string }>[] }>;

export type ParsedTaskMatchCriteriaPatch = Readonly<{
  categoryId?: string;
  tags?: readonly string[];
  deadline?: Date;
}>;

export type ParseTaskMatchCriteriaPatchResult =
  | Readonly<{ success: true; data: ParsedTaskMatchCriteriaPatch }>
  | Readonly<{ success: false; issues: readonly Readonly<{ field: string; message: string }>[] }>;

/**
 * POST 创建的是可继续编辑的空/半成品草稿，因此这里补齐安全默认值，而不是强迫用户
 * 在第一次保存时就填写所有字段。外部字符串也只在此边界转换为 bigint/Date。
 */
export function parseTaskDraftInput(raw: unknown): ParseTaskDraftResult {
  const parsed = parseTaskDraftPatch(raw);
  if (!parsed.success) {
    return parsed;
  }
  const value = parsed.data;
  return {
    success: true,
    data: {
      draft: {
        title: value.draft.title ?? "",
        description: value.draft.description ?? "",
        acceptanceCriteria: value.draft.acceptanceCriteria ?? "",
        deliverableFormat: value.draft.deliverableFormat ?? "",
        categoryId: value.draft.categoryId ?? null,
        tags: value.draft.tags ?? [],
        pricing: value.draft.pricing ?? null,
        currency: value.draft.currency ?? MVP_CURRENCY,
        deadline: value.draft.deadline ?? null,
        requiredCapability: value.draft.requiredCapability ?? "",
        attachments: value.draft.attachments ?? [],
      },
      visibility: value.visibility ?? "private",
      assignmentMode: value.assignmentMode ?? { mode: "manual" },
      acceptanceMode: value.acceptanceMode ?? { mode: "manual" },
    },
  };
}

/** PATCH 与 POST 共用一份严格 schema；差别只在于 PATCH 不为省略字段补默认值。 */
export function parseTaskDraftPatch(raw: unknown): ParseTaskDraftPatchResult {
  const parsed = taskDraftPatchSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
    };
  }
  const value = parsed.data;
  type MutableDraftPatch = { -readonly [Key in keyof EditableTaskDraft]?: EditableTaskDraft[Key] };
  const draft: MutableDraftPatch = {};
  if (value.title !== undefined) draft.title = value.title;
  if (value.description !== undefined) draft.description = value.description;
  if (value.acceptanceCriteria !== undefined) draft.acceptanceCriteria = value.acceptanceCriteria;
  if (value.deliverableFormat !== undefined) draft.deliverableFormat = value.deliverableFormat;
  if (value.categoryId !== undefined) draft.categoryId = value.categoryId;
  if (value.tags !== undefined) draft.tags = value.tags;
  if (value.pricing !== undefined) draft.pricing = parsePricing(value.pricing);
  if (value.currency !== undefined) draft.currency = value.currency;
  if (value.deadline !== undefined) draft.deadline = new Date(value.deadline);
  if (value.requiredCapability !== undefined) draft.requiredCapability = value.requiredCapability;
  if (value.attachments !== undefined) draft.attachments = value.attachments.map(parseAttachment);

  const result: {
    draft: Readonly<Partial<EditableTaskDraft>>;
    visibility?: "public" | "private";
    assignmentMode?: AssignmentModeConfig;
    acceptanceMode?: AcceptanceModeConfig;
  } = { draft };
  if (value.visibility !== undefined) result.visibility = value.visibility;
  if (value.assignmentMode !== undefined) result.assignmentMode = parseAssignmentMode(value.assignmentMode);
  if (value.acceptanceMode !== undefined) result.acceptanceMode = parseAcceptanceMode(value.acceptanceMode);
  return { success: true, data: result };
}

/** 模式更新接口只接受三个配置字段，避免借该入口绕过草稿锁定规则修改核心任务内容。 */
export function parseTaskModeSettings(raw: unknown): ParseTaskModeSettingsResult {
  const parsed = taskModeSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
    };
  }
  const result: {
    visibility?: "public" | "private";
    assignmentMode?: AssignmentModeConfig;
    acceptanceMode?: AcceptanceModeConfig;
  } = {};
  if (parsed.data.visibility !== undefined) result.visibility = parsed.data.visibility;
  if (parsed.data.assignmentMode !== undefined) result.assignmentMode = parseAssignmentMode(parsed.data.assignmentMode);
  if (parsed.data.acceptanceMode !== undefined) result.acceptanceMode = parseAcceptanceMode(parsed.data.acceptanceMode);
  return { success: true, data: result };
}

/**
 * 匹配阶段使用独立白名单解析器，避免复用草稿 PATCH 后意外开放预算、附件或验收规则。
 * deadline 在可信边界转换为 Date，领域层随后仍会按当前时间配置重新校验。
 */
export function parseTaskMatchCriteriaPatch(raw: unknown): ParseTaskMatchCriteriaPatchResult {
  const parsed = taskMatchCriteriaPatchSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
    };
  }
  const result: { categoryId?: string; tags?: readonly string[]; deadline?: Date } = {};
  if (parsed.data.categoryId !== undefined) result.categoryId = parsed.data.categoryId;
  if (parsed.data.tags !== undefined) result.tags = parsed.data.tags;
  if (parsed.data.deadline !== undefined) result.deadline = new Date(parsed.data.deadline);
  return { success: true, data: result };
}

function parsePricing(value: z.infer<typeof pricingSchema>): TaskPricing {
  return value.type === "fixed"
    ? { type: "fixed", amountMinor: BigInt(value.amountMinor) }
    : { type: "range", minAmountMinor: BigInt(value.minAmountMinor), maxAmountMinor: BigInt(value.maxAmountMinor) };
}

function parseAttachment(value: z.infer<typeof attachmentSchema>): TaskAttachment {
  return { ...value, sizeBytes: BigInt(value.sizeBytes) };
}

function parseAssignmentMode(value: z.infer<typeof assignmentModeSchema>): AssignmentModeConfig {
  return value.mode === "manual" ? { mode: "manual" } : {
    mode: "automatic",
    priceCapMinor: BigInt(value.priceCapMinor),
    rankingBasis: value.rankingBasis,
    fallbackOnFail: value.fallbackOnFail,
  };
}

function parseAcceptanceMode(value: z.infer<typeof acceptanceModeSchema>): AcceptanceModeConfig {
  return value.mode === "manual"
    ? { mode: "manual" }
    : { mode: "automatic", acceptorId: value.acceptorId, ruleVersion: value.ruleVersion };
}
