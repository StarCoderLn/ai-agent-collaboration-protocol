import { z } from "zod";
import {
	CodeArtifactSchema,
	DesignArtifactSchema,
	RequirementsArtifactSchema,
	WORKFLOW_AGENT_CATALOG,
	WorkflowAgentIdSchema,
	WorkflowStepSchema,
} from "./contracts";

export const WORKFLOW_SESSION_STORAGE_KEY = "aicp.product-workflow.session.v1";

/** 同一浏览器可以打开多个任务方案；任务 ID 进入 key，避免一个任务的 Agent 和制品串到另一个任务。 */
export function workflowSessionStorageKey(taskId: string): string {
	return `${WORKFLOW_SESSION_STORAGE_KEY}:${encodeURIComponent(taskId)}`;
}

const NullableAgentId = WorkflowAgentIdSchema.nullable();
const WorkflowSessionStateSchema = z
	.object({
		version: z.literal(1),
		userRequest: z.string().trim().min(20).max(8_000),
		selected: z
			.object({
				requirements: NullableAgentId,
				design: NullableAgentId,
				code: NullableAgentId,
			})
			.strict(),
		artifacts: z
			.object({
				requirements: RequirementsArtifactSchema.nullable(),
				design: DesignArtifactSchema.nullable(),
				code: CodeArtifactSchema.nullable(),
			})
			.strict(),
		accepted: z
			.object({ requirements: z.boolean(), design: z.boolean(), code: z.boolean() })
			.strict(),
		activeStep: WorkflowStepSchema,
	})
	.strict()
	.superRefine((state, context) => {
		for (const step of ["requirements", "design", "code"] as const) {
			const selected = state.selected[step];
			if (
				selected !== null &&
				WORKFLOW_AGENT_CATALOG.find((agent) => agent.id === selected)?.step !== step
			) {
				context.addIssue({
					code: "custom",
					path: ["selected", step],
					message: "selected Agent belongs to another workflow step",
				});
			}
			const artifact = state.artifacts[step];
			if (artifact !== null && artifact.generatedBy.agentId !== selected) {
				context.addIssue({
					code: "custom",
					path: ["artifacts", step, "generatedBy", "agentId"],
					message: "artifact source must match the selected Agent",
				});
			}
			if (state.accepted[step] && artifact === null) {
				context.addIssue({
					code: "custom",
					path: ["accepted", step],
					message: "an accepted step must have a validated artifact",
				});
			}
		}
		if (
			(state.artifacts.design !== null || state.accepted.design) &&
			!state.accepted.requirements
		) {
			context.addIssue({
				code: "custom",
				path: ["accepted", "requirements"],
				message: "design requires accepted requirements",
			});
		}
		if (
			(state.artifacts.code !== null || state.accepted.code) &&
			!state.accepted.design
		) {
			context.addIssue({
				code: "custom",
				path: ["accepted", "design"],
				message: "code requires accepted design",
			});
		}
	});

export type WorkflowSessionState = z.infer<typeof WorkflowSessionStateSchema>;

/** sessionStorage 属于不可信边界：解析、schema 与跨步骤不变量全部通过后才恢复。 */
export function readWorkflowSession(
	storage: Pick<Storage, "getItem">,
	key = WORKFLOW_SESSION_STORAGE_KEY,
): WorkflowSessionState | null {
	try {
		const serialized = storage.getItem(key);
		if (serialized === null) return null;
		const raw: unknown = JSON.parse(serialized);
		const parsed = WorkflowSessionStateSchema.safeParse(raw);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** 写入失败（隐私模式、配额不足）只降级为本页内存状态，不阻断 Agent 主流程。 */
export function writeWorkflowSession(
	storage: Pick<Storage, "setItem">,
	state: WorkflowSessionState,
	key = WORKFLOW_SESSION_STORAGE_KEY,
): boolean {
	const parsed = WorkflowSessionStateSchema.safeParse(state);
	if (!parsed.success) return false;
	try {
		storage.setItem(key, JSON.stringify(parsed.data));
		return true;
	} catch {
		return false;
	}
}
