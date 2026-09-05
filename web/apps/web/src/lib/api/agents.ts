import { z } from "zod";
import { notifyAuthSessionExpired } from "@/lib/wallet/session-expiry";
import { BUSINESS_API_BASE_URL } from "./base-url";

/**
 * business-api（2.agent-registration）Agent 档案接口的前端客户端。
 *
 * 权威契约见 specs/2.agent-registration/design.md「接口契约」与
 * services/business-api/src/agents/{agent,patch-agent,credentials}.ts：
 * - `PATCH /api/agents/:id`：编辑除钱包地址外的字段，返回完整档案。
 * - `PUT /api/agents/:id/credentials`：整体覆盖写凭证，只返回 `keyVersion`/`configured`，
 *   不存在、也不会新增任何返回明文或密文的路径（AC-002）。
 * - `GET /api/agents/:id`：读取当前提供者拥有的单个 Agent 档案，用于编辑表单回显；
 *   路由、所有权校验和生产依赖已经由 2.agent-registration T-012 完成。
 *
 * 三个接口都以服务端 SIWE 会话识别提供者，不能接受浏览器自报的钱包地址。网络故障、
 * 会话过期或响应契约损坏由 `AgentApiRequestError` 统一承接，页面据此展示可重试错误态。
 */

const API_BASE_URL = BUSINESS_API_BASE_URL;

/**
 * 运行时校验 business-api 的响应体（codex review T-007 P2 修复：外部输入必须在边界
 * 校验，见 .claude/rules/frontend.md 第 6 条）。网关返回结构不一致或字段缺失时
 * （如 `tags` 缺失/非数组）此前会直接进入可信表单状态，可能在 `agent.tags.join(...)`
 * 等处崩溃；现在会在边界处抛出 `AgentApiRequestError`，由调用方统一的错误态承接。
 */
const agentSchema = z.object({
	id: z.string(),
	providerWalletAddress: z.string(),
	name: z.string(),
	categoryId: z.string(),
	capabilityDesc: z.string(),
	tags: z.array(z.string()),
	pricingType: z.string(),
	/** 最小单位整数金额，以十进制字符串传输，避免 JSON number 精度丢失。 */
	priceAmount: z.string(),
	priceCurrency: z.string(),
	serviceEndpoint: z.string(),
	// 历史 Agent 可能保留联系方式；新上架流程不再收集，因此读取边界必须接受 NULL。
	email: z.string().nullable(),
	status: z.enum(["pending_review", "active", "paused", "delisted"]),
	pauseReason: z.enum(["health_check", "manual"]).nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export type Agent = z.infer<typeof agentSchema>;

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

/** 响应体结构不符合预期 schema 时，转换成与其它请求失败一致的错误态，而不是让调用方在渲染时崩溃。 */
async function parseAgentBody(response: Response): Promise<Agent> {
	const raw: unknown = await response.json();
	const parsed = agentSchema.safeParse(raw);
	if (!parsed.success) {
		throw new AgentApiRequestError(response.status, {
			error_code: "AGENT_INTERNAL_ERROR",
			message: "服务返回的数据格式异常，请稍后重试",
			retryable: true,
		});
	}
	return parsed.data;
}

export async function fetchAgent(agentId: string): Promise<Agent> {
	const response = await fetch(`${API_BASE_URL}/agents/${agentId}`, {
		method: "GET",
		headers: { accept: "application/json" },
		// business-api 与 web 是不同源部署，SIWE session 以 httpOnly cookie 下发；
		// 不带 credentials:"include" 时浏览器默认按 same-origin 处理，cookie 不会
		// 被发送，所有请求都会得到 401（codex review T-007 P1 修复）。
		credentials: "include",
	});
	await assertAuthenticatedAgentResponse(response);
	return parseAgentBody(response);
}

export async function patchAgent(
	agentId: string,
	patch: AgentPatchInput,
): Promise<Agent> {
	const response = await fetch(`${API_BASE_URL}/agents/${agentId}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
		credentials: "include",
	});
	await assertAuthenticatedAgentResponse(response);
	return parseAgentBody(response);
}

const replaceCredentialsResultSchema = z.object({
	keyVersion: z.number(),
	configured: z.literal(true),
});

export type ReplaceCredentialsResult = z.infer<
	typeof replaceCredentialsResultSchema
>;

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
			credentials: "include",
		},
	);
	await assertAuthenticatedAgentResponse(response);
	const raw: unknown = await response.json();
	const parsed = replaceCredentialsResultSchema.safeParse(raw);
	if (!parsed.success) {
		throw new AgentApiRequestError(response.status, {
			error_code: "AGENT_INTERNAL_ERROR",
			message: "服务返回的数据格式异常，请稍后重试",
			retryable: true,
		});
	}
	return parsed.data;
}

/** Agent 私有接口统一处理认证失效，避免读取、编辑和换密钥三条路径产生不同表现。 */
async function assertAuthenticatedAgentResponse(
	response: Response,
): Promise<void> {
	if (response.status === 401) notifyAuthSessionExpired();
	if (!response.ok) {
		throw new AgentApiRequestError(
			response.status,
			await parseErrorBody(response),
		);
	}
}
