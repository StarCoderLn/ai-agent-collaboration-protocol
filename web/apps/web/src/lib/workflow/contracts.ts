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
		description: "一次生成设计 token、页面、组件与交互规范。",
	},
	{
		id: "design-mastra",
		step: "design",
		strategy: "Mastra 编排",
		name: "Mastra 产品设计 Agent",
		description: "先规划需求覆盖，再生成结构化设计稿。",
	},
	{
		id: "design-state-machine",
		step: "design",
		strategy: "自研状态机",
		name: "设计评审与完善 Agent",
		description: "显式校验交互、响应式、无障碍和素材覆盖。",
	},
	{
		id: "code-direct",
		step: "code",
		strategy: "DeepSeek 直连",
		name: "快速代码生成 Agent",
		description: "直接生成文件树、代码、运行说明和测试计划。",
	},
	{
		id: "code-mastra",
		step: "code",
		strategy: "Mastra 编排",
		name: "Mastra 编程 Agent",
		description: "先规划实现范围，再生成可运行代码制品。",
	},
	{
		id: "code-state-machine",
		step: "code",
		strategy: "自研状态机",
		name: "规划测试修复 Coding Agent",
		description: "规划、编码、静态评审并最多修复一次。",
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

export const DesignArtifactSchema = z
	.object({
		schemaVersion: z.literal("design.artifact.v0.1"),
		taskId: Text,
		title: Text,
		direction: Text,
		tokens: z
			.object({
				primaryColor: Text,
				secondaryColor: Text,
				backgroundColor: Text,
				textColor: Text,
				borderRadius: Text,
				spacingBase: Text,
				fontFamily: Text,
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
		svgPreview: Text,
		generatedBy: GeneratedBySchema,
		generatedAt: z.string().datetime(),
	})
	.strict();
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
