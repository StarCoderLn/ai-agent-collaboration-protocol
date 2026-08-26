import { describe, expect, it } from "vitest";
import { WORKFLOW_AGENT_CATALOG } from "../src/catalog.js";
import {
	CodeArtifactSchema,
	CodeDraftSchema,
  DesignDraftSchema,
	DesignArtifactSchema,
	finalizeArtifact,
	renderSafeDesignPreview,
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

  it("escapes model-controlled text before placing it in the SVG preview", () => {
    const draft = DesignDraftSchema.parse({
      title: "设计稿",
      direction: "<script>alert('xss')</script> 清晰可信的工作流界面",
      tokens: {
        primaryColor: "#123456",
        secondaryColor: "#abcdef",
        backgroundColor: "#f5f5f5",
        textColor: "#111111",
        borderRadius: "8px",
        spacingBase: "8px",
        fontFamily: "sans-serif",
      },
      pages: [
        {
          id: "home",
          name: "<首页>",
          purpose: "展示工作流步骤和每一步的三个 Agent 候选。",
          sections: ["需求 & 选择", "设计", "Coding"],
        },
      ],
      components: [
        {
          id: "root",
          name: "根组件",
          parentId: null,
          responsibility: "承载整个页面结构",
          states: ["默认"],
        },
      ],
      interactionRules: ["选择后执行"],
      responsiveRules: ["窄屏纵向排列"],
      accessibilityRules: ["表单均有标签"],
      assetPlan: [],
    });

    const svg = renderSafeDesignPreview(draft);
    expect(svg).toContain("&lt;首页&gt;");
    expect(svg).toContain("需求 &amp; 选择");
    expect(svg).not.toContain("<script>");
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
		}, generatedAt));
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
		expect(artifact.implementationSummary).toContain("快速代码生成 Agent");
		expect(artifact.testPlan).toContain("运行 pnpm install 与 pnpm build，确认 TypeScript 和 Next.js 构建通过");
	});
});
