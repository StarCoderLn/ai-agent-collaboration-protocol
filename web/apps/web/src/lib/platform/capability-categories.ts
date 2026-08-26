import type { TaskCategory } from "@/lib/api/tasks";
import type { MessageId } from "@/lib/i18n/messages";

export type SelectableCapabilityCategory = Readonly<{
	id: string;
	label: string;
}>;

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
	const output: SelectableCapabilityCategory[] = [];

	const visit = (nodes: readonly TaskCategory[]) => {
		for (const node of nodes) {
			if (node.children.length > 0) {
				visit(node.children);
				continue;
			}

			const conciseLabel = CONCISE_CATEGORY_LABEL_BY_SLUG[node.slug];
			output.push({
				id: node.id,
				label: conciseLabel === undefined ? node.name : translate(conciseLabel),
			});
		}
	};

	visit(categories);
	return output;
}

/**
 * slug 是平台分类的稳定业务键，适合承载面向用户的短名称映射。未知的新分类会回退到
 * 服务端名称，因此运营扩充分类后不会因前端尚未发布对应文案而从选择器中消失。
 */
const CONCISE_CATEGORY_LABEL_BY_SLUG: Readonly<
	Partial<Record<string, MessageId>>
> = {
	"product-requirements": "产品需求",
	"product-interface-design": "界面设计",
	"software-development": "代码开发",
	"research-analysis": "研究分析",
	"document-content": "内容写作",
	"image-design": "图片设计",
	"video-production": "视频制作",
	"data-processing": "数据处理",
};
