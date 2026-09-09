import { describe, expect, it } from "vitest";

import {
  DesignArtifactSchema,
  RequirementsArtifactSchema,
  type DesignDraft,
  type WorkflowExecutionInput,
} from "../src/domain.js";
import { renderDesignScreens } from "../src/design-renderer.js";
import {
  codeGenerationPrompt,
	codePageGenerationPrompt,
	codeStylesGenerationPrompt,
	generationPrompt,
} from "../src/prompts.js";

describe("coding generation prompt", () => {
  it("asks for the requested product screen instead of defaulting to a workflow-stage UI", () => {
    const input = codingInput();
    const prompt = codeGenerationPrompt(input);

    expect(prompt).toContain("展示 USDC 托管余额、Agent 分配状态和验收后的结算动作");
		expect(prompt).toContain("Authoritative validated DesignSpec");
		expect(prompt).toContain("Do not replace the designed product with a PRD workflow");
    expect(prompt).toContain("确认验收");
		expect(prompt).toContain('"kind":"table"');
		expect(prompt).toContain('"requiredDesignIds":["page-shell","hero","section-1-funds"');
		expect(prompt).toContain('"requiredVisibleTexts":["EscrowOS","任务","结算","连接钱包"');
		expect(prompt).toContain("Authoritative rendered design images");
		expect(prompt).toContain("<svg");
		expect(prompt).toContain("The rendered design images are the visual source of truth");
		expect(prompt).toContain("complete app/globals.css source");
		expect(prompt).toContain("<<<AICP_GLOBALS_CSS>>>");
		expect(prompt).toContain("self-contained JSX <svg> or CSS gradients");
		expect(prompt).toContain("Never encode artwork as a CSS url()");
		expect(prompt).toContain("app/page.tsx must be at most 30,000 characters");
		expect(prompt).toContain("readonly data arrays rendered through shared components and .map()");
		expect(prompt).toContain("never duplicate the page markup for each breakpoint");
		expect(prompt).not.toContain("page.tsx (untrusted source to preserve)");
		expect(prompt).not.toContain("platform derives colors");
		expect(prompt).not.toContain("below 6,000 characters");
    expect(prompt).not.toContain("Build exactly one workflow screen");
  });

	it("可靠状态机让 CSS 明确消费已经验收的 TSX", () => {
		const input = codingInput();
		const acceptedPage = "export default function Page(){return <main className=\"escrow-shell\">已验收页面</main>}";
		const pagePrompt = codePageGenerationPrompt(input);
		const stylesPrompt = codeStylesGenerationPrompt(input, acceptedPage);

		expect(pagePrompt).toContain("Return raw TSX only");
		expect(pagePrompt).toContain('"requiredVisibleTexts":["EscrowOS","任务","结算","连接钱包"');
		expect(pagePrompt).toContain("Target 12,000 to 16,000 source characters and never exceed 28,000");
		expect(pagePrompt).toContain("do not copy the rendered reference SVG source into the TSX");
		expect(pagePrompt).not.toContain("<<<AICP_GLOBALS_CSS>>>");
		expect(stylesPrompt).toContain(acceptedPage);
		expect(stylesPrompt).toContain("style this exact tree without rewriting it");
		expect(stylesPrompt).toContain("Return raw CSS only");
	});
});

describe("design specification generation prompt", () => {
	it("只要求结构化设计决策，不再要求模型生成 SVG、TSX 或 CSS", () => {
	  const coding = codingInput();
	  const input: Extract<WorkflowExecutionInput, { step: "design" }> = {
		schemaVersion: "workflow.execute.v0.1",
		taskId: coding.taskId,
		step: "design",
		agentId: "design-mastra",
		userRequest: coding.userRequest,
		requirements: coding.requirements,
	  };
	  const prompt = generationPrompt(input);

	  expect(prompt).toContain("Design one believable primary screen, not a wireframe");
	  expect(prompt).toContain("Every navigation.action and sections[].items[].action must be one plain string or null, never an object");
	  expect(prompt).toContain("Do not output SVG or HTML");
	  expect(prompt).not.toContain("app/page.tsx");
	  expect(prompt).not.toContain("globals.css");
	});
});

function codingInput(): Extract<WorkflowExecutionInput, { step: "code" }> {
  const generatedAt = "2026-08-28T00:00:00.000Z";
  const requirements = RequirementsArtifactSchema.parse({
    schemaVersion: "requirements.artifact.v0.1",
    taskId: "task-escrow-dashboard",
    title: "USDC 托管任务工作台",
    problemStatement: "任务发布者需要清楚查看托管资金、执行状态和验收结算，才能安全推进真实任务。",
    targetUsers: ["任务发布者"],
    goals: ["在一个页面完成托管任务的查看与验收"],
    nonGoals: ["不实现钱包私钥托管"],
    userStories: [{
      id: "US-1",
      statement: "作为任务发布者，我希望查看任务托管和执行状态。",
      acceptanceCriteria: ["状态和金额清晰可见"],
    }],
    functionalRequirements: ["展示 USDC 托管余额、Agent 分配状态和验收后的结算动作"],
    constraints: ["使用 React 与 Next.js 实现"],
    assumptions: [],
    openQuestions: [],
    executableTasks: [{
      id: "T-1",
      title: "实现托管工作台",
      description: "实现托管金额、状态时间线和验收操作。",
      dependsOn: [],
      acceptanceCriteria: ["核心流程可交互体验"],
    }],
    generatedBy: { agentId: "code-direct", strategy: "direct" },
    generatedAt,
  });
	  const designDraft: DesignDraft = {
    title: "USDC 托管工作台设计",
    direction: "用清晰的资金摘要、状态时间线和高风险操作确认区建立可信的任务验收体验。",
    tokens: {
      primaryColor: "#6D5DFB",
      secondaryColor: "#64748B",
      backgroundColor: "#F8FAFC",
      textColor: "#0F172A",
      borderRadius: "12px",
      spacingBase: "8px",
      fontFamily: "system-ui, sans-serif",
    },
    pages: [{
      id: "dashboard",
      name: "任务托管工作台",
      purpose: "让发布者查看资金、Agent 执行进度并完成验收。",
      sections: ["资金摘要", "执行进度", "交付验收"],
    }],
    components: [{
      id: "dashboard-root",
      name: "工作台",
      parentId: null,
      responsibility: "承载托管任务的查看与验收操作",
      states: ["执行中", "待验收", "已结算"],
    }],
    interactionRules: ["确认验收前展示结算金额与后果"],
    responsiveRules: ["移动端纵向排列摘要与操作区"],
    accessibilityRules: ["所有操作可通过键盘访问"],
    assetPlan: [],
		preview: {
			navigation: { brand: "EscrowOS", items: [{ label: "任务", active: true }, { label: "结算", active: false }], action: "连接钱包" },
			hero: { eyebrow: "任务托管", title: "USDC 托管工作台", description: "查看资金、Agent 执行进度并完成里程碑验收。", primaryAction: "确认验收", secondaryAction: "查看链上凭证" },
			metrics: [{ label: "托管金额", value: "120 USDC", detail: "资金已锁定", tone: "success" }],
			sections: [
				{ id: "funds", kind: "cards", layout: "split", title: "资金概览", description: "本任务资金状态", items: previewItems("托管本金", "120 USDC") },
				{ id: "progress", kind: "progress", layout: "split", title: "执行进度", description: "Agent 自动更新", items: previewItems("界面设计", "68%") },
				{ id: "settlement", kind: "table", layout: "full", title: "结算明细", description: "验收后释放", items: previewItems("设计里程碑", "35 USDC") },
			],
		},
	  };
	  const design = DesignArtifactSchema.parse({
		...designDraft,
		schemaVersion: "design.artifact.v0.4",
		taskId: "task-escrow-dashboard",
		rendererVersion: "aicp-design-renderer.v1",
		renderedScreens: renderDesignScreens(designDraft),
		generatedBy: { agentId: "code-direct", strategy: "direct" },
		generatedAt,
	  });

  return {
    schemaVersion: "workflow.execute.v0.1",
    taskId: "task-escrow-dashboard",
    step: "code",
    agentId: "code-direct",
    userRequest: "开发一个可以查看 USDC 托管、Agent 执行进度并验收结算的任务工作台。",
    requirements,
    design,
  };
}

function previewItems(title: string, value: string) {
	return [0, 1].map((index) => ({
		title: `${title}${index + 1}`,
		description: `${title}的状态说明`,
		value,
		status: index === 0 ? "已完成" : "进行中",
		progress: index === 0 ? 100 : 68,
		action: "查看详情",
		tone: index === 0 ? "success" as const : "primary" as const,
	}));
}
