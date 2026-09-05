import { z } from "zod";

/**
 * 快速接入只消费平台任务中跨类型稳定的字段。passthrough 让平台以后增加可选字段时，
 * 已部署 Agent 不会因为不认识无关元数据而停止服务；真正使用的字段仍逐项运行时校验。
 */
const QuickTaskSchema = z
	.object({
		id: z.string().min(1).max(128).optional(),
		title: z.string().trim().min(1).max(500).optional(),
		description: z.string().max(20_000).optional(),
		acceptanceCriteria: z.string().max(10_000).optional(),
		deliverableFormat: z.string().max(2_000).optional(),
		requiredCapability: z.string().max(5_000).optional(),
		tags: z.array(z.string().max(100)).max(30).optional(),
	})
	.passthrough();

const UpstreamArtifactSchema = z
	.object({
		workflowNodeId: z.string().optional(),
		nodeKey: z.string().optional(),
		outputContract: z.string().optional(),
		artifactKind: z.string().optional(),
		mimeType: z.string().optional(),
		bodyOrFileRef: z.string().max(250_000).optional(),
	})
	.passthrough();

export const QuickRunRequestSchema = z
	.object({
		task: QuickTaskSchema,
		upstreamArtifacts: z.array(UpstreamArtifactSchema).max(20).default([]),
	})
	.passthrough();

export type QuickRunRequest = z.infer<typeof QuickRunRequestSchema>;

export const QuickArtifactSchema = z
	.object({
		type: z.enum(["document", "code", "json", "website", "image", "video"]),
		summary: z.string().trim().min(1).max(1_000),
		content: z.unknown(),
		mimeType: z.string().trim().min(1).max(200).optional(),
		sizeBytes: z.string().regex(/^(0|[1-9]\d{0,18})$/).optional(),
	})
	.strict();

export const QuickAgentResponseSchema = z
	.object({
		status: z.literal("completed"),
		artifacts: z.array(QuickArtifactSchema).min(1).max(3),
	})
	.strict();

export type QuickArtifact = z.infer<typeof QuickArtifactSchema>;
export type QuickAgentResponse = z.infer<typeof QuickAgentResponseSchema>;

export type QuickAgentExecutor = (
	request: QuickRunRequest,
	signal: AbortSignal,
) => Promise<QuickAgentResponse>;

/**
 * 将任务及已验收上游制品压缩成模型可读上下文。只截断模型输入副本，不改写平台事实；
 * 这样可以限制费用和提示词体积，同时保留标题、验收标准与前序 Agent 的关键内容。
 */
export function taskPromptContext(request: QuickRunRequest): string {
	const task = request.task;
	const taskLines = [
		`任务标题：${task.title ?? "未命名任务"}`,
		`详细需求：${task.description ?? "未提供"}`,
		`验收标准：${task.acceptanceCriteria ?? "未提供"}`,
		`交付格式：${task.deliverableFormat ?? "未提供"}`,
		`所需能力：${task.requiredCapability ?? "未提供"}`,
		`标签：${task.tags?.join("、") || "无"}`,
	];
	const upstream = request.upstreamArtifacts.map((artifact, index) => {
		const body = artifact.bodyOrFileRef ?? "";
		return [
			`上游制品 ${index + 1}（${artifact.outputContract ?? artifact.artifactKind ?? "未知类型"}）：`,
			body.slice(0, 30_000),
		].join("\n");
	});
	return [...taskLines, ...upstream].join("\n\n").slice(0, 90_000);
}
