/**
 * `POST /api/agents` 请求体的服务端字段校验（2.agent-registration T-003）。
 *
 * 契约权威定义见 specs/2.agent-registration/design.md 「接口契约」；DB 约束权威定义见
 * services/business-service/migrations/0001_agent_registration.up.sql。本模块的校验规则
 * 是 DB CHECK 的应用层前置版本（同一批约束在两处各自表达，属于 AGENTS.md 允许的"防御
 * 深度"，不是重复业务知识——DB 层是最终防线，应用层负责返回可读的字段级错误）。
 *
 * 不信任前端校验：前端表单（T-006）出于同一套规则做即时校验，但本模块是唯一权威的
 * 服务端校验实现，前端改动不能绕过任何一条规则。
 */

import { z } from "zod";
import {
	isMatchingTagSyntaxValid,
	MAX_MATCHING_TAG_COUNT,
	MAX_MATCHING_TAG_LENGTH,
	normalizeMatchingTags,
} from "../platform/matching-tags";
import { MVP_CURRENCY } from "../platform/mvp-money";
import { isValidEthereumAddress } from "./ethereum-address";
import {
	isValidPriceAmount,
	PRICE_AMOUNT_INVALID_MESSAGE,
} from "./price-amount";

// 请求解析层只验证 UUID 结构，不把前端下拉选项当成可信的“分类存在”证据。分类表已经
// 由 Feature 4 提供；存在性应在创建事务的数据库边界校验，不能在这里额外发起查询并
// 把纯解析函数变成隐式 I/O。当前注册仓储尚未建立该外键，这是独立的既有校验缺口。
const categoryIdSchema = z
	.string()
	.uuid({ message: "categoryId 必须是合法的 UUID" });

function ethereumWalletSchema(field: "walletAddress" | "payoutWalletAddress") {
	return z.string().refine(isValidEthereumAddress, {
		message: `${field} 必须是合法的以太坊地址（0x + 40 位十六进制，且大小写需符合 EIP-55 校验和）`,
	});
}

const serviceEndpointSchema = z
	.string()
	.url({ message: "serviceEndpoint 必须是合法的 URL" })
	.regex(/^https?:\/\//, {
		message: "serviceEndpoint 必须以 http:// 或 https:// 开头",
	});

// price_amount 落库为 BIGINT，JSON number 超过 2^53 会丢精度（AGENTS.md 安全规则 5 /
// .claude/rules/security.md 第 5 条：金额禁止浮点，须用整数最小单位）。要求客户端
// 传字符串形式的非负整数，服务端不做隐式数字转换。
const priceSchema = z.object({
	amount: z
		.string()
		.refine(isValidPriceAmount, { message: PRICE_AMOUNT_INVALID_MESSAGE }),
	// 业务结算只有 USDC 一套；在注册边界收窄为字面量，避免其他币种报价进入目录后
	// 永远无法与任务匹配，或在结算阶段才暴露不可执行状态。
	currency: z.literal(MVP_CURRENCY),
});

const portfolioCaseSchema = z.object({
	title: z
		.string()
		.trim()
		.min(1, { message: "案例标题不能为空" })
		.max(120, { message: "案例标题最多 120 个字符" }),
	summary: z
		.string()
		.trim()
		.min(1, { message: "案例说明不能为空" })
		.max(600, { message: "案例说明最多 600 个字符" }),
	artifactKind: z.enum([
		"document",
		"image",
		"video",
		"website",
		"code",
		"other",
	]),
	// 提供者案例必须是公开可访问的 HTTP(S) 地址；服务端不会代表用户抓取或复制内容，
	// 候选页只把它作为“自行提供”的外部证据展示，不能与平台验收制品混为一谈。
	previewRef: z
		.string()
		.trim()
		.max(2000, { message: "案例地址最多 2000 个字符" })
		.url({ message: "案例地址必须是合法 URL" })
		.regex(/^https?:\/\//, {
			message: "案例地址必须以 http:// 或 https:// 开头",
		}),
});

export const createAgentInputSchema = z
	.object({
		name: z.string().trim().min(1, { message: "name 不能为空" }),
		categoryId: categoryIdSchema,
		capabilityDesc: z
			.string()
			.trim()
			.min(1, { message: "capabilityDesc 不能为空" }),
		// Agent 和任务使用同一组数量、长度与字符边界。本层先完成无 I/O 的基础规范化；
		// 数据库同义词到 canonical 值的收敛统一在 Agent 仓储的可信持久化边界完成，避免
		// Web 表单、API 调用方或旧客户端各自维护一份可能过期的词表。
		tags: z
			.array(
				z
					.string()
					.trim()
					.min(1)
					.max(MAX_MATCHING_TAG_LENGTH)
					.refine(isMatchingTagSyntaxValid, {
						message: "标签包含不支持的字符",
					}),
			)
			.min(1, { message: "tags 至少包含一个标签" })
			.max(MAX_MATCHING_TAG_COUNT, {
				message: `tags 最多包含 ${MAX_MATCHING_TAG_COUNT} 个标签`,
			})
			.transform((tags) => normalizeMatchingTags(tags)),
		pricingType: z.string().trim().min(1, { message: "pricingType 不能为空" }),
		price: priceSchema,
		// walletAddress 来自登录会话，只用于证明 Agent 所有权；payoutWalletAddress 由提供者
		// 自行填写，只用于结算。服务端必须分别校验，不能让收款地址绕过所有者身份检查。
		walletAddress: ethereumWalletSchema("walletAddress"),
		payoutWalletAddress: ethereumWalletSchema("payoutWalletAddress"),
		serviceEndpoint: serviceEndpointSchema,
		// 未显式声明的旧客户端继续进入 HMAC 模式，避免一次 API 升级悄悄改变历史接入
		// 语义；新版上架页固定发送 http_json，并允许公开 Agent 不配置访问密钥。
		integrationMode: z.enum(["aicp_hmac", "http_json"]).default("aicp_hmac"),
		credentialSecret: z
			.union([
				z.literal("").transform(() => undefined),
				z
					.string()
					.min(1)
					.max(4_096, { message: "credentialSecret 最多 4096 个字符" }),
			])
			.optional(),
		// 旧版客户端可能仍会发送邮箱，因此保留格式校验以维持协议兼容；新上架流程不再
		// 收集该字段。缺失时仓储写入 NULL，不能为了满足旧表约束伪造占位联系方式。
		email: z.string().trim().email({ message: "email 格式不合法" }).optional(),
		// 案例是可选的选择证据，不应增加首次上架门槛；限制为三条，避免候选快照和比较页
		// 被未经验证的自述内容淹没。平台真实验收案例仍由工作流结果自动生成。
		portfolioCases: z
			.array(portfolioCaseSchema)
			.max(3, { message: "portfolioCases 最多提交 3 个案例" })
			.optional(),
	})
	.superRefine((input, context) => {
		// 历史 AICP 协议必须拥有双方共享密钥；快速 HTTP 模式则使用可选 Bearer Token。
		// 规则集中在服务端边界，不能依赖前端是否恰好显示了必填星号。
		if (
			input.integrationMode === "aicp_hmac" &&
			input.credentialSecret === undefined
		) {
			context.addIssue({
				code: "custom",
				path: ["credentialSecret"],
				message: "credentialSecret 不能为空",
			});
		}
	});

export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;

export interface FieldError {
	field: string;
	message: string;
}

export type CreateAgentInputParseResult =
	| { success: true; data: CreateAgentInput }
	| { success: false; fieldErrors: FieldError[] };

/** 解析并校验创建 Agent 请求体，失败时返回字段级错误列表（design.md：失败返回字段级错误）。 */
export function parseCreateAgentInput(
	raw: unknown,
): CreateAgentInputParseResult {
	const result = createAgentInputSchema.safeParse(raw);
	if (result.success) {
		return { success: true, data: result.data };
	}

	const fieldErrors: FieldError[] = result.error.issues.map((issue) => ({
		field: issue.path.join(".") || "(root)",
		message: issue.message,
	}));
	return { success: false, fieldErrors };
}
