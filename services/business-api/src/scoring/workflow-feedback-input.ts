import { z } from "zod";

/** 稳定标签 ID 便于统计和向量元数据过滤；展示文案由客户端国际化，不写入事实表。 */
export const WorkflowFeedbackStrengthSchema = z.enum([
	"requirements_understanding",
	"delivery_quality",
	"design_fidelity",
	"usability",
	"communication",
	"efficiency",
]);

const OptionalFeedbackText = (maximum: number) => z
	.string()
	.trim()
	.min(4)
	.max(maximum)
	.optional();

const WorkflowFeedbackInputSchema = z
	.object({
		quality: z.number().int().min(1).max(5),
		communication: z.number().int().min(1).max(5),
		comment: OptionalFeedbackText(2_000),
		strengths: z.array(WorkflowFeedbackStrengthSchema).max(4).default([]),
		improvement: OptionalFeedbackText(1_000),
		allowModelTraining: z.boolean().default(false),
	})
	.strict()
	.superRefine((value, context) => {
		// 评分始终进入履约统计；只有用户明确授权且提供了可用文本时，文字部分才允许进入
		// 后续脱敏与训练数据管线，不能把空白授权当成有效训练样本。
		if (new Set(value.strengths).size !== value.strengths.length) {
			context.addIssue({ code: "custom", path: ["strengths"], message: "反馈标签不能重复" });
		}
		if (value.allowModelTraining && value.comment === undefined) {
			context.addIssue({ code: "custom", path: ["allowModelTraining"], message: "同意训练前需要填写文字反馈" });
		}
	});

export type WorkflowFeedbackInput = z.infer<typeof WorkflowFeedbackInputSchema>;

/**
 * 外部 JSON 在 HTTP 边界统一转成字段级错误，Handler 不接触 Zod 细节，前端也能把错误
 * 精确定位到评分、标签或训练授权字段，而不是只显示一个笼统失败提示。
 */
export function parseWorkflowFeedbackInput(value: unknown) {
	const result = WorkflowFeedbackInputSchema.safeParse(value);
	return result.success
		? { success: true as const, data: result.data }
		: {
			success: false as const,
			issues: result.error.issues.map((issue) => ({
				field: issue.path.join("."),
				message: issue.message,
			})),
		};
}
