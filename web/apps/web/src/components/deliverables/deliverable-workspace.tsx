"use client";

import { Button } from "@web/ui/components/button";
import { strToU8, zipSync } from "fflate";
import {
	AlertCircle,
	CheckCircle2,
	Code2,
	Database,
	Download,
	FileCode2,
	FileText,
	ImageIcon,
	ListChecks,
	Loader2,
	MonitorPlay,
	RefreshCw,
	ShieldCheck,
	Smartphone,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import FullscreenToggleButton from "@/components/deliverables/fullscreen-toggle-button";
import { useLocale } from "@/components/i18n/locale-provider";
import type { MessageId, MessageValues } from "@/lib/i18n/messages";
import {
	type CodeArtifact,
	type DesignArtifact,
	isDesignArtifact,
	type RequirementsArtifact,
	type WorkflowArtifact,
	WorkflowArtifactSchema,
} from "@/lib/workflow/contracts";

type DeliverableTab = "preview" | "files" | "verification" | "raw";

const previewResponseSchema = z.object({
	html: z.string().min(1),
	verification: z.object({
		compiler: z.literal("esbuild"),
		status: z.literal("passed"),
		entryFile: z.literal("app/page.tsx"),
		fileCount: z.number().int().positive(),
	}),
});

const previewMessageSchema = z.discriminatedUnion("type", [
	z.object({
		source: z.literal("aicp-code-preview"),
		type: z.literal("ready"),
	}),
	z.object({
		source: z.literal("aicp-code-preview"),
		type: z.literal("error"),
		message: z.string().min(1).max(500),
	}),
]);

export function parseWorkflowDeliverable(
	content: string,
): WorkflowArtifact | null {
	try {
		const raw: unknown = JSON.parse(content);
		const parsed = WorkflowArtifactSchema.safeParse(raw);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/**
 * 同一交付物在任务验收页和工作流画布中必须使用同一套展示规则。这个组件只接收已经由
 * Zod 验证的领域制品，把“如何阅读、预览、下载和查看证据”的复杂度隐藏在内部；调用方
 * 不需要根据 schemaVersion 重复判断，也不能把原始 JSON 重新变成主交付界面。
 */
export default function DeliverableWorkspace({
	artifact,
	rawContent,
	onReadinessChange,
}: {
	artifact: WorkflowArtifact;
	rawContent?: string;
	onReadinessChange?: (ready: boolean) => void;
}) {
	const { t } = useLocale();
	const shellRef = useRef<HTMLDivElement>(null);
	const [tab, setTab] = useState<DeliverableTab>("preview");
	const [runnablePreviewReady, setRunnablePreviewReady] = useState(
		artifact.schemaVersion !== "code.artifact.v0.1",
	);
	const ready =
		artifact.schemaVersion === "code.artifact.v0.1"
			? runnablePreviewReady
			: true;

	useEffect(() => onReadinessChange?.(ready), [onReadinessChange, ready]);
	useEffect(() => {
		setTab("preview");
		setRunnablePreviewReady(artifact.schemaVersion !== "code.artifact.v0.1");
	}, [artifact]);

	const tabs = useMemo<
		readonly {
			id: DeliverableTab;
			label: string;
			icon: typeof MonitorPlay;
		}[]
	>(
		() => [
			{ id: "preview", label: t("产物预览"), icon: MonitorPlay },
			...(artifact.schemaVersion === "code.artifact.v0.1"
				? [{ id: "files" as const, label: t("源代码"), icon: Code2 }]
				: []),
			{ id: "verification", label: t("验证依据"), icon: ListChecks },
			...(rawContent === undefined
				? []
				: [{ id: "raw" as const, label: t("原始数据"), icon: Database }]),
		],
		[artifact.schemaVersion, rawContent, t],
	);

	return (
		<div
			ref={shellRef}
			data-testid="structured-deliverable-shell"
			className="deliverable-fullscreen-shell overflow-hidden rounded-2xl border border-primary/20 bg-background shadow-[0_22px_70px_rgb(0_0_0/18%)]"
		>
			<header className="deliverable-fullscreen-fixed flex flex-wrap items-center justify-between gap-4 border-primary/15 border-b bg-card/95 px-4 py-4 sm:px-5">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<DeliverableIcon artifact={artifact} />
						<h3 className="truncate font-semibold text-lg">{artifact.title}</h3>
						<span className="rounded-full bg-success/10 px-2.5 py-1 font-medium text-[11px] text-success">
							{ready ? t("可体验") : t("正在准备预览")}
						</span>
					</div>
					<p className="mt-1 text-muted-foreground text-xs">
						{deliverableDescription(artifact, t)}
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => downloadArtifact(artifact)}
					>
						<Download className="size-4" />
						{downloadLabel(artifact, t)}
					</Button>
					<FullscreenToggleButton targetRef={shellRef} />
				</div>
			</header>

			<div
				className="deliverable-fullscreen-fixed flex gap-1 overflow-x-auto border-primary/10 border-b bg-card/70 px-3 pt-2"
				role="tablist"
				aria-label={t("交付物查看方式")}
			>
				{tabs.map(({ id, label, icon: Icon }) => (
					<button
						key={id}
						type="button"
						role="tab"
						aria-selected={tab === id}
						onClick={() => setTab(id)}
						className={`flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-t-lg border-x border-t px-4 text-sm transition-colors ${tab === id ? "border-primary/20 bg-background font-semibold text-primary" : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground"}`}
					>
						<Icon className="size-4" />
						{label}
					</button>
				))}
			</div>

			<div
				data-testid="structured-deliverable-scroll-region"
				className="deliverable-fullscreen-scroll min-h-[70vh] bg-accent/45 p-3 sm:p-5"
			>
				{tab === "preview" && (
					<ArtifactPreview
						artifact={artifact}
						onRunnableReadinessChange={setRunnablePreviewReady}
					/>
				)}
				{tab === "files" && artifact.schemaVersion === "code.artifact.v0.1" && (
					<CodeFiles artifact={artifact} />
				)}
				{tab === "verification" && (
					<VerificationPanel artifact={artifact} ready={ready} />
				)}
				{tab === "raw" && rawContent !== undefined && (
					<pre className="min-h-[66vh] overflow-auto whitespace-pre-wrap rounded-xl border bg-card p-5 font-mono text-xs leading-6">
						{rawContent}
					</pre>
				)}
			</div>
		</div>
	);
}

function ArtifactPreview({
	artifact,
	onRunnableReadinessChange,
}: {
	artifact: WorkflowArtifact;
	onRunnableReadinessChange: (ready: boolean) => void;
}) {
	if (artifact.schemaVersion === "requirements.artifact.v0.1") {
		return <RequirementsDocument artifact={artifact} />;
	}
	if (isDesignArtifact(artifact)) {
		return <DesignScreensPreview artifact={artifact} />;
	}
	return (
		<RunnablePreviewFrame
			artifact={artifact}
			onReadinessChange={onRunnableReadinessChange}
		/>
	);
}

/**
 * 设计阶段的主验收对象是平台可信渲染器生成的静态图片。这里保留足够大的滚动画布，并
 * 让桌面端与移动端明确切换；不再把设计稿发送到代码编译 API，也不会执行 SVG 内代码。
 */
function DesignScreensPreview({ artifact }: { artifact: DesignArtifact }) {
	const { t } = useLocale();
	const [breakpoint, setBreakpoint] = useState<"desktop" | "mobile">("desktop");
	const screen =
		artifact.renderedScreens.find((item) => item.id === breakpoint) ??
		artifact.renderedScreens[0];
	if (screen === undefined) return null;
	const imageUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(screen.content)}`;

	return (
		<section className="overflow-hidden rounded-xl border bg-card">
			<header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
				<div>
					<h4 className="font-semibold">{t("设计稿图片")}</h4>
					<p className="mt-1 text-muted-foreground text-xs">
						{t("图片用于人工验收，结构化设计规范将继续传递给 Coding Agent。")}
					</p>
				</div>
				<div
					className="flex rounded-xl border bg-accent/60 p-1"
					role="tablist"
					aria-label={t("设计稿断点")}
				>
					{(["desktop", "mobile"] as const).map((id) => {
						const Icon = id === "desktop" ? MonitorPlay : Smartphone;
						return (
							<button
								key={id}
								type="button"
								role="tab"
								aria-selected={breakpoint === id}
								onClick={() => setBreakpoint(id)}
								className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-4 text-sm transition-colors ${breakpoint === id ? "bg-background font-semibold text-primary shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
							>
								<Icon className="size-4" />
								{id === "desktop" ? t("桌面端") : t("移动端")}
							</button>
						);
					})}
				</div>
			</header>
			<div className="h-[72vh] min-h-155 overflow-auto bg-[radial-gradient(circle_at_center,var(--color-primary-container),transparent_72%)] p-3 sm:p-7">
				<div
					className={`mx-auto overflow-hidden rounded-xl bg-white shadow-[0_24px_80px_rgb(0_0_0/20%)] ${breakpoint === "desktop" ? "w-full min-w-200 max-w-360" : "w-97.5 max-w-full"}`}
				>
					{/* biome-ignore lint/performance/noImgElement: 这是已校验 SVG 的本地 data URL 验收画布，不应交给图片优化服务重新编码或发起网络请求。 */}
					<img
						src={imageUrl}
						alt={t("{title} 的{breakpoint}设计稿", {
							title: artifact.title,
							breakpoint: breakpoint === "desktop" ? t("桌面端") : t("移动端"),
						})}
						className="block h-auto w-full"
					/>
				</div>
			</div>
		</section>
	);
}

function RequirementsDocument({
	artifact,
}: {
	artifact: RequirementsArtifact;
}) {
	const { t } = useLocale();
	return (
		<article className="mx-auto min-h-[66vh] max-w-5xl rounded-xl border bg-card px-5 py-8 shadow-sm sm:px-10 lg:px-14">
			<p className="font-medium text-primary text-xs tracking-[0.18em]">
				{t("产品需求文档")}
			</p>
			<h1 className="mt-3 font-bold text-3xl tracking-tight">
				{artifact.title}
			</h1>
			<p className="mt-5 text-base text-muted-foreground leading-8">
				{artifact.problemStatement}
			</p>
			<DocumentSection title={t("目标用户")} items={artifact.targetUsers} />
			<div className="grid gap-8 md:grid-cols-2">
				<DocumentSection title={t("产品目标")} items={artifact.goals} />
				<DocumentSection title={t("非目标")} items={artifact.nonGoals} />
			</div>
			<DocumentSection
				title={t("功能需求")}
				items={artifact.functionalRequirements}
			/>
			<section className="mt-10">
				<h2 className="font-semibold text-xl">{t("用户故事与验收标准")}</h2>
				<div className="mt-4 space-y-4">
					{artifact.userStories.map((story) => (
						<div key={story.id} className="rounded-xl border bg-accent/45 p-5">
							<p className="font-mono text-primary text-xs">{story.id}</p>
							<p className="mt-2 font-medium">{story.statement}</p>
							<ul className="mt-3 list-disc space-y-2 pl-5 text-muted-foreground text-sm leading-6">
								{story.acceptanceCriteria.map((criterion) => (
									<li key={criterion}>{criterion}</li>
								))}
							</ul>
						</div>
					))}
				</div>
			</section>
			<DocumentSection title={t("约束条件")} items={artifact.constraints} />
			<DocumentSection title={t("待确认问题")} items={artifact.openQuestions} />
		</article>
	);
}

function DocumentSection({
	title,
	items,
}: {
	title: string;
	items: readonly string[];
}) {
	const { t } = useLocale();
	return (
		<section className="mt-10">
			<h2 className="font-semibold text-xl">{title}</h2>
			{items.length === 0 ? (
				<p className="mt-3 text-muted-foreground text-sm">{t("未提供")}</p>
			) : (
				<ul className="mt-4 list-disc space-y-3 pl-5 text-[15px] leading-7">
					{items.map((item) => (
						<li key={item}>{item}</li>
					))}
				</ul>
			)}
		</section>
	);
}

type CodePreviewState =
	| Readonly<{ kind: "loading" }>
	| Readonly<{ kind: "waiting"; html: string }>
	| Readonly<{ kind: "ready"; html: string }>
	| Readonly<{ kind: "error"; message: string }>;

function RunnablePreviewFrame({
	artifact,
	onReadinessChange,
}: {
	artifact: CodeArtifact;
	onReadinessChange: (ready: boolean) => void;
}) {
	const { t } = useLocale();
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [revision, setRevision] = useState(0);
	const [state, setState] = useState<CodePreviewState>({ kind: "loading" });

	// biome-ignore lint/correctness/useExhaustiveDependencies: revision 是“重新编译”按钮产生的显式刷新信号，不属于请求正文。
	useEffect(() => {
		const controller = new AbortController();
		setState({ kind: "loading" });
		onReadinessChange(false);
		fetch("/api/deliverables/code-preview", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ artifact }),
			signal: controller.signal,
		})
			.then(async (response) => {
				const raw: unknown = await response.json();
				if (!response.ok) {
					const message = z.object({ message: z.string() }).safeParse(raw);
					throw new Error(
						message.success ? message.data.message : t("网站预览生成失败"),
					);
				}
				return previewResponseSchema.parse(raw);
			})
			.then((result) => setState({ kind: "waiting", html: result.html }))
			.catch((error: unknown) => {
				if (error instanceof DOMException && error.name === "AbortError")
					return;
				setState({
					kind: "error",
					message:
						error instanceof Error ? error.message : t("网站预览生成失败"),
				});
			});
		return () => controller.abort();
	}, [artifact, onReadinessChange, revision, t]);

	useEffect(() => {
		function receivePreviewStatus(event: MessageEvent<unknown>) {
			if (event.source !== iframeRef.current?.contentWindow) return;
			const parsed = previewMessageSchema.safeParse(event.data);
			if (!parsed.success) return;
			if (parsed.data.type === "ready") {
				setState((current) =>
					current.kind === "waiting"
						? { kind: "ready", html: current.html }
						: current,
				);
				onReadinessChange(true);
				return;
			}
			onReadinessChange(false);
			setState({ kind: "error", message: parsed.data.message });
		}
		window.addEventListener("message", receivePreviewStatus);
		return () => window.removeEventListener("message", receivePreviewStatus);
	}, [onReadinessChange]);

	if (state.kind === "error") {
		return (
			<div className="flex min-h-[66vh] items-center justify-center rounded-xl border border-destructive/25 bg-card p-8 text-center">
				<div className="max-w-lg">
					<AlertCircle className="mx-auto size-8 text-destructive" />
					<h4 className="mt-4 font-semibold text-lg">
						{t("网站预览无法运行")}
					</h4>
					<p className="mt-2 text-muted-foreground text-sm leading-6">
						{state.message}
					</p>
					<Button
						className="mt-5"
						onClick={() => setRevision((value) => value + 1)}
					>
						<RefreshCw className="size-4" />
						{t("重新生成预览")}
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="relative min-h-[66vh] overflow-hidden rounded-xl border bg-white">
			{state.kind !== "ready" && (
				<div className="absolute inset-0 z-10 flex items-center justify-center bg-card/90 backdrop-blur-sm">
					<div className="text-center">
						<Loader2 className="mx-auto size-7 animate-spin text-primary" />
						<p className="mt-3 font-semibold text-sm">
							{state.kind === "loading"
								? t("正在编译网站预览")
								: t("正在启动交互页面")}
						</p>
					</div>
				</div>
			)}
			{state.kind !== "loading" && (
				<iframe
					ref={iframeRef}
					title={t("{title} 网站交互预览", { title: artifact.title })}
					className="h-[72vh] min-h-155 w-full bg-white"
					sandbox="allow-scripts"
					referrerPolicy="no-referrer"
					srcDoc={state.html}
				/>
			)}
		</div>
	);
}

function CodeFiles({ artifact }: { artifact: CodeArtifact }) {
	const { t } = useLocale();
	const initialPath = artifact.files.some(
		(file) => file.path === "app/page.tsx",
	)
		? "app/page.tsx"
		: (artifact.files[0]?.path ?? "");
	const [selectedPath, setSelectedPath] = useState(initialPath);
	const selected =
		artifact.files.find((file) => file.path === selectedPath) ??
		artifact.files[0];
	return (
		<div className="grid min-h-[66vh] overflow-hidden rounded-xl border bg-card lg:grid-cols-[240px_minmax(0,1fr)]">
			<aside className="border-b p-3 lg:border-r lg:border-b-0">
				<p className="px-2 py-2 font-semibold text-xs">{t("项目文件")}</p>
				<div
					className="mt-1 grid gap-1"
					role="tablist"
					aria-label={t("代码文件")}
				>
					{artifact.files.map((file) => (
						<button
							key={file.path}
							type="button"
							role="tab"
							aria-selected={file.path === selected?.path}
							onClick={() => setSelectedPath(file.path)}
							className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-3 text-left font-mono text-xs ${file.path === selected?.path ? "bg-primary-container text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
						>
							<FileCode2 className="size-3.5 shrink-0" />
							<span className="truncate">{file.path}</span>
						</button>
					))}
				</div>
			</aside>
			<div className="min-w-0">
				<div className="flex min-h-12 items-center border-b bg-accent px-4 font-mono text-xs">
					{selected?.path ?? t("未选择文件")}
				</div>
				<pre className="h-[calc(66vh-3rem)] min-h-143 overflow-auto p-5 font-mono text-xs leading-6">
					<code>{selected?.content ?? t("Agent 未返回可预览文件。")}</code>
				</pre>
			</div>
		</div>
	);
}

function VerificationPanel({
	artifact,
	ready,
}: {
	artifact: WorkflowArtifact;
	ready: boolean;
}) {
	const { t } = useLocale();
	return (
		<div className="mx-auto min-h-[66vh] max-w-5xl rounded-xl border bg-card p-6 sm:p-8">
			<h4 className="font-semibold text-xl">{t("交付验证依据")}</h4>
			<p className="mt-2 text-muted-foreground text-sm leading-6">
				{t("机器检查与 Agent 自述分开显示，未执行的检查不会伪装成已通过。")}
			</p>
			<div className="mt-6 grid gap-4 sm:grid-cols-2">
				<EvidenceCard
					icon={ready ? CheckCircle2 : Loader2}
					title={t("主产物可查看")}
					value={ready ? t("已通过") : t("准备中")}
					passed={ready}
				/>
				<EvidenceCard
					icon={ShieldCheck}
					title={t("领域 Schema 校验")}
					value={t("已通过")}
					passed
				/>
			</div>
			{artifact.schemaVersion === "code.artifact.v0.1" && (
				<>
					<div className="mt-8 rounded-xl border border-warning/25 bg-warning/10 p-5">
						<p className="font-semibold text-sm text-warning">
							{t("完整项目构建与自动化测试尚未执行")}
						</p>
						<p className="mt-2 text-muted-foreground text-sm leading-6">
							{t(
								"当前证据只证明交互预览可以编译和启动，不等同于生产部署通过。",
							)}
						</p>
					</div>
					<EvidenceList
						title={t("Agent 提供的测试计划")}
						items={artifact.testPlan}
					/>
					<EvidenceList title={t("已知限制")} items={artifact.limitations} />
				</>
			)}
			{isDesignArtifact(artifact) && (
				<>
					<div className="mt-8 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
						<section className="rounded-xl border p-5">
							<h5 className="font-semibold">{t("设计说明")}</h5>
							<p className="mt-3 text-muted-foreground text-sm leading-6">
								{artifact.direction}
							</p>
						</section>
						<section className="rounded-xl border p-5">
							<h5 className="font-semibold">{t("设计 Token")}</h5>
							<dl className="mt-3 space-y-2 text-xs">
								{Object.entries(artifact.tokens).map(([key, value]) => (
									<div key={key} className="flex justify-between gap-3">
										<dt className="text-muted-foreground">{key}</dt>
										<dd className="break-all text-right font-mono">{value}</dd>
									</div>
								))}
							</dl>
						</section>
					</div>
					<EvidenceList
						title={t("交互规则")}
						items={artifact.interactionRules}
					/>
					<EvidenceList
						title={t("响应式规则")}
						items={artifact.responsiveRules}
					/>
					<EvidenceList
						title={t("无障碍规则")}
						items={artifact.accessibilityRules}
					/>
				</>
			)}
			{artifact.schemaVersion === "requirements.artifact.v0.1" && (
				<>
					<EvidenceList title={t("假设")} items={artifact.assumptions} />
					<EvidenceList
						title={t("待确认问题")}
						items={artifact.openQuestions}
					/>
				</>
			)}
		</div>
	);
}

function EvidenceCard({
	icon: Icon,
	title,
	value,
	passed,
}: {
	icon: typeof ShieldCheck;
	title: string;
	value: string;
	passed: boolean;
}) {
	return (
		<div className="rounded-xl border p-5">
			<Icon className={`size-5 ${passed ? "text-success" : "text-warning"}`} />
			<p className="mt-3 text-muted-foreground text-xs">{title}</p>
			<p className="mt-1 font-semibold">{value}</p>
		</div>
	);
}

function EvidenceList({
	title,
	items,
}: {
	title: string;
	items: readonly string[];
}) {
	const { t } = useLocale();
	return (
		<section className="mt-8">
			<h5 className="font-semibold">{title}</h5>
			{items.length === 0 ? (
				<p className="mt-3 text-muted-foreground text-sm">{t("未提供")}</p>
			) : (
				<ul className="mt-3 list-disc space-y-2 pl-5 text-muted-foreground text-sm leading-6">
					{items.map((item) => (
						<li key={item}>{item}</li>
					))}
				</ul>
			)}
		</section>
	);
}

function DeliverableIcon({ artifact }: { artifact: WorkflowArtifact }) {
	const Icon =
		artifact.schemaVersion === "requirements.artifact.v0.1"
			? FileText
			: isDesignArtifact(artifact)
				? ImageIcon
				: Code2;
	return (
		<span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-container text-primary">
			<Icon className="size-4" />
		</span>
	);
}

function deliverableDescription(
	artifact: WorkflowArtifact,
	t: (id: MessageId, values?: MessageValues) => string,
): string {
	return artifact.schemaVersion === "requirements.artifact.v0.1"
		? t("排版文档 · 可直接阅读与下载")
		: isDesignArtifact(artifact)
			? t("设计画布 · 支持全屏与原稿下载")
			: t("交互网站 · 支持源码与验证依据");
}

function downloadLabel(
	artifact: WorkflowArtifact,
	t: (id: MessageId) => string,
): string {
	return artifact.schemaVersion === "requirements.artifact.v0.1"
		? t("下载文档")
		: isDesignArtifact(artifact)
			? t("下载设计稿")
			: t("下载源码 ZIP");
}

function downloadArtifact(artifact: WorkflowArtifact): void {
	const safeName =
		artifact.title
			.replace(/[^\p{L}\p{N}._-]+/gu, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "agent-deliverable";
	if (artifact.schemaVersion === "requirements.artifact.v0.1") {
		downloadBlob(
			`${safeName}.md`,
			"text/markdown;charset=utf-8",
			requirementsMarkdown(artifact),
		);
		return;
	}
	if (isDesignArtifact(artifact)) {
		// 下载包把人类验收图片与机器消费规范放在一起；Coding Agent 读取的是同一份
		// DesignSpec，而不是从图片反推布局，避免视觉链路再次丢失。
		const { renderedScreens, ...designSpec } = artifact;
		const archive = zipSync(
			{
				"desktop.svg": strToU8(
					renderedScreens.find((screen) => screen.id === "desktop")?.content ??
						"",
				),
				"mobile.svg": strToU8(
					renderedScreens.find((screen) => screen.id === "mobile")?.content ??
						"",
				),
				"design-spec.json": strToU8(JSON.stringify(designSpec, null, 2)),
			},
			{ level: 6 },
		);
		downloadBlob(
			`${safeName}.zip`,
			"application/zip",
			Uint8Array.from(archive).buffer,
		);
		return;
	}
	const files = Object.fromEntries(
		artifact.files.map((file) => [file.path, strToU8(file.content)]),
	);
	const archive = zipSync(files, { level: 6 });
	downloadBlob(
		`${safeName}.zip`,
		"application/zip",
		Uint8Array.from(archive).buffer,
	);
}

function downloadBlob(
	filename: string,
	mimeType: string,
	content: string | ArrayBuffer,
): void {
	const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.click();
	URL.revokeObjectURL(url);
}

function requirementsMarkdown(artifact: RequirementsArtifact): string {
	const list = (items: readonly string[]) =>
		items.length === 0 ? "- 无" : items.map((item) => `- ${item}`).join("\n");
	return `# ${artifact.title}\n\n${artifact.problemStatement}\n\n## 目标用户\n\n${list(artifact.targetUsers)}\n\n## 产品目标\n\n${list(artifact.goals)}\n\n## 非目标\n\n${list(artifact.nonGoals)}\n\n## 功能需求\n\n${list(artifact.functionalRequirements)}\n\n## 约束条件\n\n${list(artifact.constraints)}\n\n## 待确认问题\n\n${list(artifact.openQuestions)}\n`;
}
