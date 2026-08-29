import { z } from "zod";

export const WorkflowStepSchema = z.enum(["requirements", "design", "code"]);
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const AgentStrategySchema = z.enum(["direct", "mastra", "state-machine"]);
export type AgentStrategy = z.infer<typeof AgentStrategySchema>;

export const WorkflowAgentIdSchema = z.enum([
  "prd-direct",
  "prd-mastra",
  "prd-state-machine",
  "design-direct",
  "design-mastra",
  "design-state-machine",
  "code-direct",
  "code-mastra",
  "code-state-machine",
]);
export type WorkflowAgentId = z.infer<typeof WorkflowAgentIdSchema>;

export type WorkflowAgentManifest = {
  id: WorkflowAgentId;
  /** 平台 Agent 表使用的稳定 UUID；正式派发回调必须使用它，不能发送仅供 UI 使用的短 ID。 */
  platformId: string;
  categoryId: string;
  capability: string;
  tags: readonly string[];
  priceMinor: string;
  step: WorkflowStep;
  strategy: AgentStrategy;
  name: string;
  description: string;
};

/**
 * 9 个候选的单一权威目录。Web 只展示这里存在且服务端能解析的 Agent ID，避免 UI
 * 出现“看起来可选、实际上没有执行器”的假候选。
 */
export const WORKFLOW_AGENT_CATALOG: readonly WorkflowAgentManifest[] = [
  {
    id: "prd-direct",
    platformId: "91000000-0000-4000-8000-000000000001",
    categoryId: "40000000-0000-4000-8000-000000000021",
    capability: "产品需求澄清、PRD 编写与可执行任务拆分",
    tags: ["prd", "agent"],
    priceMinor: "12000000",
    step: "requirements",
    strategy: "direct",
    name: "快速需求整理 Agent",
    description: "DeepSeek 单次结构化生成，速度快、成本最低，作为直接调用基线。",
  },
  {
    id: "prd-mastra",
    platformId: "91000000-0000-4000-8000-000000000002",
    categoryId: "40000000-0000-4000-8000-000000000021",
    capability: "Mastra 产品需求分析、PRD 编写与任务拆分",
    tags: ["prd", "mastra", "agent"],
    priceMinor: "18000000",
    step: "requirements",
    strategy: "mastra",
    name: "Mastra 需求分析 Agent",
    description: "使用 Mastra 的结构化输出约束生成完整 PRD 与任务拆解。",
  },
  {
    id: "prd-state-machine",
    platformId: "91000000-0000-4000-8000-000000000003",
    categoryId: "40000000-0000-4000-8000-000000000021",
    capability: "深度需求分析、风险检查、PRD 与任务拆分",
    tags: ["prd", "agent"],
    priceMinor: "24000000",
    step: "requirements",
    strategy: "state-machine",
    name: "深度需求拆解 Agent",
    description: "显式执行分析、生成和校验状态，优先发现遗漏、冲突与未知问题。",
  },
  {
    id: "design-direct",
    platformId: "91000000-0000-4000-8000-000000000004",
    categoryId: "40000000-0000-4000-8000-000000000022",
    capability: "产品界面设计、设计系统与响应式规范",
    tags: ["ui/ux", "agent"],
    priceMinor: "16000000",
    step: "design",
    strategy: "direct",
    name: "快速界面设计 Agent",
    description: "直接生成设计决策与可运行高保真原型，作为速度和成本基线。",
  },
  {
    id: "design-mastra",
    platformId: "91000000-0000-4000-8000-000000000005",
    categoryId: "40000000-0000-4000-8000-000000000022",
    capability: "Mastra 产品设计、组件规范与交互设计",
    tags: ["ui/ux", "mastra", "agent"],
    priceMinor: "22000000",
    step: "design",
    strategy: "mastra",
    name: "Mastra 产品设计 Agent",
    description: "由 Mastra 规划设计并生成可运行原型，强调需求到页面的可追溯性。",
  },
  {
    id: "design-state-machine",
    platformId: "91000000-0000-4000-8000-000000000006",
    categoryId: "40000000-0000-4000-8000-000000000022",
    capability: "设计评审、无障碍、响应式与完整状态设计",
    tags: ["ui/ux", "agent"],
    priceMinor: "28000000",
    step: "design",
    strategy: "state-machine",
    name: "设计评审与完善 Agent",
    description: "先分析评审设计，再生成包含状态与响应式规则的可运行原型。",
  },
  {
    id: "code-direct",
    platformId: "91000000-0000-4000-8000-000000000007",
    categoryId: "40000000-0000-4000-8000-000000000023",
    capability: "TypeScript 与 Next.js 代码生成和测试计划",
    tags: ["typescript", "next.js", "agent"],
    priceMinor: "24000000",
    step: "code",
    strategy: "direct",
    name: "快速代码生成 Agent",
    description: "DeepSeek 直接继承设计原型并补充交互，作为速度和成本基线。",
  },
  {
    id: "code-mastra",
    platformId: "91000000-0000-4000-8000-000000000008",
    categoryId: "40000000-0000-4000-8000-000000000023",
    capability: "Mastra 编程、文件生成、运行说明与测试计划",
    tags: ["typescript", "next.js", "mastra", "agent"],
    priceMinor: "32000000",
    step: "code",
    strategy: "mastra",
    name: "Mastra 编程 Agent",
    description: "使用 Mastra 规划并在既有设计原型上增量完成代码实现。",
  },
  {
    id: "code-state-machine",
    platformId: "91000000-0000-4000-8000-000000000009",
    categoryId: "40000000-0000-4000-8000-000000000023",
    capability: "规划、编码、静态检查、测试与一次修复",
    tags: ["typescript", "next.js", "agent"],
    priceMinor: "42000000",
    step: "code",
    strategy: "state-machine",
    name: "规划测试修复 Coding Agent",
    description: "显式规划、增量编码并校验设计继承，最多执行一次修复。",
  },
];

const manifestById = new Map(WORKFLOW_AGENT_CATALOG.map((agent) => [agent.id, agent]));

export function findWorkflowAgent(id: WorkflowAgentId): WorkflowAgentManifest {
  const agent = manifestById.get(id);
  if (agent === undefined) {
    // id 已经通过枚举校验；该分支保护目录与枚举未来修改时不会静默漂移。
    throw new Error(`workflow agent catalog is missing ${id}`);
  }
  return agent;
}
