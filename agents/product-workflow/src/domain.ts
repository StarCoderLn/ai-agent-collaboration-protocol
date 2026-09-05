import { z } from "zod";
import { findWorkflowAgent, WorkflowAgentIdSchema } from "./catalog.js";
import { renderDesignScreens } from "./design-renderer.js";

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

/**
 * 无 PRD 的新链路直接使用任务合同，不为填满旧结构而生成虚构用户故事、目标或验收记录。
 * 该输入与 Agent 生成的 RequirementsArtifact 保持不同版本标识，供提示词明确说明来源；
 * 它只存在于执行输入中，不属于可交付、可计费或“已验收”的上游制品。
 */
export const TaskRequirementsSchema = z.object({
  schemaVersion: z.literal("task.requirements.v1"),
  taskId: z.string().min(1).max(128),
  title: NonEmptyText.max(200),
  description: NonEmptyText.max(20_000),
  acceptanceCriteria: NonEmptyText.max(10_000),
  deliverableFormat: NonEmptyText.max(2_000),
}).strict();
const ExecutionRequirementsSchema = z.union([RequirementsArtifactSchema, TaskRequirementsSchema]);

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

const RenderedDesignScreenSchema = z
  .object({
    id: z.enum(["desktop", "mobile"]),
    label: ShortText,
    viewport: z.object({
      width: z.number().int().min(320).max(2_560),
      height: z.number().int().min(568).max(1_600),
    }).strict(),
    canvas: z.object({
      width: z.number().int().min(320).max(2_560),
      height: z.number().int().min(568).max(4_000),
    }).strict(),
    mimeType: z.literal("image/svg+xml"),
    content: z.string().trim().min(500).max(120_000).startsWith("<svg"),
  })
  .strict()
  .superRefine((screen, context) => {
    // 设计稿由可信平台渲染器生成，但仍在领域边界阻止脚本、外部引用和 foreignObject，
    // 防止未来替换渲染器或读取历史数据时把“平台生成”误当作永久可信的假设。
    if (/<(?:script|foreignObject)\b|\bon[a-z]+\s*=|\b(?:href|xlink:href)\s*=|\burl\s*\(/i.test(screen.content)) {
      context.addIssue({ code: "custom", path: ["content"], message: "UNSAFE_RENDERED_DESIGN" });
    }
    if (screen.canvas.width !== screen.viewport.width || screen.canvas.height < screen.viewport.height) {
      context.addIssue({ code: "custom", path: ["canvas"], message: "RENDERED_DESIGN_DIMENSIONS_INVALID" });
    }
		const expectedViewport = screen.id === "desktop"
			? { width: 1_440, height: 900 }
			: { width: 390, height: 844 };
		if (screen.viewport.width !== expectedViewport.width || screen.viewport.height !== expectedViewport.height) {
			context.addIssue({ code: "custom", path: ["viewport"], message: "RENDERED_DESIGN_BREAKPOINT_INVALID" });
		}
  });

export const RenderedDesignScreensSchema = z
  .array(RenderedDesignScreenSchema)
  .length(2)
  .superRefine((screens, context) => {
    if (new Set(screens.map((screen) => screen.id)).size !== 2) {
      context.addIssue({ code: "custom", message: "RENDERED_DESIGN_BREAKPOINTS_MISSING" });
    }
  });
export type RenderedDesignScreen = z.infer<typeof RenderedDesignScreenSchema>;

/**
 * v0.4 把用户验收对象改为平台确定性生成的桌面/移动设计稿。模型只负责 DesignDraft，
 * renderedScreens 由可信代码补齐；Coding Agent 继续消费同一份结构化设计规范。
 */
export const DesignArtifactSchema = DesignDraftSchema.extend({
  schemaVersion: z.literal("design.artifact.v0.4"),
  taskId: z.string().min(1).max(128),
  rendererVersion: z.literal("aicp-design-renderer.v1"),
  renderedScreens: RenderedDesignScreensSchema,
  generatedBy: GeneratedBySchema,
  generatedAt: z.string().datetime(),
}).strict();
export type DesignArtifact = z.infer<typeof DesignArtifactSchema>;

/** Coding 与验收共用由 DesignSpec 推导的稳定锚点，不再依赖模型先写一份设计阶段 TSX。 */
export function extractDesignRegionIds(design: Pick<DesignDraft, "preview">): string[] {
  return [
    "page-shell",
    "hero",
    ...design.preview.sections.map((section, index) => {
      const slug = section.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      return `section-${index + 1}-${slug === "" ? "content" : slug}`;
    }),
  ];
}

/**
 * 返回 Coding 产物必须继承的可见文案锚点。提示词与产物验收必须共用这一个权威列表，
 * 否则模型可能看不到平台随后会强制检查的内容，形成无法靠重试稳定修复的隐性契约。
 */
export function extractDesignVisibleTexts(design: Pick<DesignDraft, "preview">): string[] {
	const navigationTexts = design.preview.navigation === null
		? []
		: [
			design.preview.navigation.brand,
			...design.preview.navigation.items.map((item) => item.label),
			...(design.preview.navigation.action === null ? [] : [design.preview.navigation.action]),
		];
	return [
		...navigationTexts,
		design.preview.hero.eyebrow,
		design.preview.hero.title,
		design.preview.hero.description,
		design.preview.hero.primaryAction,
		...(design.preview.hero.secondaryAction === null ? [] : [design.preview.hero.secondaryAction]),
		...design.preview.metrics.flatMap((metric) => [metric.label, metric.value]),
		...design.preview.sections.map((section) => section.title),
	];
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
// 与 CSS 一致：长度只保留 max(30_000) 这一条边界。页面步骤的输出预算同样是 10k token，
// 物理上写不出更长的内容，低于它的软上限不提供额外保护。原先的 22k 上限低于后台管理类
// 页面的真实需要（实测 23.8k 字符），会让这类任务在页面步骤稳定失败，并把重试推向
// 过度压缩、反而丢失设计稿文案。页面应通过数据数组和共享组件表达重复内容，这由提示词
// 目标和超长重试指令负责。
export const CompactCodePageSourceSchema = z.string().min(100).max(30_000);

export const CompactCodeStylesSourceSchema = z.string().min(300).max(30_000).superRefine((source, context) => {
		// 生成样式最终会进入隔离 iframe 的 style 标签。禁止所有外部资源和可执行 CSS
		// 扩展，确保恢复视觉表达能力不会重新打开网络访问或 CSS 注入边界。扫描前忽略
		// 注释和字符串，因为其中的 `url()` 只是普通文本，不能触发浏览器资源加载。
		// 长度只保留 max(30_000) 这一条边界。CSS 步骤的输出预算是 10k token，物理上就写不出
		// 更长的内容，因此任何低于它的软上限都不提供额外保护，只会在实测合规区间（12k–23k
		// 字符）附近制造必然失败——10k 的旧上限已经这样让每次真实执行都停在 CSS 步骤。
		// 截断由 finish_reason 单独识别，精简由提示词目标和超长重试指令负责。
		const executableCss = cssExecutableText(source);
		// `behavior:` 要拦的是 IE 的 HTC 脚本挂载，必须限定为独立属性名。不加边界会连
		// `scroll-behavior`、`overscroll-behavior` 这类标准属性一起误判——真实模型几乎
		// 每次都会为营销页写 `scroll-behavior: smooth`，导致安全规则稳定拒绝合规样式。
		if (/(?:@import|@font-face|url\s*\(|image-set\s*\(|expression\s*\(|javascript:|(?<![\w-])behavior\s*:|-moz-binding|<\/style)/i.test(executableCss)) {
			context.addIssue({ code: "custom", message: "UNSAFE_CSS_REFERENCE" });
		}
	});

export const CompactCodeDraftSchema = z
	.object({
		// v1 可继续成批传输两个文件；可靠状态机 v2 则复用同一字段 Schema 分段验收，
		// 确保两条执行路径不会逐渐形成不同的安全与长度规则。
		pageTsx: CompactCodePageSourceSchema,
		globalsCss: CompactCodeStylesSourceSchema,
	})
	.strict();

/**
 * 只保留浏览器会按 CSS 语法解释的字符，注释和引号内文本替换为空格。该函数不尝试
 * 修复或执行 CSS，只负责让安全关键词检查免受说明性注释影响；未闭合结构仍由后续
 * CSS 语法门禁拒绝。
 */
function cssExecutableText(css: string): string {
	let result = "";
	let quote: "\"" | "'" | null = null;
	let inComment = false;
	for (let index = 0; index < css.length; index += 1) {
		const current = css[index];
		const next = css[index + 1];
		if (inComment) {
			if (current === "*" && next === "/") {
				result += "  ";
				index += 1;
				inComment = false;
			} else result += current === "\n" ? "\n" : " ";
			continue;
		}
		if (quote !== null) {
			if (current === "\\") {
				result += "  ";
				index += 1;
			} else {
				if (current === quote) quote = null;
				result += current === "\n" ? "\n" : " ";
			}
			continue;
		}
		if (current === "/" && next === "*") {
			result += "  ";
			index += 1;
			inComment = true;
		} else if (current === "\"" || current === "'") {
			result += " ";
			quote = current;
		} else result += current;
	}
	return result;
}

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
		// 合计上限只是防止文件集合本身失控的兜底，不能收紧单文件已经允许的组合，否则会
		// 出现“每个文件都合法、装配时却必然失败”的死角——40k 就低于 TSX 与 CSS 各自 30k
		// 的合法上界之和，后台管理这类内容密集页面（实测 24.3k + 22.6k）因此在装配阶段被
		// 拒绝，且该错误发生在重试循环之外，模型没有任何修复机会。
		// 不变量：上限 ≥ 平台脚手架(约 700 字符) + 两份模型源码各自的 30k 上界。
		const totalCharacters = draft.files.reduce((total, file) => total + file.content.length, 0);
		if (totalCharacters > 64_000) {
			context.addIssue({ code: "custom", path: ["files"], message: "combined file content exceeds 64000 characters" });
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
      requirements: ExecutionRequirementsSchema,
    }).strict(),
    ExecutionBaseSchema.extend({
      step: z.literal("code"),
      requirements: ExecutionRequirementsSchema,
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
      schemaVersion: "design.artifact.v0.4",
      rendererVersion: "aicp-design-renderer.v1",
      renderedScreens: renderDesignScreens(design),
      ...metadata,
    });
  }
	const compactCode = CompactCodeDraftSchema.parse(draft);
	const agentName = findWorkflowAgent(input.agentId).name;
	// 稳定工程脚手架继续由平台装配；真正决定页面视觉的 TSX 与 CSS 则必须成对来自
	// 同一个 Coding Agent 批次，避免固定模板覆盖已验收设计稿。
	const codeScaffold = buildCodeScaffold(input.design);
  return CodeArtifactSchema.parse({
		title: `${input.design.title} · 可运行前端原型`,
		implementationSummary: `${agentName} 根据任务需求与上游设计制品生成核心交互页面；平台负责装配固定 Next.js 脚手架。`,
		fileTree: codeScaffold.map((file) => file.path),
		files: codeScaffold.map((file) => ({
			...file,
			content: file.path === "app/page.tsx"
				? compactCode.pageTsx
				: file.path === "app/globals.css"
					? compactCode.globalsCss
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

function buildCodeScaffold(design: Pick<DesignArtifact, "tokens">) {
	const { primaryColor, secondaryColor, backgroundColor, textColor, borderRadius, spacingBase } = design.tokens;
	const fontStack = trustedFontStack(design.tokens.fontFamily);
	return [
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
		content: `:root{color-scheme:light;--ink:${textColor};--muted:${textColor}b8;--line:${primaryColor}30;--surface:#fff;--soft:${secondaryColor}14;--primary:${primaryColor};--primary-dark:${secondaryColor};--success:#16865b;--warning:#b45309;--danger:#c2415d;--radius:${borderRadius};--space:${spacingBase}}*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:${fontStack};color:var(--ink);background:${backgroundColor}}button,input,select,textarea{font:inherit}button,a,select{cursor:pointer}h1,h2,h3,p{margin-top:0}.shell{min-height:100vh;padding:48px 24px;background:radial-gradient(circle at 84% 0,${primaryColor}24 0,transparent 32%),radial-gradient(circle at 8% 42%,${secondaryColor}18 0,transparent 28%),${backgroundColor}}.panel{width:min(1180px,100%);margin:auto;padding:calc(var(--space)*4);border:1px solid var(--line);border-radius:calc(var(--radius) + 6px);background:rgba(255,255,255,.95);box-shadow:0 28px 80px ${primaryColor}1f}.page-header{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:28px}.page-header h1{margin:6px 0 8px;font-size:clamp(28px,4vw,44px);letter-spacing:-.035em}.header-actions,.toolbar,.action-row{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.eyebrow{margin:0;color:var(--primary);font-size:13px;font-weight:750;text-transform:uppercase;letter-spacing:.08em}.muted{margin:0;color:var(--muted);line-height:1.65}.toolbar{justify-content:space-between;margin-bottom:18px}.content{min-height:260px}.summary{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(240px,.7fr);gap:18px;margin-bottom:18px}.grid{display:grid;gap:16px}.grid-2{grid-template-columns:repeat(2,minmax(0,1fr))}.grid-3{grid-template-columns:repeat(3,minmax(0,1fr))}.card,.status-card,.metric-card,.empty-state{padding:20px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}.card h2,.card h3,.status-card h2,.status-card h3{margin-bottom:8px}.status-card{border-left:4px solid var(--primary);background:linear-gradient(135deg,#fff,var(--soft))}.metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:18px}.metric-card{min-height:126px;background:linear-gradient(145deg,#fff,var(--soft))}.label{display:block;margin-bottom:8px;color:var(--muted);font-size:13px;font-weight:700}.value{display:block;font-size:clamp(24px,3vw,34px);font-weight:800;letter-spacing:-.025em}.badge{display:inline-flex;align-items:center;width:max-content;padding:5px 10px;border-radius:999px;background:var(--soft);color:var(--ink);font-size:12px;font-weight:750}.badge-success{background:#e8f7ef;color:#08734a}.badge-warning{background:#fff4db;color:#98520a}.badge-danger{background:#fff0f3;color:#a82f4b}.meta{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}.meta span{padding:7px 10px;border-radius:var(--radius);background:var(--soft);color:var(--muted);font-size:13px}.list{display:grid;gap:10px;margin:0;padding:0;list-style:none}.list-item{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid var(--line)}.list-item:last-child{border-bottom:0}.field{display:grid;gap:7px}.control{width:100%;min-height:44px;padding:10px 12px;border:1px solid var(--line);border-radius:var(--radius);background:#fff;color:var(--ink)}.control:focus{border-color:var(--primary);outline:3px solid ${primaryColor}24}.table-wrap{max-width:100%;overflow:auto;border:1px solid var(--line);border-radius:var(--radius)}.data-table{width:100%;border-collapse:collapse;background:#fff}.data-table th,.data-table td{padding:14px 16px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}.data-table th{background:var(--soft);color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}.empty-state{display:grid;min-height:220px;place-items:center;text-align:center;color:var(--muted);background:var(--soft)}.action-row{justify-content:flex-end;margin-top:22px}.primary-action,.secondary-action,.danger-action{min-height:44px;padding:0 20px;border-radius:var(--radius);font-weight:750;transition:transform .16s,box-shadow .16s,background .16s}.primary-action{border:0;background:linear-gradient(135deg,var(--primary),var(--primary-dark));color:#fff;box-shadow:0 10px 24px ${primaryColor}3d}.secondary-action{border:1px solid var(--line);background:#fff;color:var(--ink)}.danger-action{border:1px solid #fecdd6;background:#fff5f7;color:var(--danger)}.primary-action:hover,.secondary-action:hover,.danger-action:hover{transform:translateY(-1px)}.primary-action:focus-visible,.secondary-action:focus-visible,.danger-action:focus-visible{outline:3px solid ${primaryColor}4d;outline-offset:3px}.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:22px}.step{padding:18px;border:1px solid var(--line);border-radius:var(--radius);background:var(--soft)}.step.active{border-color:var(--primary);background:var(--soft)}.step.done{border-color:#9bd7bd;background:#effaf5}.artifact{min-height:250px;padding:26px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}@media(max-width:760px){.shell{padding:20px 12px}.panel{padding:20px}.page-header,.action-row{align-items:stretch;flex-direction:column}.header-actions,.toolbar{align-items:stretch}.summary,.grid-2,.grid-3,.steps{grid-template-columns:1fr}.primary-action,.secondary-action,.danger-action{width:100%}.artifact{padding:20px}}`,
	},
	{
		path: "README.md",
		language: "markdown",
		content: "# AICP Agent 生成原型\n\n`app/page.tsx` 与 `app/globals.css` 由所选 Coding Agent 同批生成；工程清单、布局和说明由平台固定脚手架补齐。模型代码属于不可信输入，请人工审查后再用于正式项目。",
	},
	] as const;
}

/**
 * 字体名称来自不可信模型，不能直接插入 CSS。这里只把常见设计意图映射到平台维护的
 * 本地字体栈；未知名称退回系统字体，既保留风格差异，也阻止 CSS 注入和远程字体依赖。
 */
function trustedFontStack(fontFamily: string): string {
	const normalized = fontFamily.toLowerCase();
	if (normalized.includes("mono")) return "ui-monospace,SFMono-Regular,Menlo,monospace";
	if (normalized.includes("serif") && !normalized.includes("sans")) return "ui-serif,Georgia,serif";
	return "Inter,ui-sans-serif,system-ui,sans-serif";
}
