import { env } from "@web/env/web";

/**
 * business-api（2.agent-registration）Agent 档案接口的前端客户端。
 *
 * 权威契约见 specs/2.agent-registration/design.md「接口契约」与
 * services/business-api/src/agents/{agent,patch-agent,credentials}.ts：
 * - `PATCH /api/agents/:id`：编辑除钱包地址外的字段，返回完整档案。
 * - `PUT /api/agents/:id/credentials`：整体覆盖写凭证，只返回 `keyVersion`/`configured`，
 *   不存在、也不会新增任何返回明文或密文的路径（AC-002）。
 *
 * `GET /api/agents/:id`（读取单个档案用于回显编辑表单）尚未在 2.agent-registration
 * 的任务清单中定义为独立任务，这里按同一资源的 RESTful 惯例对接；真实 Route Handler 落地前
 * 调用会以网络错误呈现，页面已用 `AgentFetchError` 承接并展示可重试的错误态
 * （docs/DESIGN.md「Loading and empty states」）。
 */

const API_BASE_URL = env.NEXT_PUBLIC_BUSINESS_API_URL;

export interface Agent {
	id: string;
	providerWalletAddress: string;
	name: string;
	categoryId: string;
	capabilityDesc: string;
	tags: string[];
	pricingType: string;
	/** 最小单位整数金额，以十进制字符串传输，避免 JSON number 精度丢失。 */
	priceAmount: string;
	priceCurrency: string;
	serviceEndpoint: string;
	email: string;
	status: "pending_review" | "active" | "paused" | "delisted";
	pauseReason: "health_check" | "manual" | null;
	createdAt: string;
	updatedAt: string;
}

/** `PATCH /api/agents/:id` 允许编辑的字段集合，与后端 `AGENT_PATCHABLE_FIELDS` 保持一致。 */
export interface AgentPatchInput {
	name?: string;
	categoryId?: string;
	capabilityDesc?: string;
	tags?: string[];
	pricingType?: string;
	priceAmount?: string;
	priceCurrency?: string;
	serviceEndpoint?: string;
	email?: string;
}

export interface AgentApiErrorBody {
	error_code: string;
	message: string;
	retryable: boolean;
	fields?: Record<string, string>;
}

export class AgentApiRequestError extends Error {
	readonly status: number;
	readonly body: AgentApiErrorBody;

	constructor(status: number, body: AgentApiErrorBody) {
		super(body.message);
		this.name = "AgentApiRequestError";
		this.status = status;
		this.body = body;
	}
}

async function parseErrorBody(response: Response): Promise<AgentApiErrorBody> {
	try {
		return (await response.json()) as AgentApiErrorBody;
	} catch {
		return {
			error_code: "AGENT_INTERNAL_ERROR",
			message: "请求失败，请稍后重试",
			retryable: true,
		};
	}
}

export async function fetchAgent(agentId: string): Promise<Agent> {
	const response = await fetch(`${API_BASE_URL}/agents/${agentId}`, {
		method: "GET",
		headers: { accept: "application/json" },
	});
	if (!response.ok) {
		throw new AgentApiRequestError(
			response.status,
			await parseErrorBody(response),
		);
	}
	return (await response.json()) as Agent;
}

export async function patchAgent(
	agentId: string,
	patch: AgentPatchInput,
): Promise<Agent> {
	const response = await fetch(`${API_BASE_URL}/agents/${agentId}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
	});
	if (!response.ok) {
		throw new AgentApiRequestError(
			response.status,
			await parseErrorBody(response),
		);
	}
	return (await response.json()) as Agent;
}

export interface ReplaceCredentialsResult {
	keyVersion: number;
	configured: true;
}

export async function replaceAgentCredentials(
	agentId: string,
	credentialSecret: string,
): Promise<ReplaceCredentialsResult> {
	const response = await fetch(
		`${API_BASE_URL}/agents/${agentId}/credentials`,
		{
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ credentialSecret }),
		},
	);
	if (!response.ok) {
		throw new AgentApiRequestError(
			response.status,
			await parseErrorBody(response),
		);
	}
	return (await response.json()) as ReplaceCredentialsResult;
}
