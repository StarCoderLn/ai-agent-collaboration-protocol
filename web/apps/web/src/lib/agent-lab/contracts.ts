import { z } from "zod";

/**
 * Agent Lab 暴露给浏览器的受限输入。这里故意比 Agent 公共协议的上限更小，
 * 因为本地 CPU 推理适合体验短报告，不适合一次提交超长任务占满机器。
 */
export const AgentLabRequestSchema = z
	.object({
		topic: z.string().trim().min(3, "主题至少需要 3 个字符").max(200),
		researchQuestion: z
			.string()
			.trim()
			.min(10, "研究问题至少需要 10 个字符")
			.max(1_000),
		language: z.enum(["zh-CN", "en"]),
		targetWords: z.number().int().min(500).max(2_000),
		sourceCount: z.number().int().min(3).max(8),
		yearFrom: z.number().int().min(1900).max(2100).optional(),
		yearTo: z.number().int().min(1900).max(2100).optional(),
	})
	.strict()
	.superRefine((input, context) => {
		if (
			input.yearFrom !== undefined &&
			input.yearTo !== undefined &&
			input.yearFrom > input.yearTo
		) {
			context.addIssue({
				code: "custom",
				message: "起始年份不能晚于结束年份",
				path: ["yearFrom"],
			});
		}
	});

export type AgentLabRequest = z.infer<typeof AgentLabRequestSchema>;

const EvidenceSourceSchema = z
	.object({
		id: z.string().min(1),
		title: z.string().min(1),
		authors: z.array(z.string()),
		publicationYear: z.number().int().nullable(),
		doi: z.string().nullable(),
		url: z.url(),
	})
	.strict();

export const ResearchReportSchema = z
	.object({
		schemaVersion: z.literal("paper.report.v0.1"),
		taskId: z.string().min(1),
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
		sources: z.array(EvidenceSourceSchema).min(1),
		limitations: z.array(z.string()),
		generatedAt: z.string().datetime(),
	})
	.strict();

export type ResearchReport = z.infer<typeof ResearchReportSchema>;

export const AgentLabSuccessSchema = z
	.object({
		success: z.literal(true),
		agentId: z.string().min(1),
		callType: z.literal("sandbox"),
		elapsedMs: z.number().int().nonnegative(),
		result: ResearchReportSchema,
	})
	.strict();

export const AgentLabErrorSchema = z
	.object({
		success: z.literal(false),
		code: z.string().min(1),
		message: z.string().min(1),
		retryable: z.boolean(),
	})
	.strict();

export const AgentLabRouteResponseSchema = z.discriminatedUnion("success", [
	AgentLabSuccessSchema,
	AgentLabErrorSchema,
]);

export type AgentLabRouteResponse = z.infer<typeof AgentLabRouteResponseSchema>;
