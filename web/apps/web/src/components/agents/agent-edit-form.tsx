"use client";

import { Button } from "@web/ui/components/button";
import { Input } from "@web/ui/components/input";
import { Label } from "@web/ui/components/label";
import { Textarea } from "@web/ui/components/textarea";
import { AlertCircle, CheckCircle2, Loader2, X } from "lucide-react";
import { useState } from "react";
import { useLocale } from "@/components/i18n/locale-provider";
import {
	type AgentEditFormErrors,
	type AgentEditFormValues,
	hasFormErrors,
	validateAgentEditForm,
} from "@/lib/api/agent-validation";
import type { Agent, AgentPatchInput } from "@/lib/api/agents";
import { AgentApiRequestError, patchAgent } from "@/lib/api/agents";

interface AgentEditFormProps {
	agent: Agent;
	onSaved: (agent: Agent) => void;
}

function toFormValues(agent: Agent): AgentEditFormValues {
	return {
		name: agent.name,
		categoryId: agent.categoryId,
		capabilityDesc: agent.capabilityDesc,
		tags: agent.tags,
		pricingType: agent.pricingType,
		priceAmount: agent.priceAmount,
		priceCurrency: agent.priceCurrency,
		serviceEndpoint: agent.serviceEndpoint,
		email: agent.email,
	};
}

/** 只提交实际变化的字段，确保服务端审计摘要不会把未变化字段误记为变更。 */
function toPatchInput(
	original: Agent,
	values: AgentEditFormValues,
): AgentPatchInput {
	const baseline = toFormValues(original);
	const patch: AgentPatchInput = {};
	for (const key of Object.keys(values) as (keyof AgentEditFormValues)[]) {
		if (JSON.stringify(values[key]) !== JSON.stringify(baseline[key])) {
			(patch as Record<string, unknown>)[key] = values[key];
		}
	}
	return patch;
}

type SubmitStatus = "idle" | "submitting" | "success" | "error";

/**
 * Agent 配置编辑表单（T-007）。钱包地址字段只读展示，不出现在提交的补丁里——
 * 后端 `PATCH /api/agents/:id` 对该字段的存在性本身就会拒绝整个请求
 * （AC-004，见 patch-agent.ts `rejectWalletAddressField`），前端在此处不重复实现
 * 这条判断逻辑，只是从不把它放进请求体，避免同一条规则出现第二个权威来源。
 */
export default function AgentEditForm({ agent, onSaved }: AgentEditFormProps) {
	const { t } = useLocale();
	const [values, setValues] = useState<AgentEditFormValues>(() =>
		toFormValues(agent),
	);
	const [tagsInput, setTagsInput] = useState(agent.tags.join(", "));
	const [errors, setErrors] = useState<AgentEditFormErrors>({});
	const [status, setStatus] = useState<SubmitStatus>("idle");
	const [submitError, setSubmitError] = useState<string | null>(null);

	function updateField<K extends keyof AgentEditFormValues>(
		field: K,
		value: AgentEditFormValues[K],
	) {
		setValues((prev) => ({ ...prev, [field]: value }));
		// 修改字段后清除该字段的旧错误与整体提交状态，避免"已保存"提示或上一次的
		// 失败错误在用户继续编辑后仍然显示（codex review T-007 P2 修复）。
		setErrors((prev) => {
			if (!(field in prev)) return prev;
			const next = { ...prev };
			delete next[field];
			return next;
		});
		setStatus("idle");
		setSubmitError(null);
	}

	function handleTagsChange(raw: string) {
		setTagsInput(raw);
		const tags = raw
			.split(",")
			.map((tag) => tag.trim())
			.filter((tag) => tag.length > 0);
		updateField("tags", tags);
	}

	async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();

		const nextErrors = validateAgentEditForm(values);
		setErrors(nextErrors);
		if (hasFormErrors(nextErrors)) {
			return;
		}

		setStatus("submitting");
		setSubmitError(null);
		try {
			const patch = toPatchInput(agent, values);
			if (Object.keys(patch).length === 0) {
				setStatus("success");
				return;
			}
			const updated = await patchAgent(agent.id, patch);
			setStatus("success");
			onSaved(updated);
		} catch (err) {
			setStatus("error");
			if (err instanceof AgentApiRequestError) {
				setSubmitError(err.body.message);
				if (err.body.fields) {
					setErrors((prev) => ({ ...prev, ...err.body.fields }));
				}
			} else {
				setSubmitError(t("保存失败，请稍后重试"));
			}
		}
	}

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-6" noValidate>
			<section className="rounded-lg border border-border bg-card p-6">
				<h2 className="mb-1 font-semibold text-foreground text-lg">{t("基本信息")}</h2>
				<p className="mb-4 text-muted-foreground text-sm">
					{t("钱包地址一经创建不可通过本页面修改，如需更换请前往钱包换绑流程。")}
				</p>

				<div className="grid gap-4 md:grid-cols-2">
					<Field label={t("钱包地址")} htmlFor="wallet-address">
						<Input
							id="wallet-address"
							value={agent.providerWalletAddress}
							disabled
							readOnly
							className="font-mono"
						/>
					</Field>

					<Field label={t("名称")} htmlFor="name" error={errors.name}>
						<Input
							id="name"
							value={values.name}
							onChange={(event) => updateField("name", event.target.value)}
							aria-invalid={Boolean(errors.name)}
						/>
					</Field>

					<Field label={t("分类 ID")} htmlFor="categoryId" error={errors.categoryId}>
						<Input
							id="categoryId"
							value={values.categoryId}
							onChange={(event) =>
								updateField("categoryId", event.target.value)
							}
							aria-invalid={Boolean(errors.categoryId)}
						/>
					</Field>

					<Field label={t("邮箱")} htmlFor="email" error={errors.email}>
						<Input
							id="email"
							type="email"
							value={values.email}
							onChange={(event) => updateField("email", event.target.value)}
							aria-invalid={Boolean(errors.email)}
						/>
					</Field>

					<Field
						label={t("服务地址")}
						htmlFor="serviceEndpoint"
						error={errors.serviceEndpoint}
					>
						<Input
							id="serviceEndpoint"
							value={values.serviceEndpoint}
							onChange={(event) =>
								updateField("serviceEndpoint", event.target.value)
							}
							aria-invalid={Boolean(errors.serviceEndpoint)}
							placeholder="https://"
						/>
					</Field>

					<Field
						label={t("计价方式")}
						htmlFor="pricingType"
						error={errors.pricingType}
					>
						<Input
							id="pricingType"
							value={values.pricingType}
							onChange={(event) =>
								updateField("pricingType", event.target.value)
							}
							aria-invalid={Boolean(errors.pricingType)}
						/>
					</Field>

					<Field
						label={t("报价（最小单位整数）")}
						htmlFor="priceAmount"
						error={errors.priceAmount}
					>
						<Input
							id="priceAmount"
							inputMode="numeric"
							value={values.priceAmount}
							onChange={(event) =>
								updateField("priceAmount", event.target.value)
							}
							aria-invalid={Boolean(errors.priceAmount)}
							className="font-mono"
						/>
					</Field>

					<Field
						label={t("币种")}
						htmlFor="priceCurrency"
						error={errors.priceCurrency}
					>
						<Input
							id="priceCurrency"
							value={values.priceCurrency}
							onChange={(event) =>
								updateField("priceCurrency", event.target.value)
							}
							aria-invalid={Boolean(errors.priceCurrency)}
						/>
					</Field>
				</div>

				<div className="mt-4">
					<Field
						label={t("能力描述")}
						htmlFor="capabilityDesc"
						error={errors.capabilityDesc}
					>
						<Textarea
							id="capabilityDesc"
							className="min-h-24 rounded-lg"
							value={values.capabilityDesc}
							onChange={(event) =>
								updateField("capabilityDesc", event.target.value)
							}
							aria-invalid={Boolean(errors.capabilityDesc)}
						/>
					</Field>
				</div>

				<div className="mt-4">
					<Field label={t("标签（逗号分隔）")} htmlFor="tags" error={errors.tags}>
						<Input
							id="tags"
							value={tagsInput}
							onChange={(event) => handleTagsChange(event.target.value)}
						/>
					</Field>
				</div>
			</section>

			<div className="flex items-center gap-3">
				<Button type="submit" size="lg" disabled={status === "submitting"}>
					{status === "submitting" ? (
						<>
							<Loader2 className="size-4 animate-spin" aria-hidden />
							{t("保存中…")}
						</>
					) : (
						t("保存修改")
					)}
				</Button>

				{status === "success" && (
					<span
						className="flex items-center gap-1.5 text-sm text-success"
						role="status"
					>
						<CheckCircle2 className="size-4" strokeWidth={1.5} aria-hidden />
						{t("已保存")}
					</span>
				)}
			</div>

			{status === "error" && submitError && (
				<p
					className="flex items-center gap-1.5 text-destructive text-sm"
					role="alert"
				>
					<AlertCircle className="size-4" strokeWidth={1.5} aria-hidden />
					{submitError}
				</p>
			)}
		</form>
	);
}

interface FieldProps {
	label: string;
	htmlFor: string;
	error?: string;
	children: React.ReactNode;
}

function Field({ label, htmlFor, error, children }: FieldProps) {
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={htmlFor}>{label}</Label>
			{children}
			{error && (
				<p
					className="flex items-center gap-1 text-destructive text-xs"
					role="alert"
				>
					<X className="size-3" strokeWidth={1.5} aria-hidden />
					{error}
				</p>
			)}
		</div>
	);
}
