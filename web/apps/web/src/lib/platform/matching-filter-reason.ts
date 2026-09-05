import type { MessageId } from "@/lib/i18n/messages";

/**
 * 分发引擎使用稳定的英文 reason code 保存匹配证据，页面只通过本表转换成人类可读
 * 文案。集中维护映射可以避免旧版任务候选区和正式工作流候选区对同一原因说法不同。
 */
const FILTER_REASON_MESSAGES = {
	wrong_category: "任务分类不匹配",
	inactive_agent: "未过审、已暂停或已下架",
	over_budget: "报价超出价格上限",
	currency_mismatch: "报价币种不一致",
	deadline_passed: "任务截止时间已过",
	cannot_meet_deadline: "预计无法按时交付",
	probation_budget_exceeded: "Agent 当前报价超出冷启动风险上限",
} as const satisfies Readonly<Record<string, MessageId>>;

export function matchingFilterReasonMessageId(reason: string): MessageId {
	return (
		FILTER_REASON_MESSAGES[reason as keyof typeof FILTER_REASON_MESSAGES] ??
		"未满足平台硬约束"
	);
}
