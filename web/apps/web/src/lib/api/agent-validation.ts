/**
 * Agent 配置编辑表单的前端字段校验规则。
 *
 * 权威规则来自 services/business-api/src/agents/patch-agent.ts 的
 * `patchAgentBodySchema`（后端会二次校验，不信任本文件的结果，见 F-003）；
 * 这里只是同一套规则在前端的镜像实现，用于提交前即时展示字段级错误
 * （requirements.md AC-001/AC-006），避免用户等待一次网络往返才发现格式问题。
 */

import {
	isMatchingTagSyntaxValid,
	MAX_MATCHING_TAG_COUNT,
	MAX_MATCHING_TAG_LENGTH,
	normalizeMatchingTag,
} from "@/lib/platform/matching-tags";

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SERVICE_ENDPOINT_PATTERN = /^https?:\/\//;
const UUID_PATTERN =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NON_NEGATIVE_INTEGER_STRING_PATTERN = /^\d+$/;

export interface AgentEditFormValues {
	name: string;
	categoryId: string;
	capabilityDesc: string;
	tags: string[];
	pricingType: string;
	priceAmount: string;
	priceCurrency: string;
	serviceEndpoint: string;
	email: string;
}

export type AgentEditFormErrors = Partial<
	Record<keyof AgentEditFormValues, string>
>;

export function validateAgentEditForm(
	values: AgentEditFormValues,
): AgentEditFormErrors {
	const errors: AgentEditFormErrors = {};

	if (values.name.trim().length === 0) {
		errors.name = "名称不能为空";
	}
	if (!UUID_PATTERN.test(values.categoryId)) {
		errors.categoryId = "分类 ID 格式非法";
	}
	if (values.capabilityDesc.trim().length === 0) {
		errors.capabilityDesc = "能力描述不能为空";
	}
	const normalizedTags = [
		...new Set(values.tags.map(normalizeMatchingTag).filter(Boolean)),
	];
	if (normalizedTags.length === 0) {
		errors.tags = "至少填写一个标签";
	} else if (normalizedTags.length > MAX_MATCHING_TAG_COUNT) {
		errors.tags = `最多填写 ${MAX_MATCHING_TAG_COUNT} 个标签`;
	} else if (
		normalizedTags.some(
			(tag) =>
				[...tag].length > MAX_MATCHING_TAG_LENGTH ||
				!isMatchingTagSyntaxValid(tag),
		)
	) {
		errors.tags = `每个标签最多 ${MAX_MATCHING_TAG_LENGTH} 个字符，且不能包含逗号或控制字符`;
	}
	if (values.pricingType.trim().length === 0) {
		errors.pricingType = "计价方式不能为空";
	}
	if (!NON_NEGATIVE_INTEGER_STRING_PATTERN.test(values.priceAmount)) {
		errors.priceAmount = "报价必须是非负整数字符串（最小单位）";
	}
	if (values.priceCurrency.trim().length === 0) {
		errors.priceCurrency = "币种不能为空";
	}
	if (!SERVICE_ENDPOINT_PATTERN.test(values.serviceEndpoint)) {
		errors.serviceEndpoint = "服务地址必须是合法的 http(s) URL";
	}
	if (!EMAIL_PATTERN.test(values.email)) {
		errors.email = "邮箱格式非法";
	}

	return errors;
}

export function hasFormErrors(errors: AgentEditFormErrors): boolean {
	return Object.keys(errors).length > 0;
}
