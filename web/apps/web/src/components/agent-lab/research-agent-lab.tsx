"use client";

import { Button } from "@web/ui/components/button";
import { Input } from "@web/ui/components/input";
import { Label } from "@web/ui/components/label";
import { Textarea } from "@web/ui/components/textarea";
import {
	AlertCircle,
	BookOpen,
	CheckCircle2,
	Clock3,
	ExternalLink,
	FlaskConical,
	Loader2,
} from "lucide-react";
import { useState } from "react";
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

const INITIAL_FORM: FormState = {
	topic: "AI Agent 协作协议的可靠性",
	researchQuestion:
		"现有研究中，哪些认证、幂等和失败恢复机制适合独立部署的 AI Agent？",
	language: "zh-CN",
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
	  }
	| { kind: "error"; message: string; retryable: boolean };

export default function ResearchAgentLab() {
	const [form, setForm] = useState<FormState>(INITIAL_FORM);
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
				message: parsed.error.issues[0]?.message ?? "请检查输入内容",
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
				throw new Error("Agent Lab 返回了无法识别的数据");
			}
			if (!parsedResponse.data.success) {
				setState({
					kind: "error",
					message: parsedResponse.data.message,
					retryable: parsedResponse.data.retryable,
				});
				return;
			}
			setState({ kind: "success", response: parsedResponse.data });
		} catch {
			setState({
				kind: "error",
				message: "Agent Lab 请求失败，请确认 Web 服务仍在运行",
				retryable: true,
			});
		}
	}

	return (
		<div className="grid gap-6 xl:grid-cols-[minmax(320px,420px)_minmax(0,1fr)]">
			<form
				className="h-fit space-y-5 rounded-xl border bg-card p-6"
				onSubmit={handleSubmit}
			>
				<div className="flex items-start gap-3">
					<div className="rounded-lg bg-primary/10 p-2 text-primary">
						<FlaskConical className="size-5" aria-hidden />
					</div>
					<div>
						<h2 className="font-semibold text-lg">研究任务</h2>
						<p className="text-muted-foreground text-sm">
							沙箱调用 · 模型密钥仅保存在 Agent 服务端
						</p>
					</div>
				</div>

				<Field label="研究主题" htmlFor="topic">
					<Input
						id="topic"
						value={form.topic}
						onChange={(event) => updateField("topic", event.target.value)}
					/>
				</Field>
				<Field label="研究问题" htmlFor="researchQuestion">
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
					<Field label="报告语言" htmlFor="language">
						<select
							id="language"
							className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
							value={form.language}
							onChange={(event) =>
								updateField(
									"language",
									event.target.value === "en" ? "en" : "zh-CN",
								)
							}
						>
							<option value="zh-CN">简体中文</option>
							<option value="en">English</option>
						</select>
					</Field>
					<Field label="目标字数" htmlFor="targetWords">
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
					<Field label="来源数量" htmlFor="sourceCount">
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
					<Field label="年份范围" htmlFor="yearFrom">
						<div className="flex items-center gap-2">
							<Input
								id="yearFrom"
								type="number"
								aria-label="起始年份"
								value={form.yearFrom}
								onChange={(event) =>
									updateField("yearFrom", event.target.value)
								}
							/>
							<span className="text-muted-foreground">—</span>
							<Input
								type="number"
								aria-label="结束年份"
								value={form.yearTo}
								onChange={(event) => updateField("yearTo", event.target.value)}
							/>
						</div>
					</Field>
				</div>

				<Button
					type="submit"
					className="w-full"
					size="lg"
					disabled={state.kind === "submitting"}
				>
					{state.kind === "submitting" ? (
						<>
							<Loader2 className="size-4 animate-spin" aria-hidden />
							模型正在检索和写作…
						</>
					) : (
						"开始论文调研"
					)}
				</Button>
				<p className="text-muted-foreground text-xs">
					Ollama 通常需要数分钟；DeepSeek 通常更快。生成期间请保持 Agent
					服务运行。
				</p>
				{state.kind === "error" && (
					<p
						className="flex items-start gap-2 text-destructive text-sm"
						role="alert"
					>
						<AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
						{state.message}
						{state.retryable ? "（可以重试）" : ""}
					</p>
				)}
			</form>

			<ResultPanel state={state} />
		</div>
	);
}

function ResultPanel({ state }: { state: ViewState }) {
	if (state.kind === "idle") {
		return (
			<section className="grid min-h-96 place-items-center rounded-xl border border-dashed p-8 text-center">
				<div className="max-w-sm">
					<BookOpen
						className="mx-auto mb-4 size-10 text-muted-foreground"
						aria-hidden
					/>
					<h2 className="font-semibold text-lg">调研报告将在这里出现</h2>
					<p className="mt-2 text-muted-foreground text-sm">
						Agent 会先从 OpenAlex
						检索真实论文，再生成带来源编号和局限性说明的报告。
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
					<h2 className="font-semibold text-lg">Agent 正在工作</h2>
					<p className="mt-2 text-muted-foreground text-sm">
						正在检索论文、调用配置的模型并校验引用，请不要关闭页面。
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
					<h2 className="font-semibold text-lg">这次任务没有完成</h2>
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
					沙箱任务完成
				</span>
				<span className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
					<Clock3 className="size-3.5" aria-hidden />
					{formatElapsed(response.elapsedMs)}
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
							引用：{section.citationIds.join(" · ")}
						</p>
					)}
				</section>
			))}

			<section>
				<h2 className="font-semibold text-xl">来源</h2>
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
								{source.authors.join(", ") || "作者信息缺失"}
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
				<h2 className="font-semibold">局限性</h2>
				{response.result.limitations.length === 0 ? (
					<p className="mt-2 text-muted-foreground text-sm">
						模型未额外列出局限性。
					</p>
				) : (
					<ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
						{response.result.limitations.map((limitation) => (
							<li key={limitation}>{limitation}</li>
						))}
					</ul>
				)}
			</section>
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

function formatElapsed(milliseconds: number): string {
	const seconds = Math.round(milliseconds / 1_000);
	return seconds < 60
		? `${seconds} 秒`
		: `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
