"use client";

import { Skeleton } from "@web/ui/components/skeleton";
import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import AgentEditForm from "@/components/agents/agent-edit-form";
import CredentialReplacePanel from "@/components/agents/credential-replace-panel";
import type { Agent } from "@/lib/api/agents";
import { AgentApiRequestError, fetchAgent } from "@/lib/api/agents";

interface AgentConfigEditViewProps {
	agentId: string;
}

type LoadState =
	| { kind: "loading" }
	| { kind: "loaded"; agent: Agent }
	| { kind: "not-found" }
	| { kind: "error"; message: string };

/**
 * T-007 页面编排：加载态 / 空态（档案不存在）/ 错误态（可重试）/ 正常态四种状态
 * 均显式建模（docs/DESIGN.md「Loading and empty states」），不用单一 loading
 * 布尔值笼统表示，避免「加载失败」被误显示为「加载中」。
 */
export default function AgentConfigEditView({
	agentId,
}: AgentConfigEditViewProps) {
	const [state, setState] = useState<LoadState>({ kind: "loading" });

	const load = useCallback(() => {
		setState({ kind: "loading" });
		fetchAgent(agentId)
			.then((agent) => setState({ kind: "loaded", agent }))
			.catch((err: unknown) => {
				if (err instanceof AgentApiRequestError && err.status === 404) {
					setState({ kind: "not-found" });
					return;
				}
				const message =
					err instanceof AgentApiRequestError
						? err.body.message
						: "加载失败，请重试";
				setState({ kind: "error", message });
			});
	}, [agentId]);

	useEffect(() => {
		load();
	}, [load]);

	if (state.kind === "loading") {
		return (
			<div className="flex flex-col gap-6">
				<Skeleton className="h-8 w-48 rounded-sm" />
				<Skeleton className="h-72 w-full rounded-lg" />
				<Skeleton className="h-40 w-full rounded-lg" />
			</div>
		);
	}

	if (state.kind === "not-found") {
		return (
			<EmptyState
				title="未找到该 Agent 档案"
				description="档案可能已被删除，或链接中的 ID 不正确，请返回列表重新进入。"
			/>
		);
	}

	if (state.kind === "error") {
		return (
			<EmptyState
				title="加载失败"
				description={state.message}
				action={{ label: "重试", onClick: load }}
				tone="error"
			/>
		);
	}

	return (
		<div className="flex flex-col gap-6">
			<header>
				<h1 className="font-bold text-2xl text-foreground">编辑 Agent 配置</h1>
				<p className="text-muted-foreground text-sm">{state.agent.name}</p>
			</header>
			<AgentEditForm
				agent={state.agent}
				onSaved={(agent) => setState({ kind: "loaded", agent })}
			/>
			<CredentialReplacePanel agentId={state.agent.id} />
		</div>
	);
}

interface EmptyStateProps {
	title: string;
	description: string;
	tone?: "neutral" | "error";
	action?: { label: string; onClick: () => void };
}

function EmptyState({
	title,
	description,
	tone = "neutral",
	action,
}: EmptyStateProps) {
	return (
		<div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-card p-12 text-center">
			<AlertTriangle
				className={
					tone === "error"
						? "size-8 text-destructive"
						: "size-8 text-muted-foreground"
				}
				strokeWidth={1.5}
				aria-hidden
			/>
			<h2 className="font-semibold text-foreground text-lg">{title}</h2>
			<p className="max-w-md text-muted-foreground text-sm">{description}</p>
			{action && (
				<button
					type="button"
					onClick={action.onClick}
					className="mt-2 h-11 rounded-sm border border-primary px-4 font-medium text-primary text-sm transition-colors hover:bg-primary-container"
				>
					{action.label}
				</button>
			)}
		</div>
	);
}
