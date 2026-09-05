"use client";

import {
	AlertCircle,
	Download,
	FileText,
	ImageIcon,
	MonitorPlay,
	Video,
} from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import DeliverableWorkspace, {
	parseWorkflowDeliverable,
} from "@/components/deliverables/deliverable-workspace";
import FullscreenToggleButton from "@/components/deliverables/fullscreen-toggle-button";
import { useLocale } from "@/components/i18n/locale-provider";

export type ResultDeliverable = Readonly<{
	summary: string;
	kind: "inline" | "file";
	content?: string;
	mimeType: string;
	sizeBytes: string;
	note: string | null;
}>;

type NativePreview =
	| Readonly<{ kind: "document"; markdown: boolean; content: string }>
	| Readonly<{ kind: "html"; content: string }>
	| Readonly<{ kind: "image"; source: string }>
	| Readonly<{ kind: "video"; source: string }>
	| Readonly<{ kind: "pdf"; source: string }>
	| Readonly<{ kind: "download"; source: string }>
	| Readonly<{ kind: "unsupported" }>;

/**
 * 任务结果的 MIME 类型来自外部 Agent，不能让详情页自行猜测如何执行或渲染。这个适配器
 * 统一完成格式识别、安全边界和验收就绪判断：结构化工作流制品走严格 Schema；普通文档、
 * 图片、视频、PDF 与 HTML 使用隔离的原生查看器；未知 JSON 或不可访问的文件引用明确阻止
 * 验收，避免用户面对一段原始数据却误以为平台已经验证了交付质量。
 */
export default function ResultDeliverableWorkspace({
	result,
	onReadinessChange,
}: {
	result: ResultDeliverable;
	onReadinessChange: (ready: boolean) => void;
}) {
	const artifact =
		result.kind === "inline" && result.content !== undefined
			? parseWorkflowDeliverable(result.content)
			: null;

	if (artifact !== null) {
		return (
			<DeliverableWorkspace
				artifact={artifact}
				rawContent={result.content}
				onReadinessChange={onReadinessChange}
			/>
		);
	}

	return (
		<NativeDeliverableWorkspace
			result={result}
			preview={resolveNativePreview(result)}
			onReadinessChange={onReadinessChange}
		/>
	);
}

function NativeDeliverableWorkspace({
	result,
	preview,
	onReadinessChange,
}: {
	result: ResultDeliverable;
	preview: NativePreview;
	onReadinessChange: (ready: boolean) => void;
}) {
	const { t } = useLocale();
	const shellRef = useRef<HTMLDivElement>(null);
	// 文件下载入口本身已经可用时允许用户继续验收；平台不宣称浏览器已经读取了 PPTX，
	// 页面会明确要求用户下载检查，避免把“可获取”误写成“已预览”。
	const immediatelyReadable =
		preview.kind === "document" || preview.kind === "download";
	useEffect(
		() => onReadinessChange(immediatelyReadable),
		[immediatelyReadable, onReadinessChange],
	);

	return (
		<div
			ref={shellRef}
			data-testid="native-deliverable-shell"
			className="deliverable-fullscreen-shell overflow-hidden rounded-2xl border border-primary/20 bg-background shadow-[0_22px_70px_rgb(0_0_0/18%)]"
		>
			<header className="deliverable-fullscreen-fixed flex flex-wrap items-center justify-between gap-4 border-primary/15 border-b bg-card/95 px-4 py-4 sm:px-5">
				<div className="min-w-0">
					<div className="flex items-center gap-3">
						<NativePreviewIcon kind={preview.kind} />
						<div className="min-w-0">
							<h3 className="truncate font-semibold text-lg">
								{result.summary}
							</h3>
							<p className="mt-1 font-mono text-muted-foreground text-xs">
								{result.mimeType} · {formatBytes(result.sizeBytes)}
							</p>
						</div>
					</div>
				</div>
				<FullscreenToggleButton targetRef={shellRef} />
			</header>
			{/*
			 * 全屏外壳固定为一个视口高后，正文必须以 min-h-0 参与 Flex 收缩，才能形成
			 * 真正的内部滚动区域。若继续让整个外壳滚动，浏览器全屏状态下会因内容高度
			 * 撑开根节点而没有可滚动的溢出空间，长论文便无法使用滚轮继续阅读。
			 */}
			<div
				data-testid="native-deliverable-scroll-region"
				className="deliverable-fullscreen-scroll min-h-[70vh] bg-accent/45 p-3 sm:p-5"
			>
				<NativePreviewBody
					preview={preview}
					title={result.summary}
					onReadinessChange={onReadinessChange}
				/>
				{result.note !== null && result.note.length > 0 && (
					<p className="mx-auto mt-4 max-w-6xl rounded-xl border bg-card px-5 py-4 text-muted-foreground text-sm leading-6">
						{t("Agent 备注：{note}", { note: result.note })}
					</p>
				)}
			</div>
		</div>
	);
}

function NativePreviewBody({
	preview,
	title,
	onReadinessChange,
}: {
	preview: NativePreview;
	title: string;
	onReadinessChange: (ready: boolean) => void;
}) {
	const { t } = useLocale();
	if (preview.kind === "document") {
		return preview.markdown ? (
			<MarkdownDocument title={title} content={preview.content} />
		) : (
			<article className="mx-auto min-h-[66vh] max-w-5xl rounded-xl border bg-card px-5 py-8 shadow-sm sm:px-10 lg:px-14">
				<h1 className="font-bold text-3xl tracking-tight">{title}</h1>
				<p className="mt-7 whitespace-pre-wrap text-[15px] leading-8">
					{preview.content}
				</p>
			</article>
		);
	}
	if (preview.kind === "html") {
		return (
			<iframe
				title={t("{title} 网站交互预览", { title })}
				className="h-[72vh] min-h-155 w-full rounded-xl border bg-white"
				sandbox="allow-scripts"
				referrerPolicy="no-referrer"
				srcDoc={sandboxInlineHtml(preview.content)}
				onLoad={() => onReadinessChange(true)}
			/>
		);
	}
	if (preview.kind === "image") {
		return (
			<div className="flex min-h-[66vh] items-center justify-center overflow-auto rounded-xl border bg-card p-4 sm:p-8">
				{/* 外部 Agent 返回的资源不交给 Next 图片优化代理，避免服务端代用户请求不可信 URL。 */}
				{/* biome-ignore lint/performance/noImgElement: 交付物必须留在浏览器的不可信资源边界内。 */}
				<img
					src={preview.source}
					alt={title}
					className="max-h-[78vh] max-w-full rounded-lg border bg-white object-contain shadow-2xl"
					onLoad={() => onReadinessChange(true)}
					onError={() => onReadinessChange(false)}
				/>
			</div>
		);
	}
	if (preview.kind === "video") {
		return (
			<div className="flex min-h-[66vh] items-center justify-center rounded-xl border bg-black p-3 sm:p-6">
				{/* biome-ignore lint/a11y/useMediaCaption: 平台只能预览 Agent 已提交的视频文件，不能伪造原文件并未提供的字幕轨。 */}
				<video
					controls
					preload="metadata"
					className="max-h-[78vh] w-full max-w-6xl"
					onCanPlay={() => onReadinessChange(true)}
					onError={() => onReadinessChange(false)}
				>
					<source src={preview.source} />
					{t("当前浏览器无法播放这份视频交付物。")}
				</video>
			</div>
		);
	}
	if (preview.kind === "pdf") {
		return (
			<iframe
				title={t("{title} PDF 预览", { title })}
				className="h-[76vh] min-h-170 w-full rounded-xl border bg-white"
				referrerPolicy="no-referrer"
				sandbox=""
				src={preview.source}
				onLoad={() => onReadinessChange(true)}
			/>
		);
	}
	if (preview.kind === "download") {
		return (
			<div className="flex min-h-[66vh] items-center justify-center rounded-xl border bg-card p-8 text-center">
				<div className="max-w-xl">
					<span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary-container text-primary">
						<Download className="size-6" />
					</span>
					<h4 className="mt-5 font-semibold text-xl">
						{t("文件已准备好，可下载检查")}
					</h4>
					<p className="mt-3 text-muted-foreground text-sm leading-7">
						{t(
							"当前浏览器无法在页面内完整预览该格式，请下载并使用对应应用检查交付内容。",
						)}
					</p>
					<a
						href={preview.source}
						target="_blank"
						rel="noreferrer"
						aria-label={t("下载{title}", { title })}
						className="mt-6 inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl bg-primary px-5 font-semibold text-primary-foreground text-sm transition hover:bg-primary/90"
					>
						<Download className="size-4" />
						{t("下载文件")}
					</a>
				</div>
			</div>
		);
	}
	return (
		<div className="flex min-h-[66vh] items-center justify-center rounded-xl border border-warning/30 bg-card p-8 text-center">
			<div className="max-w-xl">
				<AlertCircle className="mx-auto size-9 text-warning" />
				<h4 className="mt-4 font-semibold text-xl">
					{t("当前交付物无法直接验收")}
				</h4>
				<p className="mt-3 text-muted-foreground text-sm leading-7">
					{t(
						"Agent 返回的格式没有可用的原生预览。请要求 Agent 改为文档、图片、视频、PDF、HTML 或平台结构化制品后再验收。",
					)}
				</p>
			</div>
		</div>
	);
}

function MarkdownDocument({
	title,
	content,
}: {
	title: string;
	content: string;
}) {
	const lines = useMemo(() => content.split(/\r?\n/), [content]);
	return (
		<article className="mx-auto min-h-[66vh] max-w-5xl rounded-xl border bg-card px-5 py-8 shadow-sm sm:px-10 lg:px-14">
			<h1 className="mb-8 font-bold text-3xl tracking-tight">{title}</h1>
			<div className="space-y-3">
				{lines.map((line, index) => (
					<MarkdownLine key={`${index}:${line}`} line={line} />
				))}
			</div>
		</article>
	);
}

function MarkdownLine({ line }: { line: string }) {
	if (line.startsWith("### "))
		return <h3 className="pt-4 font-semibold text-lg">{line.slice(4)}</h3>;
	if (line.startsWith("## "))
		return <h2 className="pt-6 font-semibold text-2xl">{line.slice(3)}</h2>;
	if (line.startsWith("# "))
		return <h2 className="pt-6 font-bold text-3xl">{line.slice(2)}</h2>;
	if (/^[-*] /.test(line))
		return (
			<p className="pl-5 text-[15px] leading-7 before:mr-3 before:content-['•']">
				{line.slice(2)}
			</p>
		);
	if (/^\d+\. /.test(line))
		return <p className="pl-5 text-[15px] leading-7">{line}</p>;
	if (line.trim().length === 0) return <div className="h-2" aria-hidden />;
	return <p className="whitespace-pre-wrap text-[15px] leading-8">{line}</p>;
}

function NativePreviewIcon({ kind }: { kind: NativePreview["kind"] }) {
	const Icon =
		kind === "image"
			? ImageIcon
			: kind === "video"
				? Video
				: kind === "html"
					? MonitorPlay
					: kind === "unsupported"
						? AlertCircle
						: FileText;
	return (
		<span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-container text-primary">
			<Icon className="size-4" />
		</span>
	);
}

function resolveNativePreview(result: ResultDeliverable): NativePreview {
	const mimeType = result.mimeType.toLowerCase().split(";", 1)[0]?.trim();
	if (
		result.kind === "inline" &&
		result.content !== undefined &&
		(mimeType === "text/markdown" || mimeType === "text/plain")
	) {
		return {
			kind: "document",
			markdown: mimeType === "text/markdown",
			content: result.content,
		};
	}
	if (
		result.kind === "inline" &&
		result.content !== undefined &&
		mimeType === "text/html"
	) {
		return { kind: "html", content: result.content };
	}
	const source = safeBrowserResource(result.content, mimeType);
	if (source === null) return { kind: "unsupported" };
	if (mimeType?.startsWith("image/")) return { kind: "image", source };
	if (mimeType?.startsWith("video/")) return { kind: "video", source };
	if (mimeType === "application/pdf") return { kind: "pdf", source };
	if (result.kind === "file") return { kind: "download", source };
	return { kind: "unsupported" };
}

/** 仅允许浏览器可独立读取的 URL；s3:// 等内部引用必须先由服务端换成短期下载地址。 */
function safeBrowserResource(
	content: string | undefined,
	mimeType: string | undefined,
): string | null {
	if (content === undefined) return null;
	try {
		const url = new URL(content, window.location.origin);
		if (
			url.protocol === "https:" ||
			url.protocol === "http:" ||
			url.protocol === "blob:"
		)
			return url.href;
		if (
			url.protocol === "data:" &&
			mimeType !== undefined &&
			content.startsWith(`data:${mimeType}`)
		)
			return content;
		return null;
	} catch {
		return null;
	}
}

/**
 * HTML 交付物只能在无同源权限的 iframe 中运行。CSP 阻断网络、表单、父页面导航和外部
 * 资源；这不是内容质量校验，但能保证用户浏览交付物时不会把平台会话暴露给 Agent 脚本。
 */
function sandboxInlineHtml(content: string): string {
	const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none';">`;
	if (/<head(?:\s[^>]*)?>/i.test(content))
		return content.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${policy}`);
	return `<!doctype html><html><head>${policy}</head><body>${content}</body></html>`;
}

function formatBytes(raw: string): string {
	const bytes = Number(raw);
	if (!Number.isSafeInteger(bytes) || bytes < 0) return `${raw} B`;
	if (bytes < 1_024) return `${bytes} B`;
	if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
	return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
