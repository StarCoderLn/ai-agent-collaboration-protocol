"use client";

import { Button } from "@web/ui/components/button";
import { Input } from "@web/ui/components/input";
import { Label } from "@web/ui/components/label";
import { Textarea } from "@web/ui/components/textarea";
import { AlertCircle, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import {
	type AgentRegistrationFieldErrors,
	type AgentRegistrationValues,
	registerAgent,
	validateAgentRegistration,
} from "@/lib/api/agent-registration";

interface FormState {
	name: string;
	categoryId: string;
	capabilityDesc: string;
	tagsInput: string;
	pricingType: string;
	priceAmount: string;
	priceCurrency: string;
	walletAddress: string;
	serviceEndpoint: string;
	credentialSecret: string;
	email: string;
}

const INITIAL_STATE: FormState = {
	name: "",
	categoryId: "",
	capabilityDesc: "",
	tagsInput: "",
	pricingType: "",
	priceAmount: "",
	priceCurrency: "USDC",
	walletAddress: "",
	serviceEndpoint: "",
	credentialSecret: "",
	email: "",
};

const SERVER_FIELD_TO_FORM_FIELD: Readonly<
	Record<string, keyof AgentRegistrationFieldErrors>
> = {
	"price.amount": "priceAmount",
	"price.currency": "priceCurrency",
};

type SubmitState =
	| { kind: "idle" }
	| { kind: "submitting" }
	| { kind: "success"; agentId: string }
	| { kind: "error"; message: string; retryable: boolean };

function parseTags(value: string): string[] {
	return value
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean);
}

function newIdempotencyKey(): string {
	return crypto.randomUUID();
}

export default function AgentRegistrationForm() {
	const [form, setForm] = useState<FormState>(INITIAL_STATE);
	const [fieldErrors, setFieldErrors] = useState<AgentRegistrationFieldErrors>(
		{},
	);
	const [state, setState] = useState<SubmitState>({ kind: "idle" });
	const idempotencyKey = useRef(newIdempotencyKey());

	function updateField<K extends keyof FormState>(
		field: K,
		value: FormState[K],
	) {
		if (state.kind === "error") {
			idempotencyKey.current = newIdempotencyKey();
			setState({ kind: "idle" });
		}
		setForm((current) => ({ ...current, [field]: value }));
	}

	async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const validation = validateAgentRegistration({
			...form,
			tags: parseTags(form.tagsInput),
		});
		if (!validation.success) {
			setFieldErrors(validation.fieldErrors);
			return;
		}

		setFieldErrors({});
		setState({ kind: "submitting" });
		const submitted = validation.data;
		updateField("credentialSecret", "");

		const result = await registerAgent(submitted, idempotencyKey.current);
		if (result.success) {
			setForm(INITIAL_STATE);
			setState({ kind: "success", agentId: result.data.agentId });
			idempotencyKey.current = newIdempotencyKey();
			return;
		}

		setState({
			kind: "error",
			message: result.error.message,
			retryable: result.error.retryable,
		});
		if (result.error.fields) {
			const mapped: AgentRegistrationFieldErrors = {};
			for (const fieldError of result.error.fields) {
				const field =
					SERVER_FIELD_TO_FORM_FIELD[fieldError.field] ?? fieldError.field;
				if (field in validation.data) {
					mapped[field as keyof AgentRegistrationValues] = fieldError.message;
				}
			}
			setFieldErrors(mapped);
		}
	}

	return (
		<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
			<form onSubmit={handleSubmit} className="flex flex-col gap-6" noValidate>
				<section className="rounded-lg border border-border bg-card p-6">
					<div className="mb-6">
						<h2 className="font-semibold text-foreground text-lg">
							Agent 档案
						</h2>
						<p className="mt-1 text-muted-foreground text-sm">
							提交后进入待审核状态，可继续维护档案与调用凭证。
						</p>
					</div>

					<div className="grid gap-4 md:grid-cols-2">
						<Field label="名称" htmlFor="name" error={fieldErrors.name}>
							<Input
								id="name"
								value={form.name}
								onChange={(e) => updateField("name", e.target.value)}
							/>
						</Field>
						<Field
							label="分类 ID"
							htmlFor="categoryId"
							error={fieldErrors.categoryId}
						>
							<Input
								id="categoryId"
								value={form.categoryId}
								onChange={(e) => updateField("categoryId", e.target.value)}
							/>
						</Field>
						<Field label="邮箱" htmlFor="email" error={fieldErrors.email}>
							<Input
								id="email"
								type="email"
								value={form.email}
								onChange={(e) => updateField("email", e.target.value)}
							/>
						</Field>
						<Field
							label="服务地址"
							htmlFor="serviceEndpoint"
							error={fieldErrors.serviceEndpoint}
						>
							<Input
								id="serviceEndpoint"
								type="url"
								placeholder="https://"
								value={form.serviceEndpoint}
								onChange={(e) => updateField("serviceEndpoint", e.target.value)}
							/>
						</Field>
						<Field
							label="计价方式"
							htmlFor="pricingType"
							error={fieldErrors.pricingType}
						>
							<Input
								id="pricingType"
								placeholder="如 per_task"
								value={form.pricingType}
								onChange={(e) => updateField("pricingType", e.target.value)}
							/>
						</Field>
						<Field
							label="报价（最小单位）"
							htmlFor="priceAmount"
							error={fieldErrors.priceAmount}
						>
							<Input
								id="priceAmount"
								inputMode="numeric"
								className="font-mono"
								value={form.priceAmount}
								onChange={(e) => updateField("priceAmount", e.target.value)}
							/>
						</Field>
						<Field
							label="币种"
							htmlFor="priceCurrency"
							error={fieldErrors.priceCurrency}
						>
							<Input
								id="priceCurrency"
								value={form.priceCurrency}
								onChange={(e) => updateField("priceCurrency", e.target.value)}
							/>
						</Field>
						<Field
							label="钱包地址"
							htmlFor="walletAddress"
							error={fieldErrors.walletAddress}
						>
							<Input
								id="walletAddress"
								className="font-mono"
								placeholder="0x..."
								value={form.walletAddress}
								onChange={(e) => updateField("walletAddress", e.target.value)}
							/>
						</Field>
					</div>

					<div className="mt-4 grid gap-4">
						<Field
							label="能力描述"
							htmlFor="capabilityDesc"
							error={fieldErrors.capabilityDesc}
						>
							<Textarea
								id="capabilityDesc"
								className="min-h-28"
								value={form.capabilityDesc}
								onChange={(e) => updateField("capabilityDesc", e.target.value)}
							/>
						</Field>
						<Field
							label="标签（逗号分隔）"
							htmlFor="tags"
							error={fieldErrors.tags}
						>
							<Input
								id="tags"
								placeholder="翻译, 代码生成"
								value={form.tagsInput}
								onChange={(e) => updateField("tagsInput", e.target.value)}
							/>
						</Field>
						<Field
							label="调用凭证"
							htmlFor="credentialSecret"
							error={fieldErrors.credentialSecret}
						>
							<Input
								id="credentialSecret"
								type="password"
								autoComplete="off"
								value={form.credentialSecret}
								onChange={(e) =>
									updateField("credentialSecret", e.target.value)
								}
							/>
						</Field>
					</div>
				</section>

				<div className="flex items-center gap-3">
					<Button
						type="submit"
						size="lg"
						disabled={state.kind === "submitting"}
					>
						{state.kind === "submitting" ? (
							<>
								<Loader2 className="size-4 animate-spin" aria-hidden />
								提交中…
							</>
						) : (
							"提交注册"
						)}
					</Button>
					{state.kind === "success" && (
						<span
							className="flex items-center gap-1.5 text-sm text-success"
							role="status"
						>
							<CheckCircle2 className="size-4" strokeWidth={1.5} aria-hidden />
							创建成功，
							<Link
								className="font-medium underline"
								href={`/agents/${state.agentId}/edit`}
							>
								继续配置
							</Link>
						</span>
					)}
					{state.kind === "error" && (
						<p
							className="flex items-center gap-1.5 text-destructive text-sm"
							role="alert"
						>
							<AlertCircle className="size-4" strokeWidth={1.5} aria-hidden />
							{state.message}
							{state.retryable ? "（可重试）" : ""}
						</p>
					)}
				</div>
			</form>

			<aside className="h-fit rounded-lg border border-tertiary/30 bg-tertiary-container p-5 text-tertiary-container-foreground">
				<div className="mb-3 flex items-center gap-2">
					<ShieldCheck className="size-5" strokeWidth={1.5} aria-hidden />
					<h2 className="font-semibold">凭证安全</h2>
				</div>
				<ul className="grid list-disc gap-2 pl-5 text-sm">
					<li>凭证使用应用层信封加密存储。</li>
					<li>提交后无法再次读取明文，只能整体替换。</li>
					<li>钱包地址创建后不可直接编辑。</li>
				</ul>
			</aside>
		</div>
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
				<p className="text-destructive text-xs" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
