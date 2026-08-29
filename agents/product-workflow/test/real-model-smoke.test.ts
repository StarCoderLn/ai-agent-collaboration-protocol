import { writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  extractPrototypeDesignIds,
  RequirementsArtifactSchema,
} from "../src/domain.js";
import { WorkflowExecutorRouter } from "../src/executors.js";
import { DeepSeekJsonClient } from "../src/model-client.js";

const runRealModel = process.env.RUN_REAL_MODEL_SMOKE === "1" ? it : it.skip;

describe("真实模型 Design→Coding 链路", () => {
  runRealModel("把同一份设计原型完整传给 Coding 并保留视觉契约", async () => {
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
      taskId: "real-model-design-code-smoke",
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
    const userRequest = "请设计并开发一款面向自由职业者的项目交付工作台，突出项目风险、下一步行动和 USDC 里程碑收款。";

    const design = await router.run({
      schemaVersion: "workflow.execute.v0.1",
      taskId: requirements.taskId,
      step: "design",
      agentId: "design-direct",
      userRequest,
      requirements,
    });
    expect(design.schemaVersion).toBe("design.artifact.v0.3");
    if (design.schemaVersion !== "design.artifact.v0.3") {
      throw new Error("真实设计 Agent 返回了错误制品类型");
    }
    const designIds = extractPrototypeDesignIds(design.prototype.pageTsx);
    expect(designIds.length).toBeGreaterThanOrEqual(4);

    const code = await router.run({
      schemaVersion: "workflow.execute.v0.1",
      taskId: requirements.taskId,
      step: "code",
      agentId: "code-direct",
      userRequest,
      requirements,
      design,
    });
    expect(code.schemaVersion).toBe("code.artifact.v0.1");
    if (code.schemaVersion !== "code.artifact.v0.1") {
      throw new Error("真实 Coding Agent 返回了错误制品类型");
    }
    const pageTsx = code.files.find((file) => file.path === "app/page.tsx")?.content;
    const globalsCss = code.files.find((file) => file.path === "app/globals.css")?.content;
    expect(globalsCss).toBe(design.prototype.globalsCss);
    for (const designId of designIds) {
      expect(pageTsx).toContain(`data-design-id="${designId}"`);
    }

    const outputPath = process.env.REAL_MODEL_SMOKE_OUTPUT;
    if (outputPath !== undefined && outputPath.length > 0) {
      // 只有显式指定临时路径时才保存虚构任务制品，便于使用平台预览器做人工视觉对比。
      // 文件不包含 API Key，也不会默认写入仓库或让普通测试产生副作用。
      await writeFile(outputPath, JSON.stringify({ design, code }, null, 2), "utf8");
    }
  }, 360_000);
});
