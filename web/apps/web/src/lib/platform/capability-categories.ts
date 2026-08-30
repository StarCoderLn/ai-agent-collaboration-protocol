import type { TaskCategory } from "@/lib/api/tasks";
import type { MessageId } from "@/lib/i18n/messages";

export type SelectableCapabilityCategory = Readonly<{
	id: string;
	label: string;
}>;

type SelectableCategoryWithOrder = SelectableCapabilityCategory &
	Readonly<{ order: number }>;

/**
 * 平台分类树同时包含“运营分组”和“可参与匹配的具体分类”。普通用户只应选择没有
 * 子节点的具体分类；否则父分类与子分类同时出现，会让人无法判断选择父级是否包含
 * 全部子级。四个入口（发布任务、上架 Agent、任务市场、Agent 市场）必须复用这里，
 * 保证用户看到的名称和真正提交/筛选的分类 ID 始终一致。
 */
export function listSelectableCapabilityCategories(
	categories: readonly TaskCategory[],
	translate: (id: MessageId) => string,
): readonly SelectableCapabilityCategory[] {
	const output: SelectableCategoryWithOrder[] = [];

	const visit = (nodes: readonly TaskCategory[]) => {
		for (const node of nodes) {
			if (node.children.length > 0) {
				visit(node.children);
				continue;
			}

			const presentation = CATEGORY_PRESENTATION_BY_SLUG[node.slug];
			output.push({
				id: node.id,
				label:
					presentation === undefined
						? node.name
						: translate(presentation.label),
				order: presentation?.order ?? Number.MAX_SAFE_INTEGER,
			});
		}
	};

	visit(categories);
	return output
		.sort((left, right) => left.order - right.order)
		.map(({ id, label }) => ({ id, label }));
}

/**
 * slug 是平台分类的稳定业务键，适合承载面向用户的短名称映射。未知的新分类会回退到
 * 服务端名称，因此运营扩充分类后不会因前端尚未发布对应文案而从选择器中消失。
 */
const CATEGORY_PRESENTATION_BY_SLUG: Readonly<
	Partial<Record<string, Readonly<{ label: MessageId; order: number }>>>
> = {
	"software-development": { label: "软件与网站开发", order: 10 },
	"product-requirements": { label: "产品方案与 PRD", order: 20 },
	"product-interface-design": { label: "UI/UX 设计", order: 30 },
	"image-design": { label: "图片与视觉设计", order: 40 },
	"document-content": { label: "文案与内容", order: 50 },
	"video-production": { label: "视频与动画", order: 60 },
	"data-processing": { label: "数据分析", order: 70 },
	"research-analysis": { label: "研究与报告", order: 80 },
};
