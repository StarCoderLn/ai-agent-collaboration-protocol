"use client";

import { Button } from "@web/ui/components/button";
import { Input } from "@web/ui/components/input";
import { Label } from "@web/ui/components/label";
import { CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { useLocale } from "@/components/i18n/locale-provider";
import {
	AgentApiRequestError,
	replaceAgentCredentials,
} from "@/lib/api/agents";

interface CredentialReplacePanelProps {
	agentId: string;
}

type SubmitState =
	| { kind: "idle" }
	| { kind: "submitting" }
	| { kind: "success"; keyVersion: number }
	| { kind: "error"; message: string };

/**
 * 凭证替换入口（T-007）。
 *
 * 安全不变量：明文凭证只允许在本组件的受控输入框中短暂停留，一旦用户点击提交，
 * 立即清空本地状态（`setSecret("")`）——不等待网络响应，避免请求失败时明文残留在
 * React state 里（design.md 模块 4：「提交后立即清空本地状态，不缓存明文到前端 store」）。
 * 提交失败时用户需要重新输入，这是刻意的取舍：明文不可恢复的安全属性优先于
 * 失败重试的输入体验。
 */
export default function CredentialReplacePanel({
	agentId,
}: CredentialReplacePanelProps) {
	const { t } = useLocale();
	const inputId = useId();
	const [secret, setSecret] = useState("");
	const [state, setState] = useState<SubmitState>({ kind: "idle" });

	const isSubmitting = state.kind === "submitting";
	const canSubmit = secret.trim().length > 0 && !isSubmitting;

	async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!canSubmit) {
			return;
		}

		const plaintext = secret;
		// 先清空，再发起请求：明文不因网络等待而延长存活时间。
		setSecret("");
		setState({ kind: "submitting" });

		try {
			const result = await replaceAgentCredentials(agentId, plaintext);
			setState({ kind: "success", keyVersion: result.keyVersion });
		} catch (err) {
			const message =
				err instanceof AgentApiRequestError
					? err.body.message
					: t("凭证替换失败，请稍后重试");
			setState({ kind: "error", message });
		}
	}

	return (
		<section
			className="rounded-lg border border-border bg-card p-6"
			aria-labelledby={`${inputId}-heading`}
		>
			<div className="mb-4 flex items-center gap-2">
				<KeyRound
					className="size-5 text-primary"
					strokeWidth={1.5}
					aria-hidden
				/>
				<h2
					id={`${inputId}-heading`}
					className="font-semibold text-foreground text-lg"
				>
					{t("调用凭证")}
				</h2>
			</div>
			<p className="mb-4 text-muted-foreground text-sm">
				{t("凭证保存后无法再次以明文查看，仅支持整体替换。替换后旧凭证立即失效。")}
			</p>

			<form onSubmit={handleSubmit} className="flex flex-col gap-3">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={inputId}>{t("新认证配置")}</Label>
					<Input
						id={inputId}
						type="password"
						autoComplete="off"
						placeholder={t("输入新的凭证明文")}
						value={secret}
						onChange={(event) => setSecret(event.target.value)}
						disabled={isSubmitting}
						aria-invalid={state.kind === "error"}
					/>
				</div>

				<div className="flex items-center gap-3">
					<Button type="submit" size="lg" disabled={!canSubmit}>
						{isSubmitting ? (
							<>
								<Loader2 className="size-4 animate-spin" aria-hidden />
								{t("替换中…")}
							</>
						) : (
							t("替换凭证")
						)}
					</Button>

					{state.kind === "success" && (
						<span
							className="flex items-center gap-1.5 text-sm text-success"
							role="status"
						>
							<CheckCircle2 className="size-4" strokeWidth={1.5} aria-hidden />
							{t("已替换（key_version {version}）", { version: state.keyVersion })}
						</span>
					)}
				</div>

				{state.kind === "error" && (
					<p className="text-destructive text-sm" role="alert">
						{state.message}
					</p>
				)}
			</form>
		</section>
	);
}
