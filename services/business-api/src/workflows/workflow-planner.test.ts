import { describe, expect, it } from "vitest";

import { allocateWorkflowBudgetPreference, planFormalWorkflow } from "./workflow-planner";

describe("formal workflow planner", () => {
  it("把软件开发任务拆成 PRD、设计和 Coding 三个正式节点", () => {
    const plan = planFormalWorkflow({
      taskCategoryId: "40000000-0000-4000-8000-000000000023",
      taskTags: ["next.js"],
      requiredCapability: "开发管理后台",
    });
    expect(plan.nodes.map((node) => node.key)).toEqual(["requirements", "design", "coding"]);
    expect(plan.nodes.map((node) => node.status)).toEqual(["selecting", "selecting", "selecting"]);
    expect(plan.nodes.map((node) => node.budgetWeight)).toEqual([20, 30, 50]);
    expect(plan.edges).toEqual([
      { sourceKey: "requirements", targetKey: "design", artifactContract: "RequirementsArtifact" },
      { sourceKey: "design", targetKey: "coding", artifactContract: "DesignArtifact" },
    ]);
  });

  it("图片任务只创建需求和图片两个节点，不受固定三节点限制", () => {
    const plan = planFormalWorkflow({
      taskCategoryId: "40000000-0000-4000-8000-000000000012",
      taskTags: ["image-generation"],
      requiredCapability: "生成活动海报",
    });
    expect(plan.nodes.map((node) => node.kind)).toEqual(["requirements", "image"]);
    expect(plan.nodes.map((node) => node.budgetWeight)).toEqual([25, 75]);
  });

  it("通用任务可以保持单节点，Agent 数量由真实工作分解决定", () => {
    const plan = planFormalWorkflow({
      taskCategoryId: "40000000-0000-4000-8000-000000000004",
      taskTags: ["data-analysis"],
      requiredCapability: "清洗数据",
    });
    expect(plan.nodes).toHaveLength(1);
    expect(plan.nodes[0]?.budgetWeight).toBe(100);
  });

  it("只在用户设置偏好后按权重拆分，并保持最小单位总和不变", () => {
    expect(allocateWorkflowBudgetPreference(60_000_001n, [20, 30, 50]))
      .toEqual([12_000_000n, 18_000_000n, 30_000_001n]);
  });
});
