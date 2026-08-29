import { describe, expect, it } from "vitest";
import { WORKFLOW_AGENT_CATALOG } from "../src/catalog.js";
import {
	CodeArtifactSchema,
	CodeDraftSchema,
		DesignArtifactSchema,
		DesignPreviewSchema,
		finalizeArtifact,
		PrototypeFilesSchema,
	RequirementsArtifactSchema,
  WorkflowExecutionInputSchema,
} from "../src/domain.js";

describe("workflow domain contracts", () => {
  it("publishes exactly three distinct strategies for every workflow step", () => {
    for (const step of ["requirements", "design", "code"] as const) {
      const candidates = WORKFLOW_AGENT_CATALOG.filter((agent) => agent.step === step);
      expect(candidates).toHaveLength(3);
      expect(new Set(candidates.map((agent) => agent.strategy))).toEqual(
        new Set(["direct", "mastra", "state-machine"]),
      );
    }
    expect(new Set(WORKFLOW_AGENT_CATALOG.map((agent) => agent.id))).toHaveLength(9);
  });

  it("rejects an Agent selected for the wrong workflow step", () => {
    const parsed = WorkflowExecutionInputSchema.safeParse({
      schemaVersion: "workflow.execute.v0.1",
      taskId: "task-1",
      step: "requirements",
      agentId: "design-direct",
      userRequest: "为独立开发者设计一个能够比较多个 Agent 结果的产品。",
    });

    expect(parsed.success).toBe(false);
  });

	  it("只接受包含足够设计锚点且不引用外部资源的可运行原型", () => {
	    expect(PrototypeFilesSchema.safeParse(validPrototype()).success).toBe(true);
	    expect(PrototypeFilesSchema.safeParse({
	      ...validPrototype(),
	      pageTsx: "export default function Page(){return <main data-design-id=\"only-one\">原型</main>};".padEnd(320, " "),
	    }).success).toBe(false);
	    expect(PrototypeFilesSchema.safeParse({
	      ...validPrototype(),
	      globalsCss: "@import url('https://example.com/theme.css');".padEnd(320, " "),
	    }).success).toBe(false);
	  });

	it("拒绝只有抽象区块名称或标题的线框式设计预览", () => {
		const preview = validDesignPreview();
		const firstSection = preview.sections[0];
		if (firstSection === undefined) throw new Error("测试预览必须包含第一个区块");
		firstSection.title = "指标卡片区域";
		expect(DesignPreviewSchema.safeParse(preview).success).toBe(false);

		const emptyItemPreview = validDesignPreview();
		const withoutItemContent = {
			...emptyItemPreview,
			sections: emptyItemPreview.sections.map((section, sectionIndex) => ({
				...section,
				items: section.items.map((item, itemIndex) => sectionIndex === 0 && itemIndex === 0
					? { ...item, description: null, value: null, status: null, progress: null, action: null }
					: item),
			})),
		};
		expect(DesignPreviewSchema.safeParse(withoutItemContent).success).toBe(false);
	});

	it("在模型边界把对象形式的操作标签规范化为内部字符串", () => {
		const preview = validDesignPreview();
		const parsed = DesignPreviewSchema.parse({
			...preview,
			navigation: preview.navigation === null
				? null
				: { ...preview.navigation, action: { label: "发布任务" } },
			sections: preview.sections.map((section, index) => ({
				...section,
				items: section.items.map((item, itemIndex) => index === 0 && itemIndex === 0
					? { ...item, action: { label: "查看详情" } }
					: item),
			})),
		});

		expect(parsed.navigation?.action).toBe("发布任务");
		expect(parsed.sections[0]?.items[0]?.action).toBe("查看详情");
	});

	it("代码制品要求文件树与文件完全对应且受总长度预算约束", () => {
		const base = {
			title: "紧凑原型",
			implementationSummary: "生成一个能够本地运行并用于体验核心流程的紧凑 Next.js 原型。",
			fileTree: ["app/page.tsx"],
			files: [{ path: "app/page.tsx", language: "tsx", content: "export default function Page(){return <main />};" }],
			runInstructions: ["pnpm dev"],
			testPlan: ["检查首页可渲染"],
			limitations: [],
		};
		expect(CodeDraftSchema.safeParse(base).success).toBe(true);
		expect(CodeDraftSchema.safeParse({ ...base, fileTree: ["app/missing.tsx"] }).success).toBe(false);
		expect(CodeDraftSchema.safeParse({
			...base,
			fileTree: ["a", "b", "c"],
			files: [
				{ path: "a", language: "text", content: "a".repeat(14_000) },
				{ path: "b", language: "text", content: "b".repeat(14_000) },
				{ path: "c", language: "text", content: "c".repeat(14_000) },
			],
		}).success).toBe(false);
	});

	it("把模型生成的单页代码装配进固定且可运行的 Next.js 脚手架", () => {
		const generatedAt = new Date("2026-08-22T00:00:00.000Z");
		const requirements = RequirementsArtifactSchema.parse(finalizeArtifact({
			schemaVersion: "workflow.execute.v0.1",
			taskId: "task-code-1",
			step: "requirements",
			agentId: "prd-direct",
			userRequest: "开发一个能够依次验收 PRD、设计和 Coding 制品的 Agent 市场。",
		}, {
			title: "Agent 市场",
			problemStatement: "用户需要在一个可信流程中逐步选择 Agent，并验收每一步的结构化交付物。",
			targetUsers: ["产品创建者"], goals: ["跑通三步流程"], nonGoals: ["不执行生产部署"],
			userStories: [{ id: "US-1", statement: "逐步验收", acceptanceCriteria: ["下游按验收解锁"] }],
			functionalRequirements: ["展示三步状态"], constraints: [], assumptions: [], openQuestions: [],
			executableTasks: [{ id: "T-1", title: "实现", description: "实现核心流程", dependsOn: [], acceptanceCriteria: ["页面可运行"] }],
		}, generatedAt));
		const design = DesignArtifactSchema.parse(finalizeArtifact({
			schemaVersion: "workflow.execute.v0.1", taskId: "task-code-1", step: "design",
			agentId: "design-direct", userRequest: "开发一个能够依次验收 PRD、设计和 Coding 制品的 Agent 市场。",
			requirements,
		}, {
			title: "设计", direction: "清晰展示三个串联步骤，并突出当前状态与人工验收入口。",
			tokens: { primaryColor: "#123456", secondaryColor: "#abcdef", backgroundColor: "#f5f5f5", textColor: "#111111", borderRadius: "8px", spacingBase: "8px", fontFamily: "sans-serif" },
			pages: [{ id: "main", name: "主流程", purpose: "展示完整工作流步骤与交付物。", sections: ["PRD", "设计", "Coding"] }],
			components: [{ id: "root", name: "流程", parentId: null, responsibility: "展示三个步骤", states: ["默认"] }],
			interactionRules: ["验收后解锁"], responsiveRules: ["窄屏纵向排列"], accessibilityRules: ["按钮有名称"], assetPlan: [],
			preview: validDesignPreview(),
			prototype: validPrototype(),
		}, generatedAt));
		expect(design.schemaVersion).toBe("design.artifact.v0.3");
		const pageTsx = `"use client";\nexport default function Page(){return <main><h1>Agent 工作流</h1></main>}`;
		const artifact = CodeArtifactSchema.parse(finalizeArtifact({
			schemaVersion: "workflow.execute.v0.1", taskId: "task-code-1", step: "code",
			agentId: "code-direct", userRequest: "开发一个能够依次验收 PRD、设计和 Coding 制品的 Agent 市场。",
			requirements, design,
		}, {
			pageTsx: pageTsx.padEnd(120, " "),
		}, generatedAt));

		expect(artifact.fileTree).toEqual(["package.json", "app/layout.tsx", "app/page.tsx", "app/globals.css", "README.md"]);
		expect(artifact.files.find((file) => file.path === "app/page.tsx")?.content.trim()).toBe(pageTsx);
		expect(artifact.files.find((file) => file.path === "package.json")?.content).toContain('"next": "16.3.1"');
		const globalStyles = artifact.files.find((file) => file.path === "app/globals.css")?.content;
		expect(globalStyles).toBe(design.prototype.globalsCss);
		expect(artifact.implementationSummary).toContain("快速代码生成 Agent");
		expect(artifact.testPlan).toContain("运行 pnpm install 与 pnpm build，确认 TypeScript 和 Next.js 构建通过");
	});
});

function validDesignPreview() {
	return {
		navigation: {
			brand: "AgentOS",
			items: [{ label: "任务", active: true }, { label: "Agent", active: false }],
			action: "发布任务",
		},
		hero: {
			eyebrow: "协作工作台",
			title: "多 Agent 任务执行",
			description: "在一个页面查看任务进展、设计交付和分阶段验收状态。",
			primaryAction: "查看当前产物",
			secondaryAction: "管理 Agent",
		},
		metrics: [
			{ label: "整体进度", value: "68%", detail: "设计阶段进行中", tone: "primary" as const },
			{ label: "托管预算", value: "120 USDC", detail: "资金已锁定", tone: "success" as const },
		],
		sections: [
			{
				id: "workflow", kind: "progress" as const, layout: "full" as const,
				title: "交付进度", description: "三个阶段自动串行执行",
				items: [
					{ title: "需求澄清", description: "PRD 已通过自动验收", value: null, status: "已完成", progress: 100, action: "查看", tone: "success" as const },
					{ title: "界面设计", description: "正在生成可评审设计稿", value: null, status: "进行中", progress: 68, action: "查看", tone: "primary" as const },
				],
			},
			{
				id: "agents", kind: "cards" as const, layout: "grid-2" as const,
				title: "执行 Agent", description: null,
				items: [
					{ title: "需求分析 Agent", description: "已交付结构化 PRD", value: "1.2s", status: "完成", progress: null, action: null, tone: "success" as const },
					{ title: "产品设计 Agent", description: "生成高保真页面模型", value: "68%", status: "执行中", progress: 68, action: null, tone: "primary" as const },
				],
			},
			{
				id: "settlement", kind: "table" as const, layout: "full" as const,
				title: "里程碑结算", description: "最终验收后释放对应预算",
				items: [
					{ title: "需求阶段", description: "PRD 文档", value: "20 USDC", status: "已结算", progress: null, action: "凭证", tone: "success" as const },
					{ title: "设计阶段", description: "高保真设计稿", value: "35 USDC", status: "待验收", progress: null, action: "验收", tone: "warning" as const },
				],
			},
		],
	};
}

function validPrototype() {
	return {
		pageTsx: [
			"// 测试夹具刻意包含完整页面说明，确保协议验证的是可评审原型而不是一行占位代码。",
			"// 页面必须保留稳定设计锚点，Coding Agent 才能证明自己继承而不是重新设计上游产物。",
			"export default function Page() {",
			"  return <main data-design-id=\"page-shell\"><header data-design-id=\"product-header\"><h1>任务工作台</h1></header><section data-design-id=\"task-summary\">查看任务进度与托管状态</section><section data-design-id=\"delivery-panel\"><button>确认验收</button></section></main>;",
			"}",
		].join("\n"),
		globalsCss: [
			"/* 测试样式包含完整视觉基线，保证下游能够逐字继承设计阶段确定的颜色、间距与结构。 */",
			"/* 原型不允许远程资源，所有可见效果必须由这份自包含样式完成。 */",
			"*{box-sizing:border-box}",
			"body{margin:0;background:#090b18;color:#f8fafc;font-family:system-ui,sans-serif}",
			"main{min-height:100vh;padding:48px}header,section{max-width:1080px;margin:0 auto 20px;padding:24px;border:1px solid #30365f;border-radius:16px}button{cursor:pointer;padding:12px 18px;border-radius:10px}",
		].join("\n"),
	};
}
