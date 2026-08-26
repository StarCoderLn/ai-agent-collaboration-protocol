"use client";

import { Button } from "@web/ui/components/button";
import { Input } from "@web/ui/components/input";
import { Label } from "@web/ui/components/label";
import { Textarea } from "@web/ui/components/textarea";
import {
	AlertCircle,
	Bot,
	BookOpen,
	CheckCircle2,
	Circle,
	Clock3,
	ExternalLink,
	FileCheck2,
	Loader2,
	PlayCircle,
	RotateCcw,
} from "lucide-react";
import { useState } from "react";
import { SelectField } from "@web/ui/components/select";
import { useLocale } from "@/components/i18n/locale-provider";
import {
	type AgentLabRequest,
	AgentLabRequestSchema,
	type AgentLabRouteResponse,
	AgentLabRouteResponseSchema,
} from "@/lib/agent-lab/contracts";

type FormState = {
	topic: string;
	researchQuestion: string;
	language: AgentLabRequest["language"];
	targetWords: string;
	sourceCount: string;
	yearFrom: string;
	yearTo: string;
};

const INITIAL_FORM_ZH: FormState = {
	topic: "AI Agent 协作协议的可靠性",
	researchQuestion:
		"现有研究中，哪些认证、幂等和失败恢复机制适合独立部署的 AI Agent？",
	language: "zh-CN",
	targetWords: "700",
	sourceCount: "4",
	yearFrom: "2020",
	yearTo: "2026",
};

const INITIAL_FORM_EN: FormState = {
	topic: "Reliability of AI Agent collaboration protocols",
	researchQuestion: "Which authentication, idempotency, and failure-recovery mechanisms are suitable for independently deployed AI Agents?",
	language: "en",
	targetWords: "700",
	sourceCount: "4",
	yearFrom: "2020",
	yearTo: "2026",
};

type ViewState =
	| { kind: "idle" }
	| { kind: "submitting" }
	| {
			kind: "success";
			response: Extract<AgentLabRouteResponse, { success: true }>;
			accepted: boolean;
	  }
	| { kind: "error"; message: string; retryable: boolean };

const FLOW_STEPS = [
	"填写任务",
	"选择 Agent",
	"Agent 执行",
	"查看交付",
	"验收完成",
] as const;

export default function ResearchAgentLab() {
	const { locale, t } = useLocale();
	const [form, setForm] = useState<FormState>(() => locale === "en" ? INITIAL_FORM_EN : INITIAL_FORM_ZH);
	const [state, setState] = useState<ViewState>({ kind: "idle" });

	function updateField<K extends keyof FormState>(
		field: K,
		value: FormState[K],
	) {
		setForm((current) => ({ ...current, [field]: value }));
		if (state.kind === "error") {
			setState({ kind: "idle" });
		}
	}

	async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const candidate = {
			topic: form.topic,
			researchQuestion: form.researchQuestion,
			language: form.language,
			targetWords: Number(form.targetWords),
			sourceCount: Number(form.sourceCount),
			...(form.yearFrom === "" ? {} : { yearFrom: Number(form.yearFrom) }),
			...(form.yearTo === "" ? {} : { yearTo: Number(form.yearTo) }),
		};
		const parsed = AgentLabRequestSchema.safeParse(candidate);
		if (!parsed.success) {
			setState({
				kind: "error",
				message: parsed.error.issues[0]?.message ?? t("请检查输入内容"),
				retryable: false,
			});
			return;
		}

		setState({ kind: "submitting" });
		try {
			const response = await fetch("/api/agent-lab/research", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(parsed.data),
			});
			const rawResponse: unknown = await response.json();
			const parsedResponse = AgentLabRouteResponseSchema.safeParse(rawResponse);
			if (!parsedResponse.success) {
				throw new Error(t("Agent Lab 返回了无法识别的数据"));
			}
			if (!parsedResponse.data.success) {
				setState({
					kind: "error",
					message: parsedResponse.data.message,
					retryable: parsedResponse.data.retryable,
				});
				return;
			}
			setState({
				kind: "success",
				response: parsedResponse.data,
				accepted: false,
			});
		} catch {
			setState({
				kind: "error",
				message: t("Agent Lab 请求失败，请确认 Web 服务仍在运行"),
				retryable: true,
			});
		}
	}

	/**
	 * 第一版体验流程尚不写数据库，因此“验收”只改变当前页面中的体验状态。
	 * 后续接入 feature 11 时，这个动作会由正式验收 API 替换，报告展示组件无需重写。
	 */
	function handleAccept() {
		setState((current) =>
			current.kind === "success"
				? { ...current, accepted: true }
				: current,
		);
	}

	function handleRevise() {
		setState({ kind: "idle" });
	}

	return (
		<div className="space-y-6">
			<FlowProgress state={state} />
			<div className="grid gap-6 xl:grid-cols-[minmax(340px,430px)_minmax(0,1fr)]">
			<form
				className="h-fit space-y-5 rounded-xl border bg-card p-6"
				onSubmit={handleSubmit}
			>
				<div className="flex items-start gap-3">
					<div className="rounded-lg bg-primary/10 p-2 text-primary">
						<FileCheck2 className="size-5" aria-hidden />
					</div>
					<div>
						<h2 className="font-semibold text-lg">{t("1. 填写研究任务")}</h2>
						<p className="text-muted-foreground text-sm">
							{t("提交内容会真实发送给 Agent，不是预设结果")}
						</p>
					</div>
				</div>

				<Field label={t("研究主题")} htmlFor="topic">
					<Input
						id="topic"
						value={form.topic}
						onChange={(event) => updateField("topic", event.target.value)}
					/>
				</Field>
				<Field label={t("研究问题")} htmlFor="researchQuestion">
					<Textarea
						id="researchQuestion"
						className="min-h-28"
						value={form.researchQuestion}
						onChange={(event) =>
							updateField("researchQuestion", event.target.value)
						}
					/>
				</Field>

				<div className="grid grid-cols-2 gap-4">
					<Field label={t("报告语言")} htmlFor="language">
						<SelectField
							id="language"
							className="h-9 rounded-md"
							value={form.language}
							onValueChange={(value) =>
								updateField("language", value === "en" ? "en" : "zh-CN")
							}
							options={[
								{ value: "zh-CN", label: t("简体中文") },
								{ value: "en", label: "English" },
							]}
						/>
					</Field>
					<Field label={t("目标字数")} htmlFor="targetWords">
						<Input
							id="targetWords"
							type="number"
							min={500}
							max={2000}
							step={100}
							value={form.targetWords}
							onChange={(event) =>
								updateField("targetWords", event.target.value)
							}
						/>
					</Field>
					<Field label={t("来源数量")} htmlFor="sourceCount">
						<Input
							id="sourceCount"
							type="number"
							min={3}
							max={8}
							value={form.sourceCount}
							onChange={(event) =>
								updateField("sourceCount", event.target.value)
							}
						/>
					</Field>
					<Field label={t("年份范围")} htmlFor="yearFrom">
						<div className="flex items-center gap-2">
							<Input
								id="yearFrom"
								type="number"
								aria-label={t("起始年份")}
								value={form.yearFrom}
								onChange={(event) =>
									updateField("yearFrom", event.target.value)
								}
							/>
							<span className="text-muted-foreground">—</span>
							<Input
								type="number"
								aria-label={t("结束年份")}
								value={form.yearTo}
								onChange={(event) => updateField("yearTo", event.target.value)}
							/>
						</div>
					</Field>
				</div>

				<fieldset className="space-y-3 border-t pt-5">
					<legend className="font-semibold text-base">{t("2. 选择执行 Agent")}</legend>
					<label className="flex cursor-pointer items-start gap-3 rounded-lg border border-primary bg-primary/5 p-4">
						<input
							type="radio"
							name="selectedAgent"
							value="evidence-research-agent"
							checked
							readOnly
							className="mt-1"
						/>
						<span className="min-w-0 flex-1">
							<span className="flex flex-wrap items-center gap-2 font-medium">
								{t("论文检索与综述 Agent")}
								<span className="rounded-full bg-success/10 px-2 py-0.5 text-success text-xs">
									{t("真实可调用")}
								</span>
							</span>
							<span className="mt-1 block text-muted-foreground text-sm">
								{t("Mastra + DeepSeek · OpenAlex 真实论文检索 · 引用校验")}
							</span>
						</span>
						<Bot className="size-5 shrink-0 text-primary" aria-hidden />
					</label>
					<p className="text-muted-foreground text-xs">
						{t("当前只展示已真实接入并验收过的 Agent；后续 Agent 会在这里成为候选项。")}
					</p>
				</fieldset>

				<Button
					type="submit"
					className="w-full"
					size="lg"
					disabled={state.kind === "submitting"}
				>
					{state.kind === "submitting" ? (
						<>
							<Loader2 className="size-4 animate-spin" aria-hidden />
							{t("模型正在检索和写作…")}
						</>
					) : (
						<>
							<PlayCircle className="size-4" aria-hidden />
							{t("派发任务并开始执行")}
						</>
					)}
				</Button>
				<p className="text-muted-foreground text-xs">
					{t("Ollama 通常需要数分钟；DeepSeek 通常更快。生成期间请保持 Agent 服务运行。")}
				</p>
				{state.kind === "error" && (
					<p
						className="flex items-start gap-2 text-destructive text-sm"
						role="alert"
					>
						<AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
						{state.message}
						{state.retryable ? t("（可以重试）") : ""}
					</p>
				)}
			</form>

			<ResultPanel
				state={state}
				onAccept={handleAccept}
				onRevise={handleRevise}
			/>
			</div>
		</div>
	);
}

function FlowProgress({ state }: { state: ViewState }) {
	const { t } = useLocale();
	const activeIndex =
		state.kind === "submitting"
			? 2
			: state.kind === "success"
				? state.accepted
					? 4
					: 3
				: 0;

	return (
		<ol
			className="grid gap-2 rounded-xl border bg-card p-4 sm:grid-cols-5"
			aria-label={t("任务体验进度")}
		>
			{FLOW_STEPS.map((step, index) => {
				const completed = index < activeIndex;
				const active = index === activeIndex;
				return (
					<li
						key={step}
						className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
							active
								? "bg-primary/10 font-medium text-primary"
								: "text-muted-foreground"
						}`}
						aria-current={active ? "step" : undefined}
					>
						{completed ? (
							<CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
						) : (
							<Circle className="size-4 shrink-0" aria-hidden />
						)}
						{t(step)}
					</li>
				);
			})}
		</ol>
	);
}

function ResultPanel({
	state,
	onAccept,
	onRevise,
}: {
	state: ViewState;
	onAccept: () => void;
	onRevise: () => void;
}) {
	const { locale, t } = useLocale();
	if (state.kind === "idle") {
		return (
			<section className="grid min-h-96 place-items-center rounded-xl border border-dashed p-8 text-center">
				<div className="max-w-sm">
					<BookOpen
						className="mx-auto mb-4 size-10 text-muted-foreground"
						aria-hidden
					/>
					<h2 className="font-semibold text-lg">{t("调研报告将在这里出现")}</h2>
					<p className="mt-2 text-muted-foreground text-sm">
						{t("Agent 会先从 OpenAlex 检索真实论文，再生成带来源编号和局限性说明的报告。")}
					</p>
				</div>
			</section>
		);
	}
	if (state.kind === "submitting") {
		return (
			<section
				className="grid min-h-96 place-items-center rounded-xl border p-8 text-center"
				aria-live="polite"
			>
				<div>
					<Loader2
						className="mx-auto mb-4 size-10 animate-spin text-primary"
						aria-hidden
					/>
					<h2 className="font-semibold text-lg">{t("Agent 正在工作")}</h2>
					<p className="mt-2 text-muted-foreground text-sm">
						{t("正在检索论文、调用配置的模型并校验引用，请不要关闭页面。")}
					</p>
				</div>
			</section>
		);
	}
	if (state.kind === "error") {
		return (
			<section className="grid min-h-96 place-items-center rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center">
				<div>
					<AlertCircle
						className="mx-auto mb-4 size-10 text-destructive"
						aria-hidden
					/>
					<h2 className="font-semibold text-lg">{t("这次任务没有完成")}</h2>
					<p className="mt-2 max-w-md text-muted-foreground text-sm">
						{state.message}
					</p>
				</div>
			</section>
		);
	}

	const { response } = state;
	return (
		<article
			className="space-y-6 rounded-xl border bg-card p-6"
			aria-live="polite"
		>
			<div className="flex flex-wrap items-center gap-3 border-b pb-5">
				<span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-3 py-1 text-success text-xs">
					<CheckCircle2 className="size-3.5" aria-hidden />
					{t("测试任务完成")}
				</span>
				<span className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
					<Clock3 className="size-3.5" aria-hidden />
					{formatElapsed(response.elapsedMs, locale)}
				</span>
				<span className="font-mono text-muted-foreground text-xs">
					{response.result.taskId}
				</span>
			</div>

			<header>
				<h1 className="font-bold text-2xl tracking-tight">
					{response.result.title}
				</h1>
				<p className="mt-3 whitespace-pre-wrap text-foreground/80 leading-7">
					{response.result.executiveSummary}
				</p>
			</header>

			{response.result.sections.map((section) => (
				<section key={`${section.heading}-${section.citationIds.join("-")}`}>
					<h2 className="font-semibold text-xl">{section.heading}</h2>
					<p className="mt-2 whitespace-pre-wrap leading-7">
						{section.content}
					</p>
					{section.citationIds.length > 0 && (
						<p className="mt-2 font-mono text-muted-foreground text-xs">
							{t("引用：")}{section.citationIds.join(" · ")}
						</p>
					)}
				</section>
			))}

			<section>
				<h2 className="font-semibold text-xl">{t("来源")}</h2>
				<ol className="mt-3 space-y-3">
					{response.result.sources.map((source) => (
						<li className="rounded-lg border p-4" key={source.id}>
							<a
								className="font-medium hover:underline"
								href={source.url}
								target="_blank"
								rel="noreferrer"
							>
								{source.title}{" "}
								<ExternalLink className="inline size-3.5" aria-hidden />
							</a>
							<p className="mt-1 text-muted-foreground text-sm">
								{source.authors.join(", ") || t("作者信息缺失")}
								{source.publicationYear === null
									? ""
									: ` · ${source.publicationYear}`}
							</p>
							<p className="mt-1 break-all font-mono text-muted-foreground text-xs">
								{source.id}
							</p>
						</li>
					))}
				</ol>
			</section>

			<section className="rounded-lg bg-muted p-4">
				<h2 className="font-semibold">{t("局限性")}</h2>
				{response.result.limitations.length === 0 ? (
					<p className="mt-2 text-muted-foreground text-sm">
						{t("模型未额外列出局限性。")}
					</p>
				) : (
					<ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
						{response.result.limitations.map((limitation) => (
							<li key={limitation}>{limitation}</li>
						))}
					</ul>
				)}
			</section>

			{state.accepted ? (
				<section
					className="rounded-lg border border-success/30 bg-success/10 p-5"
					aria-live="polite"
				>
					<div className="flex items-start gap-3">
						<CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
						<div>
							<h2 className="font-semibold">{t("验收完成，Agent 测试流程已跑通")}</h2>
							<p className="mt-1 text-muted-foreground text-sm">
								{t("本次测试记录用于 Agent 能力评估；任务交付、验收与结算在任务工作台中完成。")}
							</p>
						</div>
					</div>
				</section>
			) : (
				<section className="rounded-lg border border-primary/30 bg-primary/5 p-5">
					<h2 className="font-semibold">{t("5. 验收这份交付物")}</h2>
					<p className="mt-1 text-muted-foreground text-sm">
						{t("确认报告满足任务要求，或者修改任务后重新派发。")}
					</p>
					<div className="mt-4 flex flex-wrap gap-3">
						<Button type="button" onClick={onAccept}>
							<CheckCircle2 className="size-4" aria-hidden />
							{t("验收并完成体验")}
						</Button>
						<Button type="button" variant="outline" onClick={onRevise}>
							<RotateCcw className="size-4" aria-hidden />
							{t("修改任务后重新执行")}
						</Button>
					</div>
				</section>
			)}
		</article>
	);
}

function Field({
	label,
	htmlFor,
	children,
}: {
	label: string;
	htmlFor: string;
	children: React.ReactNode;
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor={htmlFor}>{label}</Label>
			{children}
		</div>
	);
}

function formatElapsed(milliseconds: number, locale: "en" | "zh-CN"): string {
	const seconds = Math.round(milliseconds / 1_000);
	if (locale === "en") return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
