import { z } from "zod";

export const WorkflowStepSchema = z.enum(["requirements", "design", "code"]);
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const WorkflowAgentIdSchema = z.enum([
	"prd-direct",
	"prd-mastra",
	"prd-state-machine",
	"design-direct",
	"design-mastra",
	"design-state-machine",
	"code-direct",
	"code-mastra",
	"code-state-machine",
]);
export type WorkflowAgentId = z.infer<typeof WorkflowAgentIdSchema>;

export const WORKFLOW_AGENT_CATALOG = [
	{
		id: "prd-direct",
		step: "requirements",
		strategy: "DeepSeek 直连",
		name: "快速需求整理 Agent",
		description: "一次生成结构化 PRD，速度和成本基线。",
	},
	{
		id: "prd-mastra",
		step: "requirements",
		strategy: "Mastra 编排",
		name: "Mastra 需求分析 Agent",
		description: "先规划覆盖范围，再由 Mastra 生成完整需求制品。",
	},
	{
		id: "prd-state-machine",
		step: "requirements",
		strategy: "自研状态机",
		name: "深度需求拆解 Agent",
		description: "分析、生成、评审并最多修复一次。",
	},
	{
		id: "design-direct",
		step: "design",
		strategy: "DeepSeek 直连",
		name: "快速界面设计 Agent",
		description: "直接生成设计决策与可运行高保真原型。",
	},
	{
		id: "design-mastra",
		step: "design",
		strategy: "Mastra 编排",
		name: "Mastra 产品设计 Agent",
		description: "先规划需求覆盖，再生成可运行设计原型。",
	},
	{
		id: "design-state-machine",
		step: "design",
		strategy: "自研状态机",
		name: "设计评审与完善 Agent",
		description: "评审设计后生成并校验可运行高保真原型。",
	},
	{
		id: "code-direct",
		step: "code",
		strategy: "DeepSeek 直连",
		name: "快速代码生成 Agent",
		description: "直接继承设计原型并补充交互实现。",
	},
	{
		id: "code-mastra",
		step: "code",
		strategy: "Mastra 编排",
		name: "Mastra 编程 Agent",
		description: "先规划实现范围，再增量完善设计原型。",
	},
	{
		id: "code-state-machine",
		step: "code",
		strategy: "自研状态机",
		name: "规划测试修复 Coding Agent",
		description: "规划、增量编码、设计继承校验并最多修复一次。",
	},
] as const satisfies readonly {
	id: WorkflowAgentId;
	step: WorkflowStep;
	strategy: string;
	name: string;
	description: string;
}[];

const Text = z.string().min(1);
const GeneratedBySchema = z
	.object({
		agentId: WorkflowAgentIdSchema,
		strategy: z.enum(["direct", "mastra", "state-machine"]),
	})
	.strict();

export const RequirementsArtifactSchema = z
	.object({
		schemaVersion: z.literal("requirements.artifact.v0.1"),
		taskId: Text,
		title: Text,
		problemStatement: Text,
		targetUsers: z.array(Text),
		goals: z.array(Text),
		nonGoals: z.array(Text),
		userStories: z.array(
			z
				.object({
					id: Text,
					statement: Text,
					acceptanceCriteria: z.array(Text),
				})
				.strict(),
		),
		functionalRequirements: z.array(Text),
		constraints: z.array(Text),
		assumptions: z.array(Text),
		openQuestions: z.array(Text),
		executableTasks: z.array(
			z
				.object({
					id: Text,
					title: Text,
					description: Text,
					dependsOn: z.array(Text),
					acceptanceCriteria: z.array(Text),
				})
				.strict(),
		),
		generatedBy: GeneratedBySchema,
		generatedAt: z.string().datetime(),
	})
	.strict();
export type RequirementsArtifact = z.infer<typeof RequirementsArtifactSchema>;

const DesignBaseSchema = z
	.object({
		taskId: Text,
		title: Text,
		direction: Text,
		tokens: z
			.object({
				primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
				secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
				backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
				textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
				borderRadius: z.enum(["0", "4px", "8px", "12px", "16px", "999px"]),
				spacingBase: z.enum(["4px", "6px", "8px"]),
				fontFamily: z.string().trim().min(1).max(500),
			})
			.strict(),
		pages: z.array(
			z
				.object({
					id: Text,
					name: Text,
					purpose: Text,
					sections: z.array(Text),
				})
				.strict(),
		),
		components: z.array(
			z
				.object({
					id: Text,
					name: Text,
					parentId: Text.nullable(),
					responsibility: Text,
					states: z.array(Text),
				})
				.strict(),
		),
		interactionRules: z.array(Text),
		responsiveRules: z.array(Text),
		accessibilityRules: z.array(Text),
		assetPlan: z.array(Text),
		generatedBy: GeneratedBySchema,
		generatedAt: z.string().datetime(),
	})
	.strict();

export const DesignPreviewSchema = z
	.object({
		navigation: z
			.object({
				brand: Text,
				items: z.array(z.object({ label: Text, active: z.boolean() }).strict()),
				action: Text.nullable(),
			})
			.strict()
			.nullable(),
		hero: z
			.object({
				eyebrow: Text,
				title: Text,
				description: Text,
				primaryAction: Text,
				secondaryAction: Text.nullable(),
			})
			.strict(),
		metrics: z.array(
			z.object({
				label: Text,
				value: Text,
				detail: Text,
				tone: z.enum(["neutral", "primary", "success", "warning", "danger"]),
			}).strict(),
		),
		sections: z.array(
			z.object({
				id: Text,
				kind: z.enum(["cards", "list", "progress", "table", "chart", "form", "timeline"]),
				layout: z.enum(["full", "split", "grid-2", "grid-3", "grid-4"]),
				title: Text,
				description: Text.nullable(),
				items: z.array(
					z.object({
						title: Text,
						description: Text.nullable(),
						value: Text.nullable(),
						status: Text.nullable(),
						progress: z.number().int().min(0).max(100).nullable(),
						action: Text.nullable(),
						tone: z.enum(["neutral", "primary", "success", "warning", "danger"]),
					}).strict(),
				),
			}).strict(),
		),
	})
	.strict();
export type DesignPreview = z.infer<typeof DesignPreviewSchema>;

export const DesignArtifactSchema = DesignBaseSchema.extend({
	schemaVersion: z.literal("design.artifact.v0.3"),
	preview: DesignPreviewSchema,
	prototype: z.object({
		pageTsx: z.string().trim().min(300).max(30_000),
		globalsCss: z.string().trim().min(300).max(30_000),
	}).strict(),
}).strict();
export type DesignArtifact = z.infer<typeof DesignArtifactSchema>;

export const CodeArtifactSchema = z
	.object({
		schemaVersion: z.literal("code.artifact.v0.1"),
		taskId: Text,
		title: Text,
		implementationSummary: Text,
		fileTree: z.array(Text),
		files: z.array(
			z
				.object({ path: Text, language: Text, content: Text })
				.strict(),
		),
		runInstructions: z.array(Text),
		testPlan: z.array(Text),
		limitations: z.array(Text),
		generatedBy: GeneratedBySchema,
		generatedAt: z.string().datetime(),
	})
	.strict();
export type CodeArtifact = z.infer<typeof CodeArtifactSchema>;

export const WorkflowArtifactSchema = z.discriminatedUnion("schemaVersion", [
	RequirementsArtifactSchema,
	DesignArtifactSchema,
	CodeArtifactSchema,
]);
export type WorkflowArtifact = z.infer<typeof WorkflowArtifactSchema>;

/** 统一识别当前唯一的可运行设计制品，调用方无需理解协议版本细节。 */
export function isDesignArtifact(
	artifact: WorkflowArtifact,
): artifact is DesignArtifact {
	return artifact.schemaVersion === "design.artifact.v0.3";
}

const BaseExecutionRequestSchema = z.object({
	schemaVersion: z.literal("workflow.execute.v0.1"),
	taskId: z.string().min(1).max(128),
	agentId: WorkflowAgentIdSchema,
	userRequest: z.string().trim().min(20).max(8_000),
});

export const WorkflowExecutionRequestSchema = z.discriminatedUnion("step", [
	BaseExecutionRequestSchema.extend({ step: z.literal("requirements") }).strict(),
	BaseExecutionRequestSchema.extend({
		step: z.literal("design"),
		requirements: RequirementsArtifactSchema,
	}).strict(),
	BaseExecutionRequestSchema.extend({
		step: z.literal("code"),
		requirements: RequirementsArtifactSchema,
		design: DesignArtifactSchema,
	}).strict(),
]);
export type WorkflowExecutionRequest = z.infer<
	typeof WorkflowExecutionRequestSchema
>;

export const WorkflowRouteResponseSchema = z.discriminatedUnion("success", [
	z
		.object({
			success: z.literal(true),
			agentId: WorkflowAgentIdSchema,
			callType: z.literal("sandbox"),
			elapsedMs: z.number().int().nonnegative(),
			result: WorkflowArtifactSchema,
		})
		.strict(),
	z
		.object({
			success: z.literal(false),
			code: Text,
			message: Text,
			retryable: z.boolean(),
		})
		.strict(),
]);
export type WorkflowRouteResponse = z.infer<
	typeof WorkflowRouteResponseSchema
>;
