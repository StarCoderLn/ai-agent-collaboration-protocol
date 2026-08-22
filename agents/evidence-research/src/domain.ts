import { z } from "zod";

/**
 * 平台提交给论文 Agent 的版本化输入契约。
 * strict() 拒绝未知字段，防止调用方拼错字段后被静默忽略；上限同时约束成本和滥用面。
 */
export const ResearchTaskInputSchema = z
  .object({
    schemaVersion: z.literal("paper.research.v0.1"),
    taskId: z.string().min(1).max(128),
    topic: z.string().min(3).max(500),
    researchQuestion: z.string().min(10).max(2_000),
    language: z.string().min(2).max(32).default("zh-CN"),
    targetWords: z.number().int().min(500).max(5_000).default(1_500),
    sourceCount: z.number().int().min(3).max(20).default(8),
    yearFrom: z.number().int().min(1900).max(2100).optional(),
    yearTo: z.number().int().min(1900).max(2100).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    // 单字段范围合法并不代表组合合法，跨字段不变量在 schema 的唯一权威位置检查。
    if (input.yearFrom !== undefined && input.yearTo !== undefined && input.yearFrom > input.yearTo) {
      context.addIssue({
        code: "custom",
        message: "yearFrom must not be greater than yearTo",
        path: ["yearFrom"],
      });
    }
  });

export type ResearchTaskInput = z.infer<typeof ResearchTaskInputSchema>;

/** OpenAlex 返回后、交给模型前使用的标准化证据对象。 */
export const EvidenceSourceSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    authors: z.array(z.string()),
    publicationYear: z.number().int().nullable(),
    doi: z.string().nullable(),
    url: z.string().min(1),
    abstract: z.string(),
  })
  .strict();

export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

/**
 * 模型只负责生成报告草稿，不允许自行生成 taskId、时间或完整来源元数据。
 * 这些可信字段由 finalizeReport 根据平台输入和实际工具结果补齐。
 */
export const DraftResearchReportSchema = z
  .object({
    title: z.string().min(1),
    executiveSummary: z.string().min(1),
    sections: z
      .array(
        z
          .object({
            heading: z.string().min(1),
            content: z.string().min(1),
            citationIds: z.array(z.string().min(1)),
          })
          .strict(),
      )
      .min(2),
    limitations: z.array(z.string()),
  })
  .strict();

export type DraftResearchReport = z.infer<typeof DraftResearchReportSchema>;

/** 最终交付给平台的版本化报告契约。 */
export const ResearchReportSchema = DraftResearchReportSchema.extend({
  schemaVersion: z.literal("paper.report.v0.1"),
  taskId: z.string().min(1),
  sources: z.array(EvidenceSourceSchema.omit({ abstract: true })).min(1),
  generatedAt: z.string().datetime(),
}).strict();

export type ResearchReport = z.infer<typeof ResearchReportSchema>;

export function finalizeReport(
  input: ResearchTaskInput,
  draft: DraftResearchReport,
  evidence: ReadonlyMap<string, EvidenceSource>,
  generatedAt: Date,
): ResearchReport {
  // 引用 ID 是模型输出，仍然是不可信输入；先汇总去重，再与本次工具证据白名单比对。
  const citedIds = new Set(draft.sections.flatMap((section) => section.citationIds));
  if (citedIds.size === 0) {
    throw new Error("research report contains no citations");
  }

  const unknownIds = [...citedIds].filter((id) => !evidence.has(id));
  if (unknownIds.length > 0) {
    throw new Error(`research report cites sources not returned by tools: ${unknownIds.join(", ")}`);
  }

  const sources = [...citedIds].map((id) => {
    const source = evidence.get(id);
    if (source === undefined) {
      throw new Error(`missing evidence source ${id}`);
    }
    // 摘要只作为生成依据，不在最终 sources 中重复返回，减少 payload 和版权风险面。
    const { abstract: _abstract, ...publicSource } = source;
    return publicSource;
  });

  // 最后再次以交付 schema 校验，避免手工组装时绕过输出契约。
  return ResearchReportSchema.parse({
    ...draft,
    schemaVersion: "paper.report.v0.1",
    taskId: input.taskId,
    sources,
    generatedAt: generatedAt.toISOString(),
  });
}
