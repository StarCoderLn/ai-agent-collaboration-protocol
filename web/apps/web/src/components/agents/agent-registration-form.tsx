"use client";

import { Button } from "@web/ui/components/button";
import { Input } from "@web/ui/components/input";
import { Label } from "@web/ui/components/label";
import { Textarea } from "@web/ui/components/textarea";
import {
	Bot,
	Braces,
	Check,
	CheckCircle2,
	Code2,
	Copy,
	KeyRound,
	Loader2,
	LockKeyhole,
	Send,
	Wallet,
	X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { useWalletSession } from "@/components/auth/wallet-session-provider";
import { useLocale } from "@/components/i18n/locale-provider";
import {
	CapabilityTaxonomyFields,
	findCapabilityCategory,
	UNSELECTED_CAPABILITY_CATEGORY_ID,
	useCapabilityTaxonomy,
} from "@/components/platform/capability-taxonomy-fields";
import {
	type AgentRegistrationFieldErrors,
	type AgentRegistrationValues,
	registerAgent,
	validateAgentRegistration,
} from "@/lib/api/agent-registration";
import { revealFormError } from "@/lib/forms/reveal-form-error";
import {
	MIN_USDC_BUSINESS_AMOUNT_MINOR,
	parseUsdcToMinor,
} from "@/lib/platform/money";
import { AICP_TYPESCRIPT_TEMPLATE } from "./aicp-typescript-template";

/**
 * 表单只保存用户可以编辑的资料。所有者钱包不进入这里，提交时必须从 SIWE 会话读取；
 * 收款钱包是独立结算配置，默认使用登录钱包，但允许提供者填写不同的运营地址。
 */
interface FormState {
	name: string;
	categoryId: string;
	capabilityDesc: string;
	tags: readonly string[];
	pricingType: string;
	priceAmount: string;
	priceCurrency: string;
	payoutWalletAddress: string;
	serviceEndpoint: string;
	credentialSecret: string;
	email: string;
}

const INITIAL_STATE: FormState = {
	name: "",
	categoryId: UNSELECTED_CAPABILITY_CATEGORY_ID,
	capabilityDesc: "",
	tags: [],
	pricingType: "fixed",
	priceAmount: "",
	priceCurrency: "USDC",
	payoutWalletAddress: "",
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

const AGENT_REGISTRATION_FORM_ID = "agent-registration-form";
const AGENT_FIELD_IDS: Readonly<
	Partial<Record<keyof AgentRegistrationValues, string>>
> = {
	name: "name",
	categoryId: "agent-capability-category",
	capabilityDesc: "capabilityDesc",
	tags: "agent-custom-tag",
	serviceEndpoint: "serviceEndpoint",
	credentialSecret: "credentialSecret",
	email: "email",
	priceAmount: "priceAmount",
	priceCurrency: "priceAmount",
	payoutWalletAddress: "payoutWalletAddress",
};

const AGENT_FIELD_ORDER = [
	"name",
	"email",
	"capabilityDesc",
	"categoryId",
	"tags",
	"serviceEndpoint",
	"credentialSecret",
	"priceAmount",
	"priceCurrency",
	"payoutWalletAddress",
] as const satisfies readonly (keyof AgentRegistrationFieldErrors)[];

type SubmitState =
	| { kind: "idle" }
	| { kind: "submitting" }
	| { kind: "success"; agentId: string }
	| { kind: "error"; message: string; retryable: boolean };

function newIdempotencyKey(): string {
	return crypto.randomUUID();
}

/** 固定首错顺序与页面阅读顺序一致，不依赖 Zod 或服务端对象属性的偶然排列。 */
function firstAgentErrorField(
	errors: AgentRegistrationFieldErrors,
): keyof AgentRegistrationValues | null {
	return AGENT_FIELD_ORDER.find((field) => errors[field] !== undefined) ?? null;
}

export default function AgentRegistrationForm() {
	const { t } = useLocale();
	const wallet = useWalletSession();
	const taxonomy = useCapabilityTaxonomy();
	const connectedWalletAddress =
		wallet.status === "connected" ? wallet.walletAddress : null;
	const [form, setForm] = useState<FormState>(INITIAL_STATE);
	const [fieldErrors, setFieldErrors] = useState<AgentRegistrationFieldErrors>(
		{},
	);
	const [state, setState] = useState<SubmitState>({ kind: "idle" });
	const [exampleOpen, setExampleOpen] = useState(false);
	const idempotencyKey = useRef(newIdempotencyKey());
	const selectedCategory =
		taxonomy.kind === "loaded"
			? findCapabilityCategory(taxonomy.categories, form.categoryId)
			: null;
	// 首次连接成功时用登录钱包作为便捷默认值；只在输入仍为空时回填，绝不覆盖用户
	// 已经手动填写的独立收款地址。
	useEffect(() => {
		if (connectedWalletAddress === null) return;
		setForm((current) =>
			current.payoutWalletAddress === ""
				? { ...current, payoutWalletAddress: connectedWalletAddress }
				: current,
		);
	}, [connectedWalletAddress]);

	// 协议示例是辅助层，支持 Escape 关闭，避免键盘用户被困在弹窗中。
	useEffect(() => {
		if (!exampleOpen) return;
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setExampleOpen(false);
		};
		document.addEventListener("keydown", closeOnEscape);
		return () => document.removeEventListener("keydown", closeOnEscape);
	}, [exampleOpen]);

	function updateField<K extends keyof FormState>(
		field: K,
		value: FormState[K],
	) {
		// 修改失败请求后换用新的幂等键，避免新内容意外重放旧响应。
		if (state.kind === "error") {
			idempotencyKey.current = newIdempotencyKey();
			setState({ kind: "idle" });
		}
		setForm((current) => ({ ...current, [field]: value }));
		setFieldErrors((current) => {
			if (!(field in current)) return current;
			const next = { ...current };
			delete next[field as keyof AgentRegistrationFieldErrors];
			return next;
		});
	}

	async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const submittedForm = event.currentTarget;
		if (wallet.status !== "connected") {
			const message = t("请先连接提供者钱包并完成签名登录");
			setState({ kind: "error", message, retryable: false });
			revealFormError({
				form: submittedForm,
				message,
				toastId: "agent-registration-validation",
			});
			return;
		}

		const priceAmount = parseUsdcToMinor(form.priceAmount);
		const priceBelowMinimum =
			priceAmount !== null &&
			BigInt(priceAmount) < MIN_USDC_BUSINESS_AMOUNT_MINOR;
		const validation = validateAgentRegistration({
			...form,
			// 所有者地址只信任当前会话；可编辑的 payoutWalletAddress 不影响所有权权限。
			walletAddress: wallet.walletAddress,
			priceAmount: priceAmount ?? "",
		});
		if (!validation.success || priceBelowMinimum) {
			const nextErrors: AgentRegistrationFieldErrors = {
				...(validation.success ? {} : validation.fieldErrors),
				...(priceAmount === null || priceBelowMinimum
					? {
							priceAmount: t("单次服务报价至少为 1 USDC，最多保留 6 位小数"),
						}
					: {}),
			};
			setFieldErrors(nextErrors);
			const firstField = firstAgentErrorField(nextErrors);
			const message =
				(firstField === null ? undefined : nextErrors[firstField]) ??
				t("请检查输入内容");
			revealFormError({
				form: submittedForm,
				fieldId: firstField === null ? undefined : AGENT_FIELD_IDS[firstField],
				message,
				toastId: "agent-registration-validation",
			});
			return;
		}

		setFieldErrors({});
		setState({ kind: "submitting" });
		const submitted = validation.data;
		// 请求对象拿到凭证后立即清空输入状态，失败页面也不会继续显示明文。
		setForm((current) => ({ ...current, credentialSecret: "" }));

		const result = await registerAgent(submitted, idempotencyKey.current);
		if (result.success) {
			setForm({
				...INITIAL_STATE,
				payoutWalletAddress: connectedWalletAddress ?? "",
			});
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
				if (field in validation.data)
					mapped[field as keyof AgentRegistrationValues] = fieldError.message;
			}
			setFieldErrors(mapped);
			const firstField = firstAgentErrorField(mapped);
			revealFormError({
				form: submittedForm,
				fieldId: firstField === null ? undefined : AGENT_FIELD_IDS[firstField],
				message: result.error.message,
				toastId: "agent-registration-submit",
			});
		} else {
			revealFormError({
				form: submittedForm,
				message: result.error.message,
				toastId: "agent-registration-submit",
			});
		}
	}

	return (
		<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
			<form
				id={AGENT_REGISTRATION_FORM_ID}
				onSubmit={handleSubmit}
				className="cyber-panel cyber-corner overflow-hidden rounded-2xl border"
				noValidate
			>
				{/* 页面主标题已经解释上架目标，表单直接进入资料填写，避免重复说明流程。 */}
				<div className="space-y-7 p-5 sm:p-6">
					<section
						aria-labelledby="agent-profile-heading"
						className="space-y-5"
					>
						<SectionTitle
							id="agent-profile-heading"
							icon={Bot}
							title={t("市场资料")}
							description={t("这些信息用于候选匹配与 Agent 市场展示")}
						/>
						<div className="grid gap-4 sm:grid-cols-2">
							<Field
								label={t("Agent 名称")}
								htmlFor="name"
								error={fieldErrors.name}
							>
								<Input
									id="name"
									aria-invalid={fieldErrors.name !== undefined}
									aria-describedby={
										fieldErrors.name === undefined ? undefined : "name-error"
									}
									placeholder={t("例如：前端代码生成 Agent")}
									value={form.name}
									onChange={(event) => updateField("name", event.target.value)}
								/>
							</Field>
							<Field
								label={t("联系邮箱")}
								htmlFor="email"
								error={fieldErrors.email}
								hint={t("仅用于服务验证与异常通知，不会在市场公开。")}
							>
								<Input
									id="email"
									aria-invalid={fieldErrors.email !== undefined}
									aria-describedby={
										fieldErrors.email === undefined ? undefined : "email-error"
									}
									type="email"
									placeholder="provider@example.com"
									value={form.email}
									onChange={(event) => updateField("email", event.target.value)}
								/>
							</Field>
						</div>
						<Field
							label={t("能力说明")}
							htmlFor="capabilityDesc"
							error={fieldErrors.capabilityDesc}
						>
							<Textarea
								id="capabilityDesc"
								aria-invalid={fieldErrors.capabilityDesc !== undefined}
								aria-describedby={
									fieldErrors.capabilityDesc === undefined
										? undefined
										: "capabilityDesc-error"
								}
								className="min-h-28 rounded-lg text-sm leading-6"
								placeholder={t("说明最擅长完成什么任务，以及交付物形式。")}
								value={form.capabilityDesc}
								onChange={(event) =>
									updateField("capabilityDesc", event.target.value)
								}
							/>
						</Field>
						<CapabilityTaxonomyFields
							idPrefix="agent"
							state={taxonomy}
							categoryId={form.categoryId}
							selectedTags={form.tags}
							onCategoryChange={(value) => updateField("categoryId", value)}
							onTagsChange={(value) => updateField("tags", value)}
							categoryError={fieldErrors.categoryId}
							tagsError={fieldErrors.tags}
						/>
					</section>

					<section
						aria-labelledby="agent-connection-heading"
						className="space-y-5 border-primary/10 border-t pt-6"
					>
						<SectionTitle
							id="agent-connection-heading"
							icon={Braces}
							title={t("服务接入")}
							description={t("填写平台调用 Agent 时使用的地址和访问密钥")}
						/>
						<Field
							label={t("Agent 执行地址")}
							htmlFor="serviceEndpoint"
							error={fieldErrors.serviceEndpoint}
						>
							<div className="flex flex-col gap-2 sm:flex-row">
								<Input
									id="serviceEndpoint"
									aria-invalid={fieldErrors.serviceEndpoint !== undefined}
									aria-describedby={
										fieldErrors.serviceEndpoint === undefined
											? undefined
											: "serviceEndpoint-error"
									}
									type="url"
									className="flex-1"
									placeholder="https://agent.example.com/v1/agents/my-agent"
									value={form.serviceEndpoint}
									onChange={(event) =>
										updateField("serviceEndpoint", event.target.value)
									}
								/>
								<Button
									type="button"
									variant="outline"
									size="lg"
									className="rounded-xl"
									onClick={() => setExampleOpen(true)}
								>
									<Code2 className="size-4" aria-hidden />
									{t("查看接入示例")}
								</Button>
							</div>
							<p className="mt-1 text-muted-foreground text-xs">
								{t("平台会向该地址派发任务，并自动检查服务是否正常运行。")}
							</p>
						</Field>
						<Field
							label={t("访问密钥")}
							htmlFor="credentialSecret"
							error={fieldErrors.credentialSecret}
						>
							<div className="relative">
								<KeyRound
									className="pointer-events-none absolute top-3.5 left-3 size-4 text-muted-foreground"
									aria-hidden
								/>
								<Input
									id="credentialSecret"
									aria-invalid={fieldErrors.credentialSecret !== undefined}
									aria-describedby={
										fieldErrors.credentialSecret === undefined
											? undefined
											: "credentialSecret-error"
									}
									type="password"
									autoComplete="new-password"
									className="pl-9"
									placeholder={t("粘贴与 Agent 配置一致的访问密钥")}
									value={form.credentialSecret}
									onChange={(event) =>
										updateField("credentialSecret", event.target.value)
									}
								/>
							</div>
							<p className="mt-1 text-muted-foreground text-xs">
								{t("提交后无法查看明文，只能整体替换。")}
							</p>
						</Field>
					</section>

					<section
						aria-labelledby="agent-pricing-heading"
						className="space-y-5 border-primary/10 border-t pt-6"
					>
						<SectionTitle
							id="agent-pricing-heading"
							icon={Wallet}
							title={t("报价与收款")}
							description={t("登录钱包确认所有者身份，收款钱包可由你单独设置")}
						/>
						<div className="grid gap-4 sm:grid-cols-2">
							<Field
								label={t("单次服务报价（USDC）")}
								htmlFor="priceAmount"
								error={fieldErrors.priceAmount}
								hint={t(
									"Agent 每完成一次匹配需求的基础报价；成功结算时平台服务费从该收入中扣除。",
								)}
							>
								<div className="relative">
									<Input
										id="priceAmount"
										aria-invalid={fieldErrors.priceAmount !== undefined}
										aria-describedby={
											fieldErrors.priceAmount === undefined
												? undefined
												: "priceAmount-error"
										}
										inputMode="decimal"
										className="pr-16 font-mono"
										placeholder={t("例如：25")}
										value={form.priceAmount}
										onChange={(event) =>
											updateField("priceAmount", event.target.value)
										}
									/>
									<span className="absolute top-3 right-3 text-muted-foreground text-sm">
										USDC
									</span>
								</div>
							</Field>
							<Field
								label={t("收款钱包")}
								htmlFor="payoutWalletAddress"
								error={fieldErrors.payoutWalletAddress}
								hint={t(
									"默认使用登录钱包，也可以填写其他支持当前网络资产的钱包地址。",
								)}
							>
								<div className="relative">
									<Wallet
										className="pointer-events-none absolute top-3.5 left-3 size-4 text-muted-foreground"
										aria-hidden
									/>
									<Input
										id="payoutWalletAddress"
										aria-invalid={fieldErrors.payoutWalletAddress !== undefined}
										aria-describedby={
											fieldErrors.payoutWalletAddress === undefined
												? undefined
												: "payoutWalletAddress-error"
										}
										className="pl-9 font-mono text-xs"
										placeholder="0x..."
										value={form.payoutWalletAddress}
										onChange={(event) =>
											updateField("payoutWalletAddress", event.target.value)
										}
									/>
								</div>
							</Field>
						</div>
					</section>
				</div>
			</form>

			<aside className="h-fit space-y-4 lg:sticky lg:top-24">
				<AgentSubmitCard
					form={form}
					categoryName={selectedCategory?.name ?? "—"}
					state={state}
					taxonomyReady={taxonomy.kind === "loaded"}
					walletStatus={wallet.status}
					onConnect={() => wallet.connect()}
				/>
				<section className="cyber-panel rounded-2xl border p-5">
					<p className="font-mono text-secondary text-xs">LISTING CHECKLIST</p>
					<h2 className="mt-1 font-semibold text-lg">
						{t("上架前只需准备三样")}
					</h2>
					<ol className="mt-5 space-y-4 text-sm">
						<ChecklistItem
							number="01"
							title={t("平台可访问的服务地址")}
							description={t("用于接收任务并报告运行状态")}
						/>
						<ChecklistItem
							number="02"
							title={t("用于验证平台请求的访问密钥")}
							description={t("防止未经授权的请求调用 Agent")}
						/>
						<ChecklistItem
							number="03"
							title={t("已连接的钱包")}
							description={t("用于确认 Agent 所有者身份")}
						/>
					</ol>
				</section>
				<section className="rounded-2xl border border-tertiary/30 bg-tertiary-container p-5 text-tertiary-container-foreground">
					<div className="mb-3 flex items-center gap-2">
						<LockKeyhole className="size-5" aria-hidden />
						<h2 className="font-semibold">{t("凭证安全")}</h2>
					</div>
					<ul className="grid gap-2 text-sm">
						<li className="flex gap-2">
							<Check className="mt-0.5 size-4 shrink-0" />
							{t("访问密钥会加密保存。")}
						</li>
						<li className="flex gap-2">
							<Check className="mt-0.5 size-4 shrink-0" />
							{t("平台不会公开或返回密钥明文。")}
						</li>
						<li className="flex gap-2">
							<Check className="mt-0.5 size-4 shrink-0" />
							{t("如需修改，只能使用新密钥整体替换。")}
						</li>
					</ul>
				</section>
			</aside>

			{exampleOpen && (
				<IntegrationExampleDialog onClose={() => setExampleOpen(false)} />
			)}
		</div>
	);
}

function AgentSubmitCard({
	form,
	categoryName,
	state,
	taxonomyReady,
	walletStatus,
	onConnect,
}: {
	form: FormState;
	categoryName: string;
	state: SubmitState;
	taxonomyReady: boolean;
	walletStatus:
		| "checking"
		| "disconnected"
		| "connecting"
		| "connected"
		| "error";
	onConnect(): Promise<void>;
}) {
	const { t } = useLocale();
	const walletBusy =
		walletStatus === "checking" || walletStatus === "connecting";
	const walletConnected = walletStatus === "connected";
	return (
		<section className="cyber-panel cyber-corner rounded-2xl border p-5">
			<h2 className="font-semibold text-lg">{t("上架确认")}</h2>
			<dl className="mt-5 space-y-3 text-sm">
				<AgentPreviewRow label={t("Agent 名称")} value={form.name || "—"} />
				<AgentPreviewRow label={t("服务分类")} value={categoryName} />
				<AgentPreviewRow
					label={t("单次服务报价（USDC）")}
					value={form.priceAmount === "" ? "—" : `${form.priceAmount} USDC`}
				/>
			</dl>
			<div className="mt-5 space-y-2 rounded-lg border border-tertiary/20 bg-tertiary-container p-3 text-tertiary-container-foreground text-xs leading-5">
				<p>{t("提交后，平台将自动检查服务连通性和接入要求。")}</p>
				<p>
					{t(
						"你的报价是发布者看到的成交金额；平台服务费仅在成功结算时从 Agent 收入中扣除，最终明细会在验收前展示。",
					)}
				</p>
			</div>
			<Button
				form={AGENT_REGISTRATION_FORM_ID}
				type={walletConnected ? "submit" : "button"}
				size="lg"
				className="mt-5 w-full rounded-full shadow-[0_0_24px_var(--brand-glow)]"
				disabled={state.kind === "submitting" || walletBusy || !taxonomyReady}
				onClick={walletConnected ? undefined : onConnect}
			>
				{state.kind === "submitting" || walletBusy ? (
					<Loader2 className="size-4 animate-spin" aria-hidden />
				) : walletConnected ? (
					<Send className="size-4" aria-hidden />
				) : (
					<Wallet className="size-4" aria-hidden />
				)}
				{state.kind === "submitting"
					? t("提交中…")
					: walletBusy
						? t("正在连接钱包")
						: walletConnected
							? t("提交上架")
							: t("连接钱包后提交")}
			</Button>
			{state.kind === "success" && (
				<p
					className="mt-4 flex items-start gap-2 rounded-lg border border-success/20 bg-success/10 p-3 text-sm text-success"
					role="status"
				>
					<CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
					<span>
						{t("提交成功，等待平台验证，")}
						<Link
							className="font-medium underline"
							href={`/agents/${state.agentId}/edit`}
						>
							{t("继续配置")}
						</Link>
					</span>
				</p>
			)}
		</section>
	);
}

function AgentPreviewRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-start justify-between gap-4">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="max-w-[60%] truncate text-right font-medium">{value}</dd>
		</div>
	);
}

function IntegrationExampleDialog({ onClose }: { onClose(): void }) {
	const { t } = useLocale();
	const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
		"idle",
	);

	async function copyTemplate() {
		try {
			if (navigator.clipboard === undefined)
				throw new Error("CLIPBOARD_UNAVAILABLE");
			await navigator.clipboard.writeText(AICP_TYPESCRIPT_TEMPLATE);
			setCopyState("copied");
		} catch {
			setCopyState("error");
		}
	}

	return (
		<div className="fixed inset-0 z-[80] flex items-end justify-center bg-background/75 p-0 backdrop-blur-md sm:items-center sm:p-6">
			<section
				role="dialog"
				aria-modal="true"
				aria-labelledby="integration-example-title"
				className="surface-elevated max-h-[92svh] w-full max-w-3xl overflow-y-auto rounded-t-2xl border border-primary/25 shadow-[0_30px_100px_rgba(0,0,0,0.65)] sm:rounded-2xl"
			>
				<header className="sticky top-0 flex items-start justify-between gap-4 border-primary/15 border-b bg-card/95 px-5 py-4 backdrop-blur-xl">
					<div>
						<p className="font-mono text-secondary text-xs">PROTOCOL v1.0</p>
						<h2
							id="integration-example-title"
							className="mt-1 font-semibold text-xl"
						>
							{t("可直接使用的 AICP 接入模板")}
						</h2>
						<p className="mt-1 text-muted-foreground text-sm">
							{t("复制为 server.ts，设置共享密钥后即可启动并接收平台任务。")}
						</p>
					</div>
					<button
						type="button"
						className="flex size-10 cursor-pointer items-center justify-center rounded-xl border text-muted-foreground hover:bg-muted hover:text-foreground"
						aria-label={t("关闭接入示例")}
						onClick={onClose}
					>
						<X className="size-4" />
					</button>
				</header>
				<div className="space-y-4 p-5">
					<div className="flex flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between">
						<div>
							<p className="font-semibold text-sm">Node.js + TypeScript</p>
							<p className="mt-1 text-muted-foreground text-xs">
								{t("无需 Web 框架，保存后运行 npx tsx server.ts")}
							</p>
						</div>
						<Button
							type="button"
							variant={copyState === "copied" ? "default" : "outline"}
							className="rounded-xl"
							onClick={copyTemplate}
						>
							{copyState === "copied" ? (
								<Check className="size-4" aria-hidden />
							) : (
								<Copy className="size-4" aria-hidden />
							)}
							{copyState === "copied" ? t("代码已复制") : t("复制完整代码")}
						</Button>
					</div>
					{copyState === "error" && (
						<p className="text-destructive text-xs" role="alert">
							{t("复制失败，请选中代码手动复制。")}
						</p>
					)}
					<CodeExample title="server.ts" code={AICP_TYPESCRIPT_TEMPLATE} />
					<div className="rounded-xl border border-warning/25 bg-warning/10 p-4 text-sm leading-6">
						<strong>{t("上线前：")}</strong>
						{t(
							"模板中的 Nonce 与幂等记录存放在内存中。正式部署请改用 Redis 或数据库，并先把任务持久化再返回 202。",
						)}
					</div>
				</div>
			</section>
		</div>
	);
}

function CodeExample({ title, code }: { title: string; code: string }) {
	return (
		<section>
			<h3 className="mb-2 font-semibold text-sm">{title}</h3>
			<pre className="max-h-[55svh] overflow-auto rounded-xl border border-primary/15 bg-background/80 p-4 font-mono text-secondary text-xs leading-6">
				<code>{code}</code>
			</pre>
		</section>
	);
}

function SectionTitle({
	id,
	icon: Icon,
	title,
	description,
}: {
	id: string;
	icon: typeof Bot;
	title: string;
	description: string;
}) {
	return (
		<div className="flex items-start gap-3">
			<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-container text-primary">
				<Icon className="size-4" aria-hidden />
			</span>
			<div>
				<h3 id={id} className="font-semibold">
					{title}
				</h3>
				<p className="mt-1 text-muted-foreground text-xs">{description}</p>
			</div>
		</div>
	);
}

function ChecklistItem({
	number,
	title,
	description,
}: {
	number: string;
	title: string;
	description: string;
}) {
	return (
		<li className="flex gap-3">
			<span className="font-mono text-primary">{number}</span>
			<div>
				<p className="font-medium">{title}</p>
				<p className="mt-1 text-muted-foreground text-xs leading-5">
					{description}
				</p>
			</div>
		</li>
	);
}

interface FieldProps {
	label: string;
	htmlFor: string;
	error?: string;
	hint?: string;
	children: React.ReactNode;
}

function Field({ label, htmlFor, error, hint, children }: FieldProps) {
	return (
		<div>
			<Label htmlFor={htmlFor} className="mb-2 font-semibold text-sm">
				{label}
			</Label>
			{children}
			{hint && <p className="mt-1.5 text-muted-foreground text-xs">{hint}</p>}
			{error && (
				<p
					id={`${htmlFor}-error`}
					className="mt-1.5 text-destructive text-xs"
					role="alert"
				>
					{error}
				</p>
			)}
		</div>
	);
}
