import { z } from "zod";

/**
 * 发布者评分接口的唯一输入结构。`strict()` 会拒绝争议率、完成量、最终分数等额外
 * 字段，保证调用方只能提交主观质量和沟通体验，系统信誉事实仍由平台自行计算。
 */
const ratingSchema = z
	.object({
		quality: z.number().int().min(1).max(5),
		communication: z.number().int().min(1).max(5),
	})
	.strict();

export type RatingInput = z.infer<typeof ratingSchema>;

/**
 * 在 HTTP 边界把未知 JSON 转成可信评分输入，并将 Zod 的嵌套错误压缩为稳定的
 * 字段/消息列表；领域层因此无需理解验证库或原始请求结构。
 */
export function parseRatingInput(value: unknown) {
	const result = ratingSchema.safeParse(value);
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
