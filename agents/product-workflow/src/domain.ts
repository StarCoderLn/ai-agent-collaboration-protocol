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
  })
  .strict();

export const DesignArtifactSchema = DesignDraftSchema.extend({
  schemaVersion: z.literal("design.artifact.v0.1"),
  taskId: z.string().min(1).max(128),
  generatedBy: GeneratedBySchema,
  generatedAt: z.string().datetime(),
  svgPreview: z.string().min(1).max(100_000),
}).strict();
export type DesignArtifact = z.infer<typeof DesignArtifactSchema>;

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
    const design = DesignDraftSchema.parse(draft);
    return DesignArtifactSchema.parse({
      ...design,
      schemaVersion: "design.artifact.v0.1",
      ...metadata,
      svgPreview: renderSafeDesignPreview(design),
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
			content: file.path === "app/page.tsx" ? compactCode.pageTsx : file.content,
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
		content: `:root{color-scheme:light;--ink:#0f172a;--muted:#64748b;--line:#dbe3ee;--surface:#fff;--soft:#f4f7fb;--primary:#2563eb;--success:#16865b}*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:var(--ink);background:#f8fafc}button,input,textarea{font:inherit}.shell{min-height:100vh;padding:48px 24px;background:radial-gradient(circle at 85% 0,#dbeafe 0,transparent 32%),#f8fafc}.panel{width:min(1120px,100%);margin:auto;padding:32px;border:1px solid var(--line);border-radius:20px;background:rgba(255,255,255,.94);box-shadow:0 24px 70px rgba(15,23,42,.1)}.page-header{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:28px}.page-header h1{margin:6px 0 8px;font-size:clamp(28px,4vw,44px);letter-spacing:-.035em}.eyebrow{margin:0;color:var(--primary);font-size:13px;font-weight:750;text-transform:uppercase;letter-spacing:.08em}.muted{margin:0;color:var(--muted);line-height:1.65}.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:22px}.step{padding:18px;border:1px solid var(--line);border-radius:14px;background:var(--soft);transition:.2s}.step.active{border-color:#93b4ff;background:#eef4ff;box-shadow:inset 0 0 0 1px #bfdbfe}.step.done{border-color:#9bd7bd;background:#effaf5}.step h2{margin:10px 0 6px;font-size:17px}.badge{display:inline-flex;padding:4px 9px;border-radius:999px;background:#e2e8f0;color:#475569;font-size:12px;font-weight:700}.active .badge{background:#dbeafe;color:#1d4ed8}.done .badge{background:#d9f7e9;color:#08734a}.artifact{min-height:250px;padding:26px;border:1px solid var(--line);border-radius:16px;background:var(--surface)}.artifact h2,.artifact h3{margin-top:0}.artifact ul{padding-left:20px;line-height:1.8}.meta{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0}.meta span{padding:7px 10px;border-radius:8px;background:var(--soft);color:var(--muted);font-size:13px}.action-row{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:22px}.primary-action{min-height:44px;padding:0 20px;border:0;border-radius:10px;background:var(--primary);color:#fff;font-weight:700;cursor:pointer}.primary-action:hover{background:#1d4ed8}.primary-action:focus-visible{outline:3px solid #93c5fd;outline-offset:3px}@media(max-width:720px){.shell{padding:20px 12px}.panel{padding:20px}.page-header,.action-row{align-items:stretch;flex-direction:column}.steps{grid-template-columns:1fr}.artifact{padding:20px}}`,
	},
	{
		path: "README.md",
		language: "markdown",
		content: "# AICP Agent 生成原型\n\n`app/page.tsx` 由所选 Coding Agent 生成；其余文件由平台固定脚手架补齐。模型代码属于不可信输入，请人工审查后再用于正式项目。",
	},
] as const;

/**
 * SVG 完全由代码模板生成，模型只能影响已经验证过的颜色与纯文本。所有文本都经过 XML
 * 转义，因此设计预览不需要执行模型提供的 HTML、脚本或事件属性。
 */
export function renderSafeDesignPreview(design: z.infer<typeof DesignDraftSchema>): string {
  const firstPage = design.pages[0];
  if (firstPage === undefined) {
    throw new Error("design preview requires at least one page");
  }
  const title = escapeXml(firstPage.name);
  const sections = firstPage.sections.slice(0, 4);
  const cards = sections
    .map((section, index) => {
      const y = 180 + index * 92;
      return `<rect x="90" y="${y}" width="780" height="68" rx="${parseRadius(design.tokens.borderRadius)}" fill="#ffffff" stroke="${design.tokens.secondaryColor}"/><text x="120" y="${y + 41}" fill="${design.tokens.textColor}" font-size="20">${escapeXml(section)}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 640" role="img" aria-label="${title} design preview"><rect width="960" height="640" fill="${design.tokens.backgroundColor}"/><rect x="0" y="0" width="960" height="96" fill="${design.tokens.primaryColor}"/><text x="64" y="62" fill="#ffffff" font-family="sans-serif" font-size="30" font-weight="700">${title}</text><text x="90" y="146" fill="${design.tokens.textColor}" font-family="sans-serif" font-size="18">${escapeXml(design.direction.slice(0, 70))}</text>${cards}</svg>`;
}

function parseRadius(radius: string): number {
  if (radius === "999px") {
    return 34;
  }
  return Number.parseInt(radius, 10);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
