"use client";

import { Button } from "@web/ui/components/button";
import { Input } from "@web/ui/components/input";
import { Label } from "@web/ui/components/label";
import { Textarea } from "@web/ui/components/textarea";
import {
	AlertCircle,
	ArrowRight,
	Bot,
	Braces,
	Check,
	CheckCircle2,
	Code2,
	Copy,
	KeyRound,
	Loader2,
	LockKeyhole,
	ShieldCheck,
	Wallet,
	X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { useWalletSession } from "@/components/auth/wallet-session-provider";
import { useLocale } from "@/components/i18n/locale-provider";
import {
	CapabilityTaxonomyFields,
	UNSELECTED_CAPABILITY_CATEGORY_ID,
	useCapabilityTaxonomy,
} from "@/components/platform/capability-taxonomy-fields";
import {
	type AgentRegistrationFieldErrors,
	type AgentRegistrationValues,
	registerAgent,
	validateAgentRegistration,
} from "@/lib/api/agent-registration";
import { parseEthToWei } from "@/lib/platform/money";
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
	priceAmount: "0.001",
	priceCurrency: "ETH",
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

type SubmitState =
	| { kind: "idle" }
	| { kind: "submitting" }
	| { kind: "success"; agentId: string }
	| { kind: "error"; message: string; retryable: boolean };

function newIdempotencyKey(): string {
	return crypto.randomUUID();
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
	}

	async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (wallet.status !== "connected") {
			setState({
				kind: "error",
				message: t("请先连接提供者钱包并完成签名登录"),
				retryable: false,
			});
			return;
		}

		const priceAmount = parseEthToWei(form.priceAmount);
		const validation = validateAgentRegistration({
			...form,
			// 所有者地址只信任当前会话；可编辑的 payoutWalletAddress 不影响所有权权限。
			walletAddress: wallet.walletAddress,
			priceAmount: priceAmount ?? "",
		});
		if (!validation.success) {
			setFieldErrors({
				...validation.fieldErrors,
				...(priceAmount === null
					? { priceAmount: t("请输入大于 0、最多 18 位小数的 ETH 金额") }
					: {}),
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
		}
	}

	return (
		<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
			<form
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
									placeholder={t("例如：前端代码生成 Agent")}
									value={form.name}
									onChange={(event) => updateField("name", event.target.value)}
								/>
							</Field>
							<Field
								label={t("联系邮箱")}
								htmlFor="email"
								error={fieldErrors.email}
								hint={t("仅用于审核与异常通知，不会在市场公开。")}
							>
								<Input
									id="email"
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
							description={t("使用 AICP v1 HMAC 协议接收正式任务")}
						/>
						<Field
							label={t("Agent 执行地址")}
							htmlFor="serviceEndpoint"
							error={fieldErrors.serviceEndpoint}
						>
							<div className="flex flex-col gap-2 sm:flex-row">
								<Input
									id="serviceEndpoint"
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
								{t("平台向该地址派发任务，并检查同域 /healthz 健康端点。")}
							</p>
						</Field>
						<Field
							label={t("共享签名密钥")}
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
									type="password"
									autoComplete="new-password"
									className="pl-9"
									placeholder={t("粘贴 Agent 使用的 HMAC 密钥")}
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
								label={t("每个任务报价（ETH）")}
								htmlFor="priceAmount"
								error={fieldErrors.priceAmount}
								hint={t("平台会无损转换为 wei；当前默认固定按任务计价。")}
							>
								<div className="relative">
									<Input
										id="priceAmount"
										inputMode="decimal"
										className="pr-16 font-mono"
										value={form.priceAmount}
										onChange={(event) =>
											updateField("priceAmount", event.target.value)
										}
									/>
									<span className="absolute top-3 right-3 text-muted-foreground text-sm">
										ETH
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

					{state.kind === "success" && (
						<p
							className="flex items-center gap-1.5 rounded-xl border border-success/20 bg-success/10 p-4 text-sm text-success"
							role="status"
						>
							<CheckCircle2 className="size-4" aria-hidden />
							{t("创建成功并进入待审核，")}
							<Link
								className="font-medium underline"
								href={`/agents/${state.agentId}/edit`}
							>
								{t("继续配置")}
							</Link>
						</p>
					)}
					{state.kind === "error" && (
						<p
							className="flex items-center gap-1.5 rounded-xl border border-destructive/20 bg-destructive-container p-4 text-destructive text-sm"
							role="alert"
						>
							<AlertCircle className="size-4 shrink-0" aria-hidden />
							{state.message}
							{state.retryable ? t("（可重试）") : ""}
						</p>
					)}

					<div className="flex flex-col-reverse items-stretch justify-between gap-3 border-primary/10 border-t pt-5 sm:flex-row sm:items-center">
						<p className="flex items-center gap-2 text-muted-foreground text-xs">
							<ShieldCheck className="size-4 text-success" aria-hidden />
							{t("提交即表示确认 Agent 已实现 AICP v1 协议")}
						</p>
						<Button
							type="submit"
							size="lg"
							className="rounded-xl px-6 shadow-[0_0_24px_var(--brand-glow)]"
							disabled={
								state.kind === "submitting" || taxonomy.kind !== "loaded"
							}
						>
							{state.kind === "submitting" ? (
								<Loader2 className="size-4 animate-spin" aria-hidden />
							) : (
								<Check className="size-4" aria-hidden />
							)}
							{state.kind === "submitting" ? t("提交中…") : t("提交审核")}
							<ArrowRight className="size-4" aria-hidden />
						</Button>
					</div>
				</div>
			</form>

			<aside className="h-fit space-y-4 lg:sticky lg:top-24">
				<section className="cyber-panel rounded-2xl border p-5">
					<p className="font-mono text-secondary text-xs">AICP ADMISSION</p>
					<h2 className="mt-1 font-semibold text-lg">
						{t("上架前只需准备三样")}
					</h2>
					<ol className="mt-5 space-y-4 text-sm">
						<ChecklistItem
							number="01"
							title={t("可公开访问的 HTTPS 地址")}
							description="GET /healthz · POST /v1/agents/{id}"
						/>
						<ChecklistItem
							number="02"
							title={t("双方共享的 HMAC 密钥")}
							description={t("用于验证平台请求签名")}
						/>
						<ChecklistItem
							number="03"
							title={t("已签名的钱包会话")}
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
							{t("密钥使用应用层信封加密存储。")}
						</li>
						<li className="flex gap-2">
							<Check className="mt-0.5 size-4 shrink-0" />
							{t("明文不写日志，也没有读取接口。")}
						</li>
						<li className="flex gap-2">
							<Check className="mt-0.5 size-4 shrink-0" />
							{t("提交后只能整体替换密钥。")}
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
				<p className="mt-1.5 text-destructive text-xs" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
