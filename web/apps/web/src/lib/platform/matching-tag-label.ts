import type { AppLocale } from "@/lib/i18n/locale";

/**
 * 匹配协议使用稳定的 canonical 标签，产品界面使用用户能理解的名称。映射集中在这里，
 * 避免候选卡、Agent 详情和任务记录分别把 `research` 翻译成不同文案；未进入平台词表
 * 的自定义标签必须原样展示，不能由前端猜测、翻译或丢弃其含义。
 */
const LABELS_BY_CANONICAL: Readonly<
	Record<string, Readonly<Record<AppLocale, string>>>
> = {
	research: {
		en: "Academic research",
		"zh-CN": "学术研究",
	},
	"browser-agent": {
		en: "Web browsing",
		"zh-CN": "网页浏览",
	},
	stagehand: {
		en: "Adaptive browsing",
		"zh-CN": "智能浏览",
	},
	"web-research": {
		en: "Information research",
		"zh-CN": "资料调研",
	},
	langgraph: {
		en: "Durable workflow",
		"zh-CN": "持续执行",
	},
};

export function matchingTagLabel(tag: string, locale: AppLocale): string {
	return LABELS_BY_CANONICAL[tag]?.[locale] ?? tag;
}
