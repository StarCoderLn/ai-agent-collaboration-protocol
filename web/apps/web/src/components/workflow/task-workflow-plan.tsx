"use client";

import { Button } from "@web/ui/components/button";
import { Skeleton } from "@web/ui/components/skeleton";
import { AlertCircle, ArrowLeft, Waypoints } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useLocale } from "@/components/i18n/locale-provider";
import {
	getTaskPreview,
	type TaskPreview,
	TaskApiRequestError,
} from "@/lib/api/tasks";
import ProductWorkflowExperience from "./product-workflow-experience";

type PlanState =
	| Readonly<{ kind: "loading" }>
	| Readonly<{ kind: "loaded"; preview: TaskPreview }>
	| Readonly<{ kind: "error"; message: string }>;

export default function TaskWorkflowPlan({ taskId }: { taskId: string }) {
	const { t } = useLocale();
	const [state, setState] = useState<PlanState>({ kind: "loading" });

	useEffect(() => {
		const controller = new AbortController();
		getTaskPreview(taskId, controller.signal)
			.then((preview) => setState({ kind: "loaded", preview }))
			.catch((error: unknown) => {
				if (error instanceof DOMException && error.name === "AbortError") return;
				setState({
					kind: "error",
					message:
						error instanceof TaskApiRequestError
							? error.body.message
							: t("执行方案暂时无法加载，请返回任务详情后重试。"),
				});
			});
		return () => controller.abort();
	}, [t, taskId]);

	if (state.kind === "loading") return <PlanLoading taskId={taskId} />;
	if (state.kind === "error") return <PlanError taskId={taskId} message={state.message} />;

	return (
		<main className="workflow-plan-shell min-h-[calc(100vh-68px)] overflow-hidden">
			<section className="workflow-plan-hero border-b border-primary/15">
				<div className="relative mx-auto max-w-[1760px] px-4 py-6 sm:px-6 lg:px-8">
					<div className="flex flex-wrap items-end justify-between gap-5">
						<div className="min-w-0 max-w-4xl">
							<Link href={`/tasks/${taskId}`} className="inline-flex items-center gap-1.5 text-muted-foreground text-xs hover:text-foreground">
								<ArrowLeft className="size-3.5" />{t("返回任务详情")}
							</Link>
							<p className="cyber-kicker mt-4 flex items-center gap-2 font-semibold text-secondary text-[11px]">
								<Waypoints className="size-3.5" />MISSION GRAPH · TASK-BOUND EXECUTION
							</p>
							<h1 className="mt-2 truncate font-bold text-3xl tracking-tight sm:text-4xl">
								{state.preview.summary.title || t("未命名任务")}
							</h1>
							<p className="mt-2 max-w-3xl text-muted-foreground text-sm">
								{t("平台根据任务合同组织三个可执行阶段；每一步从三个真实 Agent 中选择一个，验收后的结构化制品才会流向下游。")}
							</p>
						</div>
						<div className="grid grid-cols-3 gap-2 text-center text-xs">
							<HeroMetric value="03" label={t("执行阶段")} />
							<HeroMetric value="09" label={t("候选 Agent")} />
							<HeroMetric value="01" label={t("可信路径")} tone="secondary" />
						</div>
					</div>
				</div>
			</section>
			<div className="mx-auto max-w-[1760px] px-3 py-4 sm:px-5 lg:px-6">
				<ProductWorkflowExperience taskId={taskId} initialRequest={workflowRequest(state.preview)} />
			</div>
		</main>
	);
}

function HeroMetric({ value, label, tone = "primary" }: { value: string; label: string; tone?: "primary" | "secondary" }) {
	return <div className={`min-w-24 rounded-xl border px-3 py-2.5 backdrop-blur-xl ${tone === "secondary" ? "border-secondary/25 bg-secondary-container/35" : "border-primary/25 bg-primary-container/35"}`}><p className="font-mono font-bold text-lg">{value}</p><p className="text-muted-foreground text-[10px]">{label}</p></div>;
}

function PlanLoading({ taskId }: { taskId: string }) {
	const { t } = useLocale();
	return <main className="workflow-plan-shell min-h-[calc(100vh-68px)] px-4 py-8"><div className="mx-auto max-w-[1760px]"><Link href={`/tasks/${taskId}`} className="inline-flex items-center gap-1.5 text-muted-foreground text-sm"><ArrowLeft className="size-4" />{t("返回任务详情")}</Link><div className="mt-8 grid gap-4 lg:grid-cols-[190px_minmax(0,1fr)]"><Skeleton className="h-[680px] rounded-2xl" /><Skeleton className="h-[680px] rounded-2xl" /></div></div></main>;
}

function PlanError({ taskId, message }: { taskId: string; message: string }) {
	const { t } = useLocale();
	return <main className="workflow-plan-shell flex min-h-[calc(100vh-68px)] items-center justify-center px-4"><section className="cyber-panel max-w-lg rounded-2xl border p-8 text-center"><span className="mx-auto flex size-12 items-center justify-center rounded-xl bg-destructive/10 text-destructive"><AlertCircle className="size-6" /></span><h1 className="mt-4 font-semibold text-xl">{t("无法打开执行方案")}</h1><p className="mt-2 text-muted-foreground text-sm leading-6">{message}</p><Button className="mt-6 rounded-full" render={<Link href={`/tasks/${taskId}`} />}><ArrowLeft className="size-4" />{t("返回任务详情")}</Button></section></main>;
}

function workflowRequest(preview: TaskPreview): string {
	const summary = preview.summary;
	return [
		`任务：${summary.title}`,
		`详细需求：${summary.description}`,
		`验收标准：${summary.acceptanceCriteria}`,
		`交付格式：${summary.deliverableFormat}`,
		`所需能力：${summary.requiredCapability}`,
		summary.tags.length > 0 ? `能力标签：${summary.tags.join("、")}` : "",
	]
		.filter(Boolean)
		.join("\n");
}
