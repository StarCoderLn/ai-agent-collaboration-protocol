import { describe, expect, it } from "vitest";

import type { ResultSubmissionInput } from "../tasks/execution-input";
import { evaluateAutomaticAcceptance } from "./workflow-automatic-acceptance";

describe("evaluateAutomaticAcceptance", () => {
  it("终端节点始终保留人工验收，不让执行 Agent 自己触发结算", () => {
    expect(evaluateAutomaticAcceptance({
      taskId: "task-1",
      outputContract: "CodeArtifact",
      hasDownstream: false,
      results: [jsonResult(validRequirements("task-1"))],
    })).toEqual({ kind: "manual", reason: "final_node" });
  });

  it("符合最低质量规则的 PRD 制品可以自动推进下游", () => {
    expect(evaluateAutomaticAcceptance({
      taskId: "task-1",
      outputContract: "RequirementsArtifact",
      hasDownstream: true,
      results: [jsonResult(validRequirements("task-1"))],
    })).toMatchObject({
      kind: "passed",
		ruleVersion: "workflow-intermediate-v4",
      evidence: {
        outputContract: "RequirementsArtifact",
        schemaVersion: "requirements.artifact.v0.1",
        artifactCount: 1,
      },
    });
  });

	it("不包含桌面和移动设计稿的旧设计不能继续自动推进 Coding", () => {
    expect(evaluateAutomaticAcceptance({
      taskId: "task-1",
      outputContract: "DesignArtifact",
      hasDownstream: true,
      results: [jsonResult({
        ...validDesign("task-1"),
        schemaVersion: "design.artifact.v0.2",
		renderedScreens: undefined,
      })],
    })).toMatchObject({
      kind: "failed",
      issues: ["中间制品缺少继续执行所需的结构化字段"],
    });
  });

  it("包含真实内容、状态、操作和多种布局的设计可以推进 Coding", () => {
    expect(evaluateAutomaticAcceptance({
      taskId: "task-1",
      outputContract: "DesignArtifact",
      hasDownstream: true,
      results: [jsonResult(validDesign("task-1"))],
    })).toMatchObject({
      kind: "passed",
		ruleVersion: "workflow-intermediate-v4",
      evidence: {
        outputContract: "DesignArtifact",
		schemaVersion: "design.artifact.v0.4",
      },
    });
  });

  it("含占位文案的设计预览不会被表面完整的 JSON 欺骗", () => {
    const design = validDesign("task-1");
    const firstSection = design.preview.sections[0];
    if (firstSection === undefined) throw new Error("测试设计必须包含第一个区块");
    firstSection.title = "指标卡片区域";
    expect(evaluateAutomaticAcceptance({
      taskId: "task-1",
      outputContract: "DesignArtifact",
      hasDownstream: true,
      results: [jsonResult(design)],
    })).toMatchObject({ kind: "failed" });
  });

	it("缺少移动断点或含脚本的设计稿不能推进 Coding", () => {
		const missingBreakpoint = validDesign("task-1");
		const desktopOnly = missingBreakpoint.renderedScreens[0];
		if (desktopOnly === undefined) throw new Error("测试设计必须包含桌面设计稿");
		missingBreakpoint.renderedScreens[1] = { ...desktopOnly };
		expect(evaluateAutomaticAcceptance({
			taskId: "task-1", outputContract: "DesignArtifact", hasDownstream: true,
			results: [jsonResult(missingBreakpoint)],
		})).toMatchObject({ kind: "failed" });

		const unsafeSvg = validDesign("task-1");
		const desktop = unsafeSvg.renderedScreens[0];
		if (desktop === undefined) throw new Error("测试设计必须包含桌面设计稿");
		desktop.content = `${desktop.content}<script>alert(1)</script>`;
		expect(evaluateAutomaticAcceptance({
			taskId: "task-1", outputContract: "DesignArtifact", hasDownstream: true,
			results: [jsonResult(unsafeSvg)],
		})).toMatchObject({ kind: "failed" });
  });

  it("任务归属或可执行任务缺失时暂停自动推进", () => {
    const invalid = { ...validRequirements("other-task"), executableTasks: [] };
    expect(evaluateAutomaticAcceptance({
      taskId: "task-1",
      outputContract: "RequirementsArtifact",
      hasDownstream: true,
      results: [jsonResult(invalid)],
    })).toMatchObject({
      kind: "failed",
      issues: ["中间制品缺少继续执行所需的结构化字段"],
    });
  });

  it("不支持的中间契约不会被宽松规则误放行", () => {
    expect(evaluateAutomaticAcceptance({
      taskId: "task-1",
      outputContract: "UnknownArtifact",
      hasDownstream: true,
      results: [jsonResult({ taskId: "task-1" })],
    })).toMatchObject({ kind: "failed" });
  });
});

function jsonResult(value: unknown): ResultSubmissionInput["results"][number] {
  return {
    kind: "inline",
    summary: "结构化中间制品",
    mimeType: "application/json",
    generatedAt: "2026-08-29T01:10:00.000Z",
    content: JSON.stringify(value),
  };
}

function validRequirements(taskId: string) {
  return {
    schemaVersion: "requirements.artifact.v0.1",
    taskId,
    generatedAt: "2026-08-29T01:10:00.000Z",
    generatedBy: { agentId: "prd-agent", strategy: "mastra" },
    problemStatement: "团队当前缺少统一任务管理入口，需要建立可追踪的协作工作台。",
    targetUsers: ["项目经理"],
    goals: ["统一管理任务"],
    userStories: [{ id: "US-1", statement: "用户可以查看任务", acceptanceCriteria: ["列表可见"] }],
    functionalRequirements: ["展示任务列表"],
    executableTasks: [{
      id: "T-1",
      title: "实现任务列表",
      description: "实现可分页的任务列表页面",
      dependsOn: [],
      acceptanceCriteria: ["页面可访问"],
    }],
  };
}

function validDesign(taskId: string) {
  const item = (
    title: string,
    status: string,
    tone: "primary" | "success" | "warning",
  ) => ({
    title,
    description: `${title}的真实页面说明`,
    value: null,
    status,
    progress: tone === "success" ? 100 : 64,
    action: "查看详情",
    tone,
  });
  return {
		schemaVersion: "design.artifact.v0.4",
		rendererVersion: "aicp-design-renderer.v1",
    taskId,
    generatedAt: "2026-08-29T01:10:00.000Z",
    generatedBy: { agentId: "design-agent", strategy: "mastra" },
    direction: "使用清晰的信息层级展示任务进度、Agent 状态和分阶段结算结果。",
    tokens: { primaryColor: "#6255E7" },
    pages: [{ id: "dashboard", name: "任务工作台", purpose: "查看任务执行状态" }],
    components: [{ id: "status", name: "状态卡片", responsibility: "展示当前状态" }],
    interactionRules: ["点击任务查看详情"],
    responsiveRules: ["窄屏纵向排列"],
    accessibilityRules: ["交互控件提供可读名称"],
    preview: {
      hero: {
        title: "任务协作工作台",
        description: "集中查看任务、Agent 和最终统一结算的当前状态。",
        primaryAction: "发布新任务",
      },
      metrics: [{ label: "执行中", value: "3" }],
      sections: [
        { id: "tasks", kind: "cards", title: "当前任务", description: "最近执行状态", items: [item("后台管理系统", "执行中", "primary"), item("品牌设计", "已完成", "success")] },
        { id: "agents", kind: "progress", title: "Agent 进度", description: "自动更新", items: [item("需求 Agent", "已完成", "success"), item("设计 Agent", "进行中", "primary")] },
        { id: "settlement", kind: "table", title: "统一结算", description: "全部验收后释放", items: [item("需求确认", "质量已通过", "success"), item("界面设计", "待验收", "warning")] },
      ],
    },
		renderedScreens: [
			designScreen("desktop", 1_440, 900),
			designScreen("mobile", 390, 844),
		],
	};
}

function designScreen(id: "desktop" | "mobile", width: number, height: number) {
	const content = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#ffffff"/>`.padEnd(520, " ") + "</svg>";
	return {
		id,
		label: id === "desktop" ? "桌面端设计稿" : "移动端设计稿",
		viewport: { width, height },
		canvas: { width, height },
		mimeType: "image/svg+xml",
		content,
	};
}
