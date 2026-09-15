import { z } from "zod";
import {
	isMatchingTagSyntaxValid,
	MAX_MATCHING_TAG_COUNT,
	MAX_MATCHING_TAG_LENGTH,
	normalizeMatchingTag,
} from "@/lib/platform/matching-tags";
import {
	isAtLeastMinimumUsdcAmountMinor,
	MVP_CURRENCY,
} from "@/lib/platform/money";
import { notifyAuthSessionExpired } from "@/lib/wallet/session-expiry";
import { MARKETPLACE_API_BASE_URL } from "./base-url";

const ETHEREUM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const portfolioCaseSchema = z.object({
	title: z
		.string()
		.trim()
		.min(1, "案例标题不能为空")
		.max(120, "案例标题最多 120 个字符"),
	summary: z
		.string()
		.trim()
		.min(1, "案例说明不能为空")
		.max(600, "案例说明最多 600 个字符"),
	artifactKind: z.enum([
		"document",
		"image",
		"video",
		"website",
		"code",
		"other",
	]),
	previewRef: z
		.string()
		.trim()
		.max(2000, "案例地址最多 2000 个字符")
		.url("案例地址必须是合法 URL")
		.regex(/^https?:\/\//, "案例地址必须使用 http(s) 协议"),
});

export const agentRegistrationSchema = z.object({
	name: z.string().trim().min(1, "名称不能为空"),
	categoryId: z.uuid("分类 ID 必须是合法的 UUID"),
	capabilityDesc: z.string().trim().min(1, "能力描述不能为空"),
	tags: z
		.array(
			z
				.string()
				.trim()
				.min(1)
				.max(MAX_MATCHING_TAG_LENGTH)
				.refine(isMatchingTagSyntaxValid, "标签包含不支持的字符"),
		)
		.min(1, "至少填写一个标签")
		.max(MAX_MATCHING_TAG_COUNT, `最多填写 ${MAX_MATCHING_TAG_COUNT} 个标签`)
		.transform((tags) => [
			...new Set(tags.map(normalizeMatchingTag).filter(Boolean)),
		]),
	pricingType: z.string().trim().min(1, "计价方式不能为空"),
	priceAmount: z
		.string()
		.trim()
		.refine(isAtLeastMinimumUsdcAmountMinor, "单次服务报价至少为 1 USDC"),
	priceCurrency: z.literal(MVP_CURRENCY, "报价币种必须是 USDC"),
	walletAddress: z
		.string()
		.trim()
		.regex(ETHEREUM_ADDRESS_PATTERN, "钱包地址必须是合法的以太坊地址"),
	payoutWalletAddress: z
		.string()
		.trim()
		.regex(ETHEREUM_ADDRESS_PATTERN, "收款钱包必须是合法的以太坊地址"),
	serviceEndpoint: z
		.url("服务地址必须是合法 URL")
		.regex(/^https?:\/\//, "服务地址必须使用 http(s) 协议"),
	// 页面只接入已完成的 HTTP Agent；该字段不需要在 UI 中让用户
	// 理解，但必须显式写入请求，避免服务端把新客户端误当成历史 HMAC 接入。
	integrationMode: z.literal("http_json"),
	credentialSecret: z
		.string()
		.max(4_096, "访问密钥最多 4096 个字符")
		.optional()
		.transform((value) => (value === "" ? undefined : value)),
	// 自述案例不是上架必填项，并且最多三条；平台真实验收案例由后端工作流自动补充。
	portfolioCases: z.array(portfolioCaseSchema).max(3, "最多添加 3 个案例"),
});

export type AgentRegistrationValues = z.infer<typeof agentRegistrationSchema>;
export type AgentRegistrationFieldErrors = Partial<
	Record<keyof AgentRegistrationValues, string>
>;

export function validateAgentRegistration(
	values: unknown,
):
	| { success: true; data: AgentRegistrationValues }
	| { success: false; fieldErrors: AgentRegistrationFieldErrors } {
	const result = agentRegistrationSchema.safeParse(values);
	if (result.success) {
		return { success: true, data: result.data };
	}

	const fieldErrors: AgentRegistrationFieldErrors = {};
	for (const issue of result.error.issues) {
		const field = issue.path[0];
		if (typeof field === "string" && !(field in fieldErrors)) {
			fieldErrors[field as keyof AgentRegistrationValues] = issue.message;
		}
	}
	return { success: false, fieldErrors };
}

export interface RegisterAgentSuccess {
	agentId: string;
	status: "pending_review";
}

export interface RegisterAgentFieldError {
	field: string;
	message: string;
}

export interface RegisterAgentError {
	errorCode: string;
	message: string;
	retryable: boolean;
	fields?: RegisterAgentFieldError[];
}

export type RegisterAgentResult =
	| { success: true; data: RegisterAgentSuccess }
	| { success: false; error: RegisterAgentError };

export type AgentConnectionTestResult =
	| { success: true; latencyMs: number }
	| { success: false; error: RegisterAgentError };

/**
 * 在真正上架前验证执行地址与可选 Bearer Token。服务端只访问同域 `/healthz`，
 * 不发送任务正文，也不会触发提供者的模型调用；浏览器仍携带 SIWE 会话，避免把
 * 平台的出站探测能力开放成匿名网络代理。
 */
export async function testAgentConnection(input: {
	serviceEndpoint: string;
	credentialSecret?: string;
}): Promise<AgentConnectionTestResult> {
	let response: Response;
	try {
		response = await fetch(
			`${MARKETPLACE_API_BASE_URL}/agents/connection-test`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "include",
				body: JSON.stringify({
					serviceEndpoint: input.serviceEndpoint,
					...(input.credentialSecret === undefined ||
					input.credentialSecret === ""
						? {}
						: { credentialSecret: input.credentialSecret }),
				}),
			},
		);
	} catch {
		return {
			success: false,
			error: {
				errorCode: "NETWORK_ERROR",
				message: "无法连接服务器，请检查网络后重试",
				retryable: true,
			},
		};
	}

	if (response.status === 401) notifyAuthSessionExpired();

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return {
			success: false,
			error: {
				errorCode: "AGENT_CONNECTION_FAILED",
				message: "服务器返回了非预期响应",
				retryable: true,
			},
		};
	}

	if (response.ok) {
		const latencyMs =
			typeof body === "object" &&
			body !== null &&
			"latencyMs" in body &&
			typeof body.latencyMs === "number"
				? body.latencyMs
				: 0;
		return { success: true, latencyMs };
	}

	const error = body as {
		error_code?: string;
		message?: string;
		retryable?: boolean;
	};
	return {
		success: false,
		error: {
			errorCode: error.error_code ?? "AGENT_CONNECTION_FAILED",
			message: error.message ?? "无法连接 Agent，请检查地址后重试",
			retryable: error.retryable ?? true,
		},
	};
}

export async function registerAgent(
	values: AgentRegistrationValues,
	idempotencyKey: string,
): Promise<RegisterAgentResult> {
	let response: Response;
	try {
		response = await fetch(`${MARKETPLACE_API_BASE_URL}/agents`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": idempotencyKey,
			},
			// marketplace-api 与 web 是不同源部署，SIWE session 以 httpOnly cookie 下发
			// （同 lib/api/agents.ts 的修复，codex review T-007 P1 同类问题）。
			credentials: "include",
			body: JSON.stringify({
				name: values.name,
				categoryId: values.categoryId,
				capabilityDesc: values.capabilityDesc,
				tags: values.tags,
				pricingType: values.pricingType,
				price: {
					amount: values.priceAmount,
					currency: values.priceCurrency,
				},
				walletAddress: values.walletAddress,
				payoutWalletAddress: values.payoutWalletAddress,
				serviceEndpoint: values.serviceEndpoint,
				integrationMode: values.integrationMode,
				// 公开 Agent 不发送空凭证字段；服务端以字段缺失作为
				// “调用时不发 Authorization”的权威语义。
				...(values.credentialSecret === undefined
					? {}
					: { credentialSecret: values.credentialSecret }),
				// 没有案例时省略整个可选字段，避免把空数组误表达成注册资料缺失；只有提供者
				// 主动添加案例后，服务端才需要校验并在同一事务内持久化这些自述证据。
				...(values.portfolioCases.length > 0
					? { portfolioCases: values.portfolioCases }
					: {}),
			}),
		});
	} catch {
		return {
			success: false,
			error: {
				errorCode: "NETWORK_ERROR",
				message: "无法连接服务器，请检查网络后重试",
				retryable: true,
			},
		};
	}
	// 上架 Agent 也是受保护写入；过期会话必须撤下页头旧身份并引导重新签名。
	if (response.status === 401) notifyAuthSessionExpired();

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return {
			success: false,
			error: {
				errorCode: "AGENT_INTERNAL_ERROR",
				message: "服务器返回了非预期响应",
				retryable: true,
			},
		};
	}

	if (response.ok) {
		return { success: true, data: body as RegisterAgentSuccess };
	}

	const error = body as {
		error_code?: string;
		message?: string;
		retryable?: boolean;
		fields?: RegisterAgentFieldError[];
	};
	return {
		success: false,
		error: {
			errorCode: error.error_code ?? "AGENT_INTERNAL_ERROR",
			message: error.message ?? "创建 Agent 失败，请稍后重试",
			retryable: error.retryable ?? true,
			...(error.fields ? { fields: error.fields } : {}),
		},
	};
}
