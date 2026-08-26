import { z } from "zod";
import {
	isMatchingTagSyntaxValid,
	MAX_MATCHING_TAG_COUNT,
	MAX_MATCHING_TAG_LENGTH,
	normalizeMatchingTag,
} from "@/lib/platform/matching-tags";
import { BUSINESS_API_BASE_URL } from "./base-url";

const ETHEREUM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

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
	priceAmount: z.string().trim().regex(/^\d+$/, "报价必须是非负整数"),
	priceCurrency: z.string().trim().min(1, "币种不能为空"),
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
	credentialSecret: z.string().min(1, "调用凭证不能为空"),
	email: z.email("邮箱格式不合法"),
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

export async function registerAgent(
	values: AgentRegistrationValues,
	idempotencyKey: string,
): Promise<RegisterAgentResult> {
	let response: Response;
	try {
		response = await fetch(`${BUSINESS_API_BASE_URL}/agents`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": idempotencyKey,
			},
			// business-api 与 web 是不同源部署，SIWE session 以 httpOnly cookie 下发
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
				credentialSecret: values.credentialSecret,
				email: values.email,
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
