import type { WorkflowNodeStatus } from "./workflow-state";

export type WorkflowNodeKind =
  | "requirements"
  | "design"
  | "coding"
  | "testing"
  | "deployment"
  | "research"
  | "image"
  | "video"
  | "generic";

export type PlannedWorkflowNode = Readonly<{
  key: string;
  kind: WorkflowNodeKind;
  title: string;
  description: string;
  categoryId: string;
  tags: readonly string[];
  requiredCapability: string;
  inputContract: string;
  outputContract: string;
  budgetCapMinor: bigint;
  positionIndex: number;
  status: WorkflowNodeStatus;
}>;

export type PlannedWorkflowEdge = Readonly<{
  sourceKey: string;
  targetKey: string;
  artifactContract: string;
}>;

export type PlannedWorkflow = Readonly<{
  nodes: readonly PlannedWorkflowNode[];
  edges: readonly PlannedWorkflowEdge[];
}>;

export type WorkflowPlanningInput = Readonly<{
  taskCategoryId: string;
  taskTags: readonly string[];
  requiredCapability: string;
  totalBudgetMinor: bigint;
}>;

const CATEGORY_REQUIREMENTS = "40000000-0000-4000-8000-000000000021";
const CATEGORY_DESIGN = "40000000-0000-4000-8000-000000000022";
const CATEGORY_CODING = "40000000-0000-4000-8000-000000000023";
const CATEGORY_RESEARCH = "40000000-0000-4000-8000-000000000002";
const CATEGORY_DOCUMENT = "40000000-0000-4000-8000-000000000011";
const CATEGORY_IMAGE = "40000000-0000-4000-8000-000000000012";
const CATEGORY_VIDEO = "40000000-0000-4000-8000-000000000013";

type NodeTemplate = Readonly<{
  key: string;
  kind: WorkflowNodeKind;
  title: string;
  description: string;
  categoryId: string;
  tags: readonly string[];
  requiredCapability: string;
  inputContract: string;
  outputContract: string;
  budgetWeight: number;
}>;

/**
 * 当前规划器是确定性、可审计的正式基线，不把“AI 猜测”写成交易事实。未来 AI 只负责
 * 生成相同的 PlannedWorkflow 草案，仍必须经过本模块的金额、DAG 与分类校验后才能落库。
 */
export function planFormalWorkflow(input: WorkflowPlanningInput): PlannedWorkflow {
  if (input.totalBudgetMinor <= 0n) throw new Error("workflow total budget must be positive");
  const templates = templatesFor(input);
  const budgets = allocateBudget(input.totalBudgetMinor, templates.map((node) => node.budgetWeight));
  const nodes = templates.map((template, index): PlannedWorkflowNode => ({
    ...template,
    budgetCapMinor: budgets[index] ?? 0n,
    positionIndex: index,
    status: index === 0 ? "matching" : "blocked",
  }));
  const edges = nodes.slice(1).map((node, index): PlannedWorkflowEdge => ({
    sourceKey: nodes[index]?.key ?? "",
    targetKey: node.key,
    artifactContract: nodes[index]?.outputContract ?? "WorkflowArtifact",
  }));
  return { nodes, edges };
}

function templatesFor(input: WorkflowPlanningInput): readonly NodeTemplate[] {
  const tags = new Set(input.taskTags.map((tag) => tag.toLocaleLowerCase()));
  const software = input.taskCategoryId === CATEGORY_CODING
    || ["next.js", "typescript", "frontend", "backend", "coding", "smart-contract"].some((tag) => tags.has(tag));
  if (software) return softwareTemplates();
  if (input.taskCategoryId === CATEGORY_IMAGE || tags.has("image-generation")) {
    return [requirementsTemplate(), {
      key: "image",
      kind: "image",
      title: "图片设计与生成",
      description: "读取已验收需求，生成可直接预览和下载的图片制品。",
      categoryId: CATEGORY_IMAGE,
      tags: ["image-generation", "design-system"],
      requiredCapability: "根据结构化需求生成符合尺寸、风格和内容约束的图片制品",
      inputContract: "RequirementsArtifact",
      outputContract: "ImageArtifact",
      budgetWeight: 75,
    }];
  }
  if (input.taskCategoryId === CATEGORY_VIDEO || tags.has("video-generation")) {
    return [requirementsTemplate(), {
      key: "video",
      kind: "video",
      title: "视频策划与生成",
      description: "读取已验收需求，完成分镜、生成和可播放视频交付。",
      categoryId: CATEGORY_VIDEO,
      tags: ["video-generation", "content-creation"],
      requiredCapability: "根据结构化需求生成可播放并符合时长与画面约束的视频制品",
      inputContract: "RequirementsArtifact",
      outputContract: "VideoArtifact",
      budgetWeight: 75,
    }];
  }
  if (input.taskCategoryId === CATEGORY_RESEARCH || input.taskCategoryId === CATEGORY_DOCUMENT || tags.has("research")) {
    return [{
      key: "research",
      kind: "research",
      title: "研究与文档交付",
      description: "检索、分析并输出可阅读、可引用的研究文档。",
      categoryId: input.taskCategoryId,
      tags: [...input.taskTags],
      requiredCapability: input.requiredCapability,
      inputContract: "TaskContract",
      outputContract: "ResearchArtifact",
      budgetWeight: 100,
    }];
  }
  return [{
    key: "delivery",
    kind: "generic",
    title: "任务执行与交付",
    description: "由匹配当前分类和能力要求的 Agent 完成任务并提交可验收制品。",
    categoryId: input.taskCategoryId,
    tags: [...input.taskTags],
    requiredCapability: input.requiredCapability,
    inputContract: "TaskContract",
    outputContract: "TaskArtifact",
    budgetWeight: 100,
  }];
}

function softwareTemplates(): readonly NodeTemplate[] {
  return [
    { ...requirementsTemplate(), budgetWeight: 20 },
    {
      key: "design",
      kind: "design",
      title: "产品与界面设计",
      description: "把已验收 PRD 转换为页面结构、交互规则和可预览设计制品。",
      categoryId: CATEGORY_DESIGN,
      tags: ["ui/ux", "design-system", "responsive-design"],
      requiredCapability: "根据结构化 PRD 生成可验收的产品界面设计",
      inputContract: "RequirementsArtifact",
      outputContract: "DesignArtifact",
      budgetWeight: 30,
    },
    {
      key: "coding",
      kind: "coding",
      title: "Coding 开发实现",
      description: "读取已验收 PRD 和设计制品，生成可运行代码、预览与测试依据。",
      categoryId: CATEGORY_CODING,
      tags: ["next.js", "typescript", "testing"],
      requiredCapability: "根据需求与设计制品完成可运行的软件实现",
      inputContract: "RequirementsArtifact+DesignArtifact",
      outputContract: "CodeArtifact",
      budgetWeight: 50,
    },
  ];
}

function requirementsTemplate(): NodeTemplate {
  return {
    key: "requirements",
    kind: "requirements",
    title: "需求澄清与 PRD",
    description: "澄清目标、边界、用户故事和验收标准，输出后续节点可直接消费的任务清单。",
    categoryId: CATEGORY_REQUIREMENTS,
    tags: ["prd", "requirements-analysis", "task-decomposition"],
    requiredCapability: "将原始需求整理为结构化 PRD 与可执行任务",
    inputContract: "TaskContract",
    outputContract: "RequirementsArtifact",
    budgetWeight: 25,
  };
}

/**
 * 按整数权重拆分 USDC 最小单位。前 N-1 个向下取整，余数全部放到最后一个节点，
 * 保证节点预算之和严格等于总托管额，不产生浮点误差或凭空消失的最小单位。
 */
function allocateBudget(total: bigint, weights: readonly number[]): readonly bigint[] {
  if (weights.length === 0 || weights.some((weight) => !Number.isInteger(weight) || weight <= 0)) {
    throw new Error("workflow budget weights must be positive integers");
  }
  const weightTotal = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  let allocated = 0n;
  return weights.map((weight, index) => {
    const amount = index === weights.length - 1
      ? total - allocated
      : total * BigInt(weight) / weightTotal;
    allocated += amount;
    return amount;
  });
}
