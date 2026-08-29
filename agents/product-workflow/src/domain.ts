import { z } from "zod";
import { findWorkflowAgent, WorkflowAgentIdSchema } from "./catalog.js";

const NonEmptyText = z.string().trim().min(1);
const ShortText = NonEmptyText.max(500);

const GeneratedBySchema = z
  .object({
    agentId: WorkflowAgentIdSchema,
    strategy: z.enum(["direct", "mastra", "state-machine"]),
  })
  .strict();

const UserStorySchema = z
  .object({
    id: z.string().min(1).max(40),
    statement: ShortText,
    acceptanceCriteria: z.array(ShortText).min(1).max(8),
  })
  .strict();

const ExecutableTaskSchema = z
  .object({
    id: z.string().min(1).max(40),
    title: ShortText,
    description: z.string().min(1).max(2_000),
    dependsOn: z.array(z.string().min(1).max(40)).max(10),
    acceptanceCriteria: z.array(ShortText).min(1).max(8),
  })
  .strict();

export const RequirementsDraftSchema = z
  .object({
    title: ShortText,
    problemStatement: z.string().min(20).max(3_000),
    targetUsers: z.array(ShortText).min(1).max(8),
    goals: z.array(ShortText).min(1).max(12),
    nonGoals: z.array(ShortText).min(1).max(12),
    userStories: z.array(UserStorySchema).min(1).max(12),
    functionalRequirements: z.array(ShortText).min(1).max(20),
    constraints: z.array(ShortText).max(12),
    assumptions: z.array(ShortText).max(12),
    openQuestions: z.array(ShortText).max(12),
    executableTasks: z.array(ExecutableTaskSchema).min(1).max(20),
  })
  .strict();

export const RequirementsArtifactSchema = RequirementsDraftSchema.extend({
  schemaVersion: z.literal("requirements.artifact.v0.1"),
  taskId: z.string().min(1).max(128),
  generatedBy: GeneratedBySchema,
  generatedAt: z.string().datetime(),
}).strict();
export type RequirementsArtifact = z.infer<typeof RequirementsArtifactSchema>;

const DesignTokenSchema = z
  .object({
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    borderRadius: z.enum(["0", "4px", "8px", "12px", "16px", "999px"]),
    spacingBase: z.enum(["4px", "6px", "8px"]),
    fontFamily: ShortText,
  })
  .strict();

const DesignPageSchema = z
  .object({
    id: z.string().min(1).max(60),
    name: ShortText,
    purpose: z.string().min(10).max(1_000),
    sections: z.array(ShortText).min(1).max(12),
  })
  .strict();

const DesignComponentSchema = z
  .object({
    id: z.string().min(1).max(60),
    name: ShortText,
	// 模型经常省略根组件的 parentId；在不损失语义的验证边界统一规范化为 null，
	// 下游仍始终收到显式字段，子组件则必须给出已有组件 id。
	parentId: z.string().min(1).max(60).nullable().default(null),
    responsibility: z.string().min(5).max(1_000),
    states: z.array(ShortText).max(10),
  })
  .strict();

const DesignPreviewToneSchema = z.enum(["neutral", "primary", "success", "warning", "danger"]);
const DesignPreviewActionLabelSchema = z.union([
  z.string().trim().min(1).max(60),
  // 部分结构化模型会把视觉按钮自然表达为 {label}。边界在验证后吸收这项供应商差异，
  // 内部契约仍始终是简单字符串，避免每个渲染器和 Coding Agent 重复兼容。
  z.object({ label: z.string().trim().min(1).max(60) }).strict().transform((action) => action.label),
]);

const DesignPreviewItemSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(240).nullable().default(null),
    value: z.string().trim().min(1).max(80).nullable().default(null),
    status: z.string().trim().min(1).max(60).nullable().default(null),
    progress: z.number().int().min(0).max(100).nullable().default(null),
    action: DesignPreviewActionLabelSchema.nullable().default(null),
    tone: DesignPreviewToneSchema.default("neutral"),
  })
  .strict()
  .superRefine((item, context) => {
    // 只有标题的条目仍然只是线框占位。每个条目至少提供一种可供用户判断的真实内容，
    // 这样平台渲染器才能表现数值、状态、说明、进度或下一步操作，而不是再次画空白卡片。
    if (
      item.description === null && item.value === null && item.status === null
      && item.progress === null && item.action === null
    ) {
      context.addIssue({ code: "custom", message: "preview item requires meaningful content" });
    }
  });

const DesignPreviewSectionSchema = z
  .object({
    id: z.string().trim().min(1).max(60),
    kind: z.enum(["cards", "list", "progress", "table", "chart", "form", "timeline"]),
    layout: z.enum(["full", "split", "grid-2", "grid-3", "grid-4"]),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(300).nullable().default(null),
    items: z.array(DesignPreviewItemSchema).min(1).max(8),
  })
  .strict();

/**
 * Design Agent 决定页面的信息层级、真实示例内容和区块布局；平台只负责安全渲染。
 * 该边界既保留三种 Agent 的设计差异，也避免执行模型提供的任意 HTML、SVG 或脚本。
 */
export const DesignPreviewSchema = z
  .object({
    navigation: z
      .object({
        brand: z.string().trim().min(1).max(60),
        items: z.array(z.object({
          label: z.string().trim().min(1).max(40),
          active: z.boolean(),
        }).strict()).min(2).max(6),
        action: DesignPreviewActionLabelSchema.nullable().default(null),
      })
      .strict()
      .nullable(),
    hero: z.object({
      eyebrow: z.string().trim().min(1).max(60),
      title: z.string().trim().min(1).max(120),
      description: z.string().trim().min(10).max(320),
      primaryAction: z.string().trim().min(1).max(60),
      secondaryAction: z.string().trim().min(1).max(60).nullable().default(null),
    }).strict(),
    metrics: z.array(z.object({
      label: z.string().trim().min(1).max(60),
      value: z.string().trim().min(1).max(60),
      detail: z.string().trim().min(1).max(100),
      tone: DesignPreviewToneSchema,
    }).strict()).max(4),
    sections: z.array(DesignPreviewSectionSchema).min(3).max(6),
  })
  .strict()
  .superRefine((preview, context) => {
    const ids = preview.sections.map((section) => section.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", path: ["sections"], message: "preview section ids must be unique" });
    }
    const itemCount = preview.sections.reduce((total, section) => total + section.items.length, 0);
    if (itemCount < 6) {
      context.addIssue({ code: "custom", path: ["sections"], message: "preview requires at least six meaningful items" });
    }
    const visibleText = [
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
    const placeholder = visibleText.find((text) => /(?:待补充|占位|placeholder|\bxxx\b|\btodo\b)/i.test(text));
    if (placeholder !== undefined) {
      context.addIssue({ code: "custom", path: ["sections"], message: "preview must not contain placeholder copy" });
    }
    const abstractSection = preview.sections.find((section) => /(?:区域|区)$/.test(section.title));
    if (abstractSection !== undefined) {
      context.addIssue({ code: "custom", path: ["sections"], message: "preview section title must describe user content" });
    }
  });

export const DesignDraftSchema = z
  .object({
    title: ShortText,
    direction: z.string().min(20).max(2_000),
    tokens: DesignTokenSchema,
    pages: z.array(DesignPageSchema).min(1).max(8),
    components: z.array(DesignComponentSchema).min(1).max(30),
    interactionRules: z.array(ShortText).min(1).max(20),
    responsiveRules: z.array(ShortText).min(1).max(15),
    accessibilityRules: z.array(ShortText).min(1).max(15),
    assetPlan: z.array(ShortText).max(15),
    preview: DesignPreviewSchema,
  })
  .strict();
export type DesignDraft = z.infer<typeof DesignDraftSchema>;

/**
 * 设计原型是 Design→Coding 的视觉单一真相源。页面与样式都在不可信模型边界完成静态
 * 校验；下游只能继承或增量实现，不能再由平台用另一套模板重新解释设计。
 */
export const PrototypeFilesSchema = z
  .object({
    pageTsx: z.string().trim().min(300).max(30_000),
    globalsCss: z.string().trim().min(300).max(30_000),
  })
  .strict()
  .superRefine((prototype, context) => {
    if (extractPrototypeDesignIds(prototype.pageTsx).length < 4) {
      context.addIssue({ code: "custom", path: ["pageTsx"], message: "DESIGN_ID_COVERAGE_MISSING" });
    }
    if (/(?:@import|url\s*\(|expression\s*\(|javascript:|behavior\s*:|-moz-binding)/i.test(prototype.globalsCss)) {
      context.addIssue({ code: "custom", path: ["globalsCss"], message: "UNSAFE_CSS_REFERENCE" });
    }
    if (/<style\b|style\s*=\s*\{\{|dangerouslySetInnerHTML|process\.env|\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/.test(prototype.pageTsx)) {
      context.addIssue({ code: "custom", path: ["pageTsx"], message: "UNSAFE_PROTOTYPE_SOURCE" });
    }
  });
export type PrototypeFiles = z.infer<typeof PrototypeFilesSchema>;

export const CompleteDesignDraftSchema = DesignDraftSchema.extend({
  prototype: PrototypeFilesSchema,
}).strict();

/**
 * 设计协议只保留可运行原型版本。项目尚未承载需要迁移的生产历史制品，继续读取旧版会迫使
 * Web、自动验收和 Coding Agent 长期维护分叉语义；旧本地任务应重新执行设计阶段。
 */
export const DesignArtifactSchema = CompleteDesignDraftSchema.extend({
  schemaVersion: z.literal("design.artifact.v0.3"),
  taskId: z.string().min(1).max(128),
  generatedBy: GeneratedBySchema,
  generatedAt: z.string().datetime(),
}).strict();
export type DesignArtifact = z.infer<typeof DesignArtifactSchema>;

/** Coding 与验收共用同一锚点提取规则，避免两端对“设计是否被继承”产生不同判断。 */
export function extractPrototypeDesignIds(pageTsx: string): string[] {
  const ids = [...pageTsx.matchAll(/data-design-id=["']([a-z0-9-]+)["']/gi)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
  return [...new Set(ids)];
}

const CodeFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(200)
      .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), {
        message: "code file path must be relative and must not traverse directories",
      }),
    language: z.string().min(1).max(40),
	content: z.string().min(1).max(30_000),
  })
  .strict();

/**
 * 模型只负责最有差异价值的页面实现；稳定脚手架由平台补齐。这样三种 Coding Agent
 * 仍可公平比较 UI/交互代码，同时避免每次重复生成依赖、layout 和 README 导致截断。
 */
export const CompactCodeDraftSchema = z
	.object({
		// 让模型只返回真正需要创作的页面代码。标题、说明、运行方式和测试边界由平台
		// 根据已验证的上游制品统一补齐，避免重复字段挤占输出预算并导致 JSON 截断。
		pageTsx: z.string().min(100).max(30_000),
	})
	.strict();

export const CodeDraftSchema = z
  .object({
    title: ShortText,
    implementationSummary: z.string().min(20).max(3_000),
	fileTree: z.array(z.string().min(1).max(200)).min(1).max(6),
	files: z.array(CodeFileSchema).min(1).max(6),
    runInstructions: z.array(ShortText).min(1).max(12),
    testPlan: z.array(ShortText).min(1).max(15),
    limitations: z.array(ShortText).max(12),
  })
	.strict()
	.superRefine((draft, context) => {
		const tree = new Set(draft.fileTree);
		const paths = new Set(draft.files.map((file) => file.path));
		if (tree.size !== draft.fileTree.length || paths.size !== draft.files.length) {
			context.addIssue({ code: "custom", path: ["fileTree"], message: "file paths must be unique" });
		}
		if (tree.size !== paths.size || [...tree].some((path) => !paths.has(path))) {
			context.addIssue({ code: "custom", path: ["fileTree"], message: "fileTree must exactly match files[].path" });
		}
		const totalCharacters = draft.files.reduce((total, file) => total + file.content.length, 0);
		if (totalCharacters > 40_000) {
			context.addIssue({ code: "custom", path: ["files"], message: "combined file content exceeds 40000 characters" });
		}
	});

export const CodeArtifactSchema = CodeDraftSchema.extend({
  schemaVersion: z.literal("code.artifact.v0.1"),
  taskId: z.string().min(1).max(128),
  generatedBy: GeneratedBySchema,
  generatedAt: z.string().datetime(),
}).strict();
export type CodeArtifact = z.infer<typeof CodeArtifactSchema>;

const ExecutionBaseSchema = z.object({
  schemaVersion: z.literal("workflow.execute.v0.1"),
  taskId: z.string().min(1).max(128),
  agentId: WorkflowAgentIdSchema,
  userRequest: z.string().trim().min(20).max(8_000),
});

export const WorkflowExecutionInputSchema = z
  .discriminatedUnion("step", [
    ExecutionBaseSchema.extend({
      step: z.literal("requirements"),
    }).strict(),
    ExecutionBaseSchema.extend({
      step: z.literal("design"),
      requirements: RequirementsArtifactSchema,
    }).strict(),
    ExecutionBaseSchema.extend({
      step: z.literal("code"),
      requirements: RequirementsArtifactSchema,
      design: DesignArtifactSchema,
    }).strict(),
  ])
  .superRefine((input, context) => {
    const agent = findWorkflowAgent(input.agentId);
    if (agent.step !== input.step) {
      context.addIssue({
        code: "custom",
        path: ["agentId"],
        message: `agent ${input.agentId} cannot execute ${input.step}`,
      });
    }
  });
export type WorkflowExecutionInput = z.infer<typeof WorkflowExecutionInputSchema>;

export const WorkflowArtifactSchema = z.discriminatedUnion("schemaVersion", [
  RequirementsArtifactSchema,
  DesignArtifactSchema,
  CodeArtifactSchema,
]);
export type WorkflowArtifact = z.infer<typeof WorkflowArtifactSchema>;

/** 模型不能决定 taskId、Agent 身份或生成时间；这些字段只由可信执行器补齐。 */
export function finalizeArtifact(
  input: WorkflowExecutionInput,
  draft: unknown,
  generatedAt: Date,
): WorkflowArtifact {
  const agent = findWorkflowAgent(input.agentId);
  const metadata = {
    taskId: input.taskId,
    generatedBy: { agentId: agent.id, strategy: agent.strategy },
    generatedAt: generatedAt.toISOString(),
  };
  if (input.step === "requirements") {
    return RequirementsArtifactSchema.parse({
      ...RequirementsDraftSchema.parse(draft),
      schemaVersion: "requirements.artifact.v0.1",
      ...metadata,
    });
  }
  if (input.step === "design") {
    const design = CompleteDesignDraftSchema.parse(draft);
    return DesignArtifactSchema.parse({
      ...design,
      schemaVersion: "design.artifact.v0.3",
      ...metadata,
    });
  }
	const compactCode = CompactCodeDraftSchema.parse(draft);
	const agentName = findWorkflowAgent(input.agentId).name;
  return CodeArtifactSchema.parse({
		title: `${input.design.title} · 可运行前端原型`,
		implementationSummary: `${agentName} 根据已验收的 PRD 与设计制品生成核心交互页面；平台负责装配固定 Next.js 脚手架。`,
		fileTree: CODE_SCAFFOLD.map((file) => file.path),
		files: CODE_SCAFFOLD.map((file) => ({
			...file,
			content: file.path === "app/page.tsx"
				? compactCode.pageTsx
				: file.path === "app/globals.css"
					? input.design.prototype.globalsCss
					: file.content,
		})),
		runInstructions: ["pnpm install", "pnpm dev", "在浏览器打开 http://localhost:3000"],
		testPlan: [
			"运行 pnpm install 与 pnpm build，确认 TypeScript 和 Next.js 构建通过",
			"在桌面与 390px 窄屏检查主页面布局、文字溢出和键盘焦点",
			"手动走通页面提供的主要交互，并确认状态变化与已验收需求一致",
		],
		limitations: ["模型生成代码未在平台服务器执行，合入正式项目之前仍需人工审查并运行测试"],
    schemaVersion: "code.artifact.v0.1",
    ...metadata,
  });
}

const CODE_SCAFFOLD = [
	{
		path: "package.json",
		language: "json",
		content: JSON.stringify({
			name: "aicp-generated-prototype",
			private: true,
			scripts: { dev: "next dev", build: "next build", start: "next start" },
			dependencies: { next: "16.3.1", react: "19.2.0", "react-dom": "19.2.0", "lucide-react": "^0.468.0" },
			devDependencies: { "@types/node": "^22", "@types/react": "^19", typescript: "^5" },
		}, null, 2),
	},
	{
		path: "app/layout.tsx",
		language: "tsx",
		content: `import "./globals.css";\nexport default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {\n  return <html lang="zh-CN"><body>{children}</body></html>;\n}`,
	},
	{ path: "app/page.tsx", language: "tsx", content: "" },
	{
		path: "app/globals.css",
		language: "css",
		content: `:root{color-scheme:light;--ink:#0f172a;--muted:#64748b;--line:#dbe3ee;--surface:#fff;--soft:#f4f7fb;--primary:#6255e7;--primary-dark:#4f46c8;--success:#16865b;--warning:#b45309;--danger:#c2415d}*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:var(--ink);background:#f8fafc}button,input,select,textarea{font:inherit}button,a,select{cursor:pointer}h1,h2,h3,p{margin-top:0}.shell{min-height:100vh;padding:48px 24px;background:radial-gradient(circle at 84% 0,rgba(139,92,246,.18) 0,transparent 32%),radial-gradient(circle at 8% 42%,rgba(37,99,235,.1) 0,transparent 28%),#f8fafc}.panel{width:min(1180px,100%);margin:auto;padding:32px;border:1px solid rgba(148,163,184,.35);border-radius:22px;background:rgba(255,255,255,.95);box-shadow:0 28px 80px rgba(39,35,86,.12)}.page-header{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:28px}.page-header h1{margin:6px 0 8px;font-size:clamp(28px,4vw,44px);letter-spacing:-.035em}.header-actions,.toolbar,.action-row{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.eyebrow{margin:0;color:var(--primary);font-size:13px;font-weight:750;text-transform:uppercase;letter-spacing:.08em}.muted{margin:0;color:var(--muted);line-height:1.65}.toolbar{justify-content:space-between;margin-bottom:18px}.content{min-height:260px}.summary{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(240px,.7fr);gap:18px;margin-bottom:18px}.grid{display:grid;gap:16px}.grid-2{grid-template-columns:repeat(2,minmax(0,1fr))}.grid-3{grid-template-columns:repeat(3,minmax(0,1fr))}.card,.status-card,.metric-card,.empty-state{padding:20px;border:1px solid var(--line);border-radius:16px;background:var(--surface)}.card h2,.card h3,.status-card h2,.status-card h3{margin-bottom:8px}.status-card{border-left:4px solid var(--primary);background:linear-gradient(135deg,#fff,#f7f5ff)}.metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:18px}.metric-card{min-height:126px;background:linear-gradient(145deg,#fff,#f7f8fc)}.label{display:block;margin-bottom:8px;color:var(--muted);font-size:13px;font-weight:700}.value{display:block;font-size:clamp(24px,3vw,34px);font-weight:800;letter-spacing:-.025em}.badge{display:inline-flex;align-items:center;width:max-content;padding:5px 10px;border-radius:999px;background:#eef0f5;color:#475569;font-size:12px;font-weight:750}.badge-success{background:#e8f7ef;color:#08734a}.badge-warning{background:#fff4db;color:#98520a}.badge-danger{background:#fff0f3;color:#a82f4b}.meta{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}.meta span{padding:7px 10px;border-radius:9px;background:var(--soft);color:var(--muted);font-size:13px}.list{display:grid;gap:10px;margin:0;padding:0;list-style:none}.list-item{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid var(--line)}.list-item:last-child{border-bottom:0}.field{display:grid;gap:7px}.control{width:100%;min-height:44px;padding:10px 12px;border:1px solid var(--line);border-radius:11px;background:#fff;color:var(--ink)}.control:focus{border-color:#9b8cff;outline:3px solid rgba(139,92,246,.14)}.table-wrap{max-width:100%;overflow:auto;border:1px solid var(--line);border-radius:15px}.data-table{width:100%;border-collapse:collapse;background:#fff}.data-table th,.data-table td{padding:14px 16px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}.data-table th{background:var(--soft);color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}.empty-state{display:grid;min-height:220px;place-items:center;text-align:center;color:var(--muted);background:var(--soft)}.action-row{justify-content:flex-end;margin-top:22px}.primary-action,.secondary-action,.danger-action{min-height:44px;padding:0 20px;border-radius:11px;font-weight:750;transition:transform .16s,box-shadow .16s,background .16s}.primary-action{border:0;background:linear-gradient(135deg,var(--primary),#7c3aed);color:#fff;box-shadow:0 10px 24px rgba(98,85,231,.24)}.secondary-action{border:1px solid var(--line);background:#fff;color:var(--ink)}.danger-action{border:1px solid #fecdd6;background:#fff5f7;color:var(--danger)}.primary-action:hover,.secondary-action:hover,.danger-action:hover{transform:translateY(-1px)}.primary-action:hover{background:linear-gradient(135deg,var(--primary-dark),#6d28d9)}.primary-action:focus-visible,.secondary-action:focus-visible,.danger-action:focus-visible{outline:3px solid #c4b5fd;outline-offset:3px}.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:22px}.step{padding:18px;border:1px solid var(--line);border-radius:14px;background:var(--soft)}.step.active{border-color:#a99df8;background:#f5f3ff}.step.done{border-color:#9bd7bd;background:#effaf5}.artifact{min-height:250px;padding:26px;border:1px solid var(--line);border-radius:16px;background:var(--surface)}@media(max-width:760px){.shell{padding:20px 12px}.panel{padding:20px}.page-header,.action-row{align-items:stretch;flex-direction:column}.header-actions,.toolbar{align-items:stretch}.summary,.grid-2,.grid-3,.steps{grid-template-columns:1fr}.primary-action,.secondary-action,.danger-action{width:100%}.artifact{padding:20px}}`,
	},
	{
		path: "README.md",
		language: "markdown",
		content: "# AICP Agent 生成原型\n\n`app/page.tsx` 由所选 Coding Agent 生成；其余文件由平台固定脚手架补齐。模型代码属于不可信输入，请人工审查后再用于正式项目。",
	},
] as const;
