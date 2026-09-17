import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import {
	type EditableWorkflowPlan,
	EditableWorkflowPlanSchema,
} from "./workflow-plan-contract";

const responseSchema = z.object({
	plan: EditableWorkflowPlanSchema,
	model: z.object({ provider: z.string(), model: z.string() }).nullable(),
	// 两个服务各自拥有运行时 Schema；固定版本让任一侧变更契约时直接失败，而不是静默
	// 接受字段含义已经漂移的草案。
	promptVersion: z.literal("workflow-plan-v2"),
});

/**
 * Marketplace API 只通过受签名的窄端点请求草案，不共享模型密钥。签名算法与 AICP v1
 * 字节契约保持一致；请求正文只序列化一次，避免验签前后 JSON 字节发生变化。
 */
export class WorkflowPlannerClient {
	constructor(
		private readonly options: Readonly<{
			baseUrl: string;
			secret: string;
			fetch?: typeof fetch;
		}>,
	) {}

	async generate(
		input: Readonly<{
			taskId: string;
			title: string;
			description: string;
			category: string;
			tags: readonly string[];
			requiredCapability: string;
			availableAgentContracts: readonly Readonly<{
				kind: string;
				inputContract: string;
				outputContract: string;
				agentName: string;
				capability: string;
			}>[];
		}>,
	): Promise<{
		plan: EditableWorkflowPlan;
		provider?: string;
		model?: string;
		promptVersion: string;
	}> {
		const path = "/v1/workflow/plan";
		const body = JSON.stringify(input);
		const timestamp = Math.floor(Date.now() / 1000).toString();
		const nonce = randomBytes(16).toString("base64url");
		const callType = "production";
		const signature = createHmac("sha256", this.options.secret)
			.update(
				Buffer.concat([
					Buffer.from(`POST\n${path}\n${timestamp}\n${nonce}\n${callType}\n`),
					Buffer.from(body),
				]),
			)
			.digest("hex");
		const response = await (this.options.fetch ?? fetch)(
			new URL(path, this.options.baseUrl),
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": `workflow-plan:${input.taskId}:${nonce}`,
					"x-protocol-version": "1.0",
					"x-timestamp": timestamp,
					"x-nonce": nonce,
					"x-signature": signature,
					"x-call-type": callType,
				},
				body,
				signal: AbortSignal.timeout(180_000),
			},
		);
		if (!response.ok)
			throw new Error(`WORKFLOW_PLANNER_HTTP_${response.status}`);
		const parsed = responseSchema.parse(await response.json());
		return {
			plan: parsed.plan,
			promptVersion: parsed.promptVersion,
			...(parsed.model === null
				? {}
				: { provider: parsed.model.provider, model: parsed.model.model }),
		};
	}
}
