import { describe, expect, it } from "vitest";

import { renderDesignScreens } from "../src/design-renderer.js";
import { DesignDraftSchema, RenderedDesignScreensSchema } from "../src/domain.js";

describe("可信设计稿渲染器", () => {
  // 设计图片既是用户验收产物，也是 Coding Agent 需要继承的视觉事实；测试固定其稳定
  // 输出和结构化输入边界，防止后续又退化成只返回一段无法直观看效果的原型源码。
	it("从同一份 DesignSpec 确定性生成桌面端和移动端设计稿", () => {
		const draft = designDraft();
		const first = renderDesignScreens(draft);
		const second = renderDesignScreens(draft);

		expect(first).toEqual(second);
		expect(first.map((screen) => screen.id)).toEqual(["desktop", "mobile"]);
		expect(first[0]?.viewport).toEqual({ width: 1_440, height: 900 });
		expect(first[1]?.viewport).toEqual({ width: 390, height: 844 });
		expect(RenderedDesignScreensSchema.safeParse(first).success).toBe(true);
	});

	it("把设计 token 和任务特异性内容写入图片，并转义用户文字", () => {
		const draft = designDraft();
		const screens = renderDesignScreens({
			...draft,
			title: "电商营销 <script>alert(1)</script>",
		});
		const desktop = screens[0]?.content ?? "";

		expect(desktop).toContain("#5B4CF0");
		expect(desktop).toContain("今日转化率");
		expect(desktop).toContain("电商营销 &lt;script&gt;alert(1)&lt;/script&gt;");
		expect(desktop).not.toContain("<script>");
	});

	it("深色主题使用半透明 token 表面，避免浅色文字落在固定白卡片上", () => {
		const draft = designDraft();
		const desktop = renderDesignScreens({
			...draft,
			tokens: { ...draft.tokens, backgroundColor: "#080B18", textColor: "#F8FAFC" },
		})[0]?.content ?? "";

		expect(desktop).toContain('fill="#F8FAFC" fill-opacity=".05"');
		expect(desktop).toContain("ui-sans-serif,system-ui,sans-serif");
	});
});

function designDraft() {
	return DesignDraftSchema.parse({
		title: "电商增长工作台",
		direction: "以转化漏斗、活动进度和重点商品为核心，让运营人员快速判断营销表现并采取行动。",
		tokens: {
			primaryColor: "#5B4CF0",
			secondaryColor: "#12A594",
			backgroundColor: "#F5F7FF",
			textColor: "#151A2D",
			borderRadius: "16px",
			spacingBase: "8px",
			fontFamily: "Inter, system-ui",
		},
		pages: [{ id: "dashboard", name: "增长工作台", purpose: "展示营销活动与转化表现。", sections: ["概览", "活动", "商品"] }],
		components: [{ id: "root", name: "工作台", parentId: null, responsibility: "组织增长指标与行动入口", states: ["默认"] }],
		interactionRules: ["点击活动进入详情"],
		responsiveRules: ["移动端改为单列"],
		accessibilityRules: ["操作具有可读名称"],
		assetPlan: [],
		preview: {
			navigation: { brand: "GrowthOS", items: [{ label: "概览", active: true }, { label: "活动", active: false }], action: "创建活动" },
			hero: { eyebrow: "实时增长", title: "让每场活动都清晰可控", description: "集中查看收入、转化和执行进度，优先处理最有影响的增长机会。", primaryAction: "查看活动", secondaryAction: "导出报告" },
			metrics: [{ label: "今日转化率", value: "8.4%", detail: "较昨日 +1.2%", tone: "success" }],
			sections: [
				section("campaigns", "cards", "进行中的活动", "夏日焕新", "已完成 68%"),
				section("funnel", "progress", "转化漏斗", "加入购物车", "12,480 人"),
				section("products", "table", "重点商品", "轻量通勤包", "¥ 399"),
			],
		},
	});
}

function section(
	id: string,
	kind: "cards" | "progress" | "table",
	title: string,
	itemTitle: string,
	value: string,
) {
	return {
		id,
		kind,
		layout: kind === "table" ? "full" as const : "grid-2" as const,
		title,
		description: `${title}的实时业务数据`,
		items: [0, 1].map((index) => ({
			title: `${itemTitle}${index + 1}`,
			description: "可直接用于判断表现的示例数据",
			value,
			status: index === 0 ? "表现良好" : "需要关注",
			progress: index === 0 ? 82 : 56,
			action: "查看详情",
			tone: index === 0 ? "success" as const : "warning" as const,
		})),
	};
}
