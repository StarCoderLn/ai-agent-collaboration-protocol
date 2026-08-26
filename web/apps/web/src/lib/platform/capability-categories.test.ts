import { describe, expect, it } from "vitest";

import type { TaskCategory } from "@/lib/api/tasks";
import type { MessageId } from "@/lib/i18n/messages";
import { listSelectableCapabilityCategories } from "./capability-categories";

const categories: readonly TaskCategory[] = [
	{
		id: "parent",
		parentId: null,
		name: "产品与开发",
		slug: "product-development",
		version: 1,
		children: [
			{
				id: "code",
				parentId: "parent",
				name: "软件开发",
				slug: "software-development",
				version: 1,
				children: [],
			},
			{
				id: "future-service",
				parentId: "parent",
				name: "新运营分类",
				slug: "future-service",
				version: 1,
				children: [],
			},
		],
	},
	{
		id: "research",
		parentId: null,
		name: "研究分析",
		slug: "research-analysis",
		version: 1,
		children: [],
	},
];

describe("listSelectableCapabilityCategories", () => {
	it("returns only leaf IDs, uses concise labels and preserves unknown server categories", () => {
		const translate = (id: MessageId): string => `translated:${id}`;

		expect(listSelectableCapabilityCategories(categories, translate)).toEqual([
			{ id: "code", label: "translated:代码开发" },
			// 未知 slug 必须回退服务端名称，确保新增运营分类无需等待前端发版才可用。
			{ id: "future-service", label: "新运营分类" },
			{ id: "research", label: "translated:研究分析" },
		]);
	});
});
