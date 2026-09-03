import { z } from "zod";

import type { ResultSubmissionInput } from "../tasks/execution-input";

const AUTOMATIC_ACCEPTANCE_RULE_VERSION = "workflow-intermediate-v4";

const nonEmptyText = z.string().trim().min(1);
const artifactEnvelope = z.object({
  taskId: nonEmptyText,
  generatedAt: z.string().datetime(),
  generatedBy: z.object({
    agentId: nonEmptyText,
    strategy: nonEmptyText,
  }),
});

const designPreviewItem = z.object({
  title: nonEmptyText,
  description: nonEmptyText.nullable(),
  value: nonEmptyText.nullable(),
  status: nonEmptyText.nullable(),
  progress: z.number().int().min(0).max(100).nullable(),
  action: nonEmptyText.nullable(),
  tone: z.enum(["neutral", "primary", "success", "warning", "danger"]),
}).superRefine((item, context) => {
  if (
    item.description === null && item.value === null && item.status === null
    && item.progress === null && item.action === null
  ) {
    context.addIssue({ code: "custom", message: "预览条目缺少可评审内容" });
  }
});

const richDesignPreview = z.object({
  hero: z.object({
    title: nonEmptyText,
    description: z.string().trim().min(10),
    primaryAction: nonEmptyText,
  }).passthrough(),
  metrics: z.array(z.object({ label: nonEmptyText, value: nonEmptyText }).passthrough()).max(4),
  sections: z.array(z.object({
    id: nonEmptyText,
    kind: z.enum(["cards", "list", "progress", "table", "chart", "form", "timeline"]),
    title: nonEmptyText,
    description: nonEmptyText.nullable(),
    items: z.array(designPreviewItem).min(1),
  }).passthrough()).min(3),
}).superRefine((preview, context) => {
  // 三个同名空框也不构成高保真设计：至少需要两种信息表达方式，并拒绝常见占位文案。
  if (new Set(preview.sections.map((section) => section.kind)).size < 2) {
    context.addIssue({ code: "custom", path: ["sections"], message: "设计预览缺少信息层级变化" });
  }
  if (preview.sections.reduce((total, section) => total + section.items.length, 0) < 6) {
    context.addIssue({ code: "custom", path: ["sections"], message: "设计预览缺少足够的真实内容" });
  }
  const texts = [
    preview.hero.title,
    preview.hero.description,
    ...preview.sections.flatMap((section) => [
      section.title,
      section.description ?? "",
      ...section.items.flatMap((item) => [
        item.title,
        item.description ?? "",
        item.value ?? "",
        item.status ?? "",
        item.action ?? "",
      ]),
    ]),
  ];
  if (texts.some((text) => /(?:待补充|占位|placeholder|\bxxx\b|\btodo\b)/i.test(text))) {
    context.addIssue({ code: "custom", path: ["sections"], message: "设计预览包含占位文案" });
  }
  if (preview.sections.some((section) => /(?:区域|区)$/.test(section.title))) {
    context.addIssue({ code: "custom", path: ["sections"], message: "设计区块标题过于抽象" });
  }
});

const renderedDesignScreen = z.object({
  id: z.enum(["desktop", "mobile"]),
  label: nonEmptyText,
  viewport: z.object({ width: z.number().int(), height: z.number().int() }),
  canvas: z.object({ width: z.number().int(), height: z.number().int() }),
  mimeType: z.literal("image/svg+xml"),
  content: z.string().trim().min(500).max(120_000).startsWith("<svg"),
}).superRefine((screen, context) => {
  // 自动验收仍把平台渲染结果当作持久化边界输入，而不是因为当前由自有代码生成就永久
  // 信任。历史数据或未来渲染器若引入脚本、外链或错误画布尺寸，必须停止自动推进。
  if (/<(?:script|foreignObject)\b|\bon[a-z]+\s*=|\b(?:href|xlink:href)\s*=|\burl\s*\(/i.test(screen.content)) {
    context.addIssue({ code: "custom", path: ["content"], message: "设计稿包含未授权内容" });
  }
  if (screen.canvas.width !== screen.viewport.width || screen.canvas.height < screen.viewport.height) {
    context.addIssue({ code: "custom", path: ["canvas"], message: "设计稿画布尺寸无效" });
  }
  const expected = screen.id === "desktop"
    ? { width: 1_440, height: 900 }
    : { width: 390, height: 844 };
  if (screen.viewport.width !== expected.width || screen.viewport.height !== expected.height) {
    context.addIssue({ code: "custom", path: ["viewport"], message: "设计稿断点与协议不一致" });
  }
});

const renderedDesignScreens = z.array(renderedDesignScreen).length(2).superRefine((screens, context) => {
  if (new Set(screens.map((screen) => screen.id)).size !== 2) {
    context.addIssue({ code: "custom", message: "设计稿必须同时包含桌面端和移动端" });
  }
});

/**
 * 自动验收规则只定义“允许资金与下游继续推进”的最低质量门槛，不复制 Agent 用来生成
 * 内容的完整 Schema。生成格式可以演进，但关键业务字段、任务归属和可执行性证据缺失时，
 * 平台必须停止自动推进并等待人工处理。
 */
const acceptanceSchemas = {
  RequirementsArtifact: artifactEnvelope.extend({
    schemaVersion: z.literal("requirements.artifact.v0.1"),
    problemStatement: z.string().trim().min(20),
    targetUsers: z.array(nonEmptyText).min(1),
    goals: z.array(nonEmptyText).min(1),
    userStories: z.array(z.object({
      id: nonEmptyText,
      statement: nonEmptyText,
      acceptanceCriteria: z.array(nonEmptyText).min(1),
    })).min(1),
    functionalRequirements: z.array(nonEmptyText).min(1),
    executableTasks: z.array(z.object({
      id: nonEmptyText,
      title: nonEmptyText,
      description: nonEmptyText,
      dependsOn: z.array(nonEmptyText),
      acceptanceCriteria: z.array(nonEmptyText).min(1),
    })).min(1),
  }),
  DesignArtifact: artifactEnvelope.extend({
    schemaVersion: z.literal("design.artifact.v0.4"),
    rendererVersion: z.literal("aicp-design-renderer.v1"),
    direction: z.string().trim().min(20),
    tokens: z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0),
    pages: z.array(z.object({ id: nonEmptyText, name: nonEmptyText, purpose: nonEmptyText })).min(1),
    components: z.array(z.object({ id: nonEmptyText, name: nonEmptyText, responsibility: nonEmptyText })).min(1),
    interactionRules: z.array(nonEmptyText).min(1),
    responsiveRules: z.array(nonEmptyText).min(1),
    accessibilityRules: z.array(nonEmptyText).min(1),
    preview: richDesignPreview,
    renderedScreens: renderedDesignScreens,
  }),
} as const;

type SupportedContract = keyof typeof acceptanceSchemas;

export type AutomaticAcceptanceDecision =
  | Readonly<{ kind: "manual"; reason: "final_node" }>
  | Readonly<{
      kind: "failed";
      ruleVersion: string;
      issues: readonly string[];
    }>
  | Readonly<{
      kind: "passed";
      ruleVersion: string;
      evidence: Readonly<{
        outputContract: SupportedContract;
        schemaVersion: string;
        artifactCount: number;
      }>;
    }>;

export function evaluateAutomaticAcceptance(input: Readonly<{
  taskId: string;
  outputContract: string;
  hasDownstream: boolean;
  results: ResultSubmissionInput["results"];
}>): AutomaticAcceptanceDecision {
  if (!input.hasDownstream) return { kind: "manual", reason: "final_node" };

  const schema = schemaFor(input.outputContract);
  if (schema === null) {
    return failure(`暂不支持自动验收 ${input.outputContract}，需要人工确认`);
  }
  if (input.results.length !== 1) {
    return failure("自动验收的中间制品必须且只能包含一个主制品");
  }
  const result = input.results[0];
  if (result === undefined || result.kind !== "inline" || result.mimeType.toLocaleLowerCase() !== "application/json") {
    return failure("自动验收的中间制品必须是 application/json 内联内容");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(result.content);
  } catch {
    return failure("中间制品不是合法 JSON");
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    return failure("中间制品缺少继续执行所需的结构化字段");
  }
  if (parsed.data.taskId !== input.taskId) {
    return failure("中间制品 taskId 与当前任务不一致");
  }

  return {
    kind: "passed",
    ruleVersion: AUTOMATIC_ACCEPTANCE_RULE_VERSION,
    evidence: {
      outputContract: input.outputContract as SupportedContract,
      schemaVersion: parsed.data.schemaVersion,
      artifactCount: input.results.length,
    },
  };
}

function schemaFor(contract: string): (typeof acceptanceSchemas)[SupportedContract] | null {
  return contract === "RequirementsArtifact" || contract === "DesignArtifact"
    ? acceptanceSchemas[contract]
    : null;
}

function failure(message: string): AutomaticAcceptanceDecision {
  return { kind: "failed", ruleVersion: AUTOMATIC_ACCEPTANCE_RULE_VERSION, issues: [message] };
}
