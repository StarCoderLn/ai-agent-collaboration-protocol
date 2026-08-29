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
      ruleVersion: "workflow-intermediate-v3",
      evidence: {
        outputContract: "RequirementsArtifact",
        schemaVersion: "requirements.artifact.v0.1",
        artifactCount: 1,
      },
    });
  });

  it("不包含可运行原型的旧设计不能继续自动推进 Coding", () => {
    expect(evaluateAutomaticAcceptance({
      taskId: "task-1",
      outputContract: "DesignArtifact",
      hasDownstream: true,
      results: [jsonResult({
        ...validDesign("task-1"),
        schemaVersion: "design.artifact.v0.2",
        prototype: undefined,
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
      ruleVersion: "workflow-intermediate-v3",
      evidence: {
        outputContract: "DesignArtifact",
        schemaVersion: "design.artifact.v0.3",
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

  it("缺少设计锚点或引用远程资源的原型不能推进 Coding", () => {
    const missingAnchors = validDesign("task-1");
    missingAnchors.prototype.pageTsx = "export default function Page(){return <main data-design-id=\"only-one\">任务</main>}\n// 原型长度足够但缺少跨 Agent 继承所需的稳定设计锚点。\n// 平台不能仅凭可编译就把它误判为可自动推进的完整设计。\n// 其余说明只用于证明长度不是本测试的失败原因。";
    expect(evaluateAutomaticAcceptance({
      taskId: "task-1", outputContract: "DesignArtifact", hasDownstream: true,
      results: [jsonResult(missingAnchors)],
    })).toMatchObject({ kind: "failed" });

    const remoteCss = validDesign("task-1");
    remoteCss.prototype.globalsCss = `${remoteCss.prototype.globalsCss}\n@import url('https://example.com/theme.css');`;
    expect(evaluateAutomaticAcceptance({
      taskId: "task-1", outputContract: "DesignArtifact", hasDownstream: true,
      results: [jsonResult(remoteCss)],
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
    schemaVersion: "design.artifact.v0.3",
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
        description: "集中查看任务、Agent 和里程碑结算的当前状态。",
        primaryAction: "发布新任务",
      },
      metrics: [{ label: "执行中", value: "3" }],
      sections: [
        { id: "tasks", kind: "cards", title: "当前任务", description: "最近执行状态", items: [item("后台管理系统", "执行中", "primary"), item("品牌设计", "已完成", "success")] },
        { id: "agents", kind: "progress", title: "Agent 进度", description: "自动更新", items: [item("需求 Agent", "已完成", "success"), item("设计 Agent", "进行中", "primary")] },
        { id: "settlement", kind: "table", title: "里程碑结算", description: "按验收释放", items: [item("需求确认", "已结算", "success"), item("界面设计", "待验收", "warning")] },
      ],
    },
    prototype: {
      pageTsx: "// 自动验收测试使用完整的设计页面，确保下游拿到真实页面而不是抽象描述。\n// 四个稳定锚点用于验证 Coding Agent 保留了页面的关键视觉结构。\nexport default function Page(){return <main data-design-id=\"page-shell\"><header data-design-id=\"task-header\"><h1>任务协作工作台</h1></header><section data-design-id=\"agent-progress\">Agent 进度</section><section data-design-id=\"settlement-panel\"><button>查看详情</button></section></main>}",
      globalsCss: "/* 设计阶段输出完整自包含样式，下游代码制品必须逐字继承这份视觉真相源。 */\n/* 不允许远程字体、图片或主题文件，确保隔离预览不会产生外部网络请求。 */\n*{box-sizing:border-box}body{margin:0;background:#0b1020;color:#f8fafc;font-family:system-ui}main{min-height:100vh;padding:48px}header,section{max-width:1080px;margin:0 auto 20px;padding:24px;border:1px solid #34406d;border-radius:16px}button{cursor:pointer}",
    },
  };
}
