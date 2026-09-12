import { writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { renderDesignScreens } from "../src/design-renderer.js";
import {
  DesignArtifactSchema,
  RequirementsArtifactSchema,
} from "../src/domain.js";
import { WorkflowExecutorRouter } from "../src/executors.js";
import { DeepSeekJsonClient } from "../src/model-client.js";

const runRealModel = process.env.RUN_REAL_MODEL_SMOKE === "1" ? it : it.skip;

describe("真实模型 LangGraph Coding 链路", () => {
  runRealModel("根据固定 DesignSpec 生成并校验完整前端制品", async () => {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error("RUN_REAL_MODEL_SMOKE=1 时必须提供 DEEPSEEK_API_KEY");
    }
    const baseUrl = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
    const configuredModel = process.env.WORKFLOW_AGENT_MODEL ?? "deepseek-chat";
    const modelName = configuredModel.startsWith("deepseek/")
      ? configuredModel.slice("deepseek/".length)
      : configuredModel;
    const client = new DeepSeekJsonClient({
      baseUrl,
      apiKey,
      modelName,
      timeoutMs: 120_000,
    });
    const router = new WorkflowExecutorRouter({
      jsonClient: client,
      mastraModel: { id: `deepseek/${modelName}`, url: baseUrl, apiKey },
      modelStepTimeoutMs: 120_000,
    });
    const requirements = RequirementsArtifactSchema.parse({
      schemaVersion: "requirements.artifact.v0.1",
      taskId: "real-model-code-langgraph-smoke",
      title: "自由职业者项目交付工作台",
      problemStatement: "自由职业者需要在一个可信、清晰的工作台中查看项目里程碑、客户反馈、待办事项与 USDC 收款状态。",
      targetUsers: ["同时管理多个客户项目的自由职业者"],
      goals: ["一眼判断项目风险", "快速处理下一项工作", "清楚查看里程碑收款状态"],
      nonGoals: ["不实现真实支付", "不实现团队权限管理"],
      userStories: [{
        id: "US-1",
        statement: "作为自由职业者，我希望在一个页面查看当前项目、下一步行动和待收款里程碑。",
        acceptanceCriteria: ["首页展示至少三个真实项目", "可以筛选项目状态", "可以标记待办完成"],
      }],
      functionalRequirements: [
        "展示项目总览、风险状态和本周应收 USDC",
        "展示带客户、进度、截止日期和下一步行动的项目列表",
        "支持按全部、进行中、待反馈筛选项目",
        "支持勾选今日待办并即时更新完成状态",
      ],
      constraints: ["使用单页响应式界面", "所有交互可通过键盘操作"],
      assumptions: ["使用可信的示例数据表现设计完整度"],
      openQuestions: [],
      executableTasks: [{
        id: "T-1",
        title: "实现项目工作台",
        description: "实现项目概览、状态筛选、项目列表和今日待办交互。",
        dependsOn: [],
        acceptanceCriteria: ["桌面和窄屏均可使用", "筛选和待办操作可体验"],
      }],
      generatedBy: { agentId: "prd-direct", strategy: "direct" },
      generatedAt: new Date().toISOString(),
    });
    const designDraft = {
      title: "自由职业者项目交付工作台",
      direction: "使用柔和紫色突出项目风险、下一步行动和 USDC 里程碑，让复杂交付状态可以快速浏览。",
      tokens: {
        primaryColor: "#7C3AED",
        secondaryColor: "#64748B",
        backgroundColor: "#F8FAFC",
        textColor: "#172033",
        borderRadius: "12px" as const,
        spacingBase: "8px" as const,
        fontFamily: "system-ui",
      },
      pages: [{
        id: "home",
        name: "项目总览",
        purpose: "集中展示项目风险、待办和收款状态。",
        sections: ["概览指标", "项目列表", "今日待办", "里程碑收款"],
      }],
      components: [{
        id: "hero",
        name: "工作台概览",
        parentId: null,
        responsibility: "说明当前风险和最紧急的下一步行动。",
        states: ["正常", "有风险"],
      }],
      interactionRules: ["项目状态筛选立即更新列表", "勾选待办后即时显示完成状态"],
      responsiveRules: ["移动端使用单列布局"],
      accessibilityRules: ["按钮和筛选项具有可访问名称", "状态信息不只依赖颜色表达"],
      assetPlan: [],
      preview: {
        navigation: {
          brand: "Freelance Desk",
          items: [{ label: "项目", active: true }, { label: "收款", active: false }],
          action: "新建项目",
        },
        hero: {
          eyebrow: "交付工作台",
          title: "掌握风险，推进下一项工作",
          description: "在一个页面跟踪客户反馈、今日待办和 USDC 里程碑收款。",
          primaryAction: "查看风险项目",
          secondaryAction: "管理待办",
        },
        metrics: [
          { label: "进行中项目", value: "6", detail: "2 个需要关注", tone: "warning" as const },
          { label: "本周应收", value: "4,800 USDC", detail: "3 个里程碑", tone: "success" as const },
        ],
        sections: [
          previewSection("projects", "项目列表", "查看客户、进度、截止日期和下一步行动。"),
          previewSection("todos", "今日待办", "完成最影响交付进度的工作。"),
          previewSection("payments", "里程碑收款", "跟踪每笔 USDC 的验收和付款状态。"),
          previewSection("feedback", "客户反馈", "集中处理等待回复和需要修改的内容。"),
        ],
      },
    };
    const design = DesignArtifactSchema.parse({
      ...designDraft,
      schemaVersion: "design.artifact.v0.4",
      taskId: requirements.taskId,
      rendererVersion: "aicp-design-renderer.v1",
      renderedScreens: renderDesignScreens(designDraft),
      generatedBy: { agentId: "design-direct", strategy: "direct" },
      generatedAt: new Date().toISOString(),
    });
    const userRequest = "请开发一款面向自由职业者的项目交付工作台，突出项目风险、下一步行动和 USDC 里程碑收款。";

    const code = await router.run({
      schemaVersion: "workflow.execute.v0.1",
      taskId: requirements.taskId,
      step: "code",
      agentId: "code-langgraph",
      userRequest,
      requirements,
      design,
    }, {
      executionId: `real-model-code-langgraph-${Date.now()}`,
    });
    expect(code.schemaVersion).toBe("code.artifact.v0.1");
    if (code.schemaVersion !== "code.artifact.v0.1") {
      throw new Error("真实 LangGraph Coding Agent 返回了错误制品类型");
    }
    const pageTsx = code.files.find((file) => file.path === "app/page.tsx")?.content;
    const globalsCss = code.files.find((file) => file.path === "app/globals.css")?.content;
    expect(pageTsx).toContain(design.preview.hero.title);
    for (const color of [
      design.tokens.primaryColor,
      design.tokens.secondaryColor,
      design.tokens.backgroundColor,
      design.tokens.textColor,
    ]) {
      expect(globalsCss?.toLowerCase()).toContain(color.toLowerCase());
    }
    expect(globalsCss).toMatch(/@media\s*\(/i);

    const outputPath = process.env.REAL_MODEL_SMOKE_OUTPUT;
    if (outputPath !== undefined && outputPath.length > 0) {
      // 只有显式指定临时路径时才保存虚构任务制品，便于检查模型真实输出。
      await writeFile(outputPath, JSON.stringify({ design, code }, null, 2), "utf8");
    }
  }, 360_000);
});

function previewSection(id: string, title: string, description: string) {
  return {
    id,
    kind: "cards" as const,
    layout: "split" as const,
    title,
    description,
    items: [1, 2, 3].map((index) => ({
      title: `${title}${index}`,
      description: `${description} 示例 ${index}`,
      value: index === 1 ? "需关注" : null,
      status: index === 1 ? "风险" : "正常",
      progress: index * 25,
      action: "查看详情",
      tone: index === 1 ? "warning" as const : "neutral" as const,
    })),
  };
}
