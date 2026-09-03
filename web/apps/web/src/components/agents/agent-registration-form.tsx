"use client";

import { Button } from "@web/ui/components/button";
import { Input } from "@web/ui/components/input";
import { Label } from "@web/ui/components/label";
import { SelectField } from "@web/ui/components/select";
import { Textarea } from "@web/ui/components/textarea";
import {
	Bot,
	Braces,
	Check,
	CheckCircle2,
	CircleAlert,
	Code2,
	Copy,
	KeyRound,
	Loader2,
	PlugZap,
	Plus,
	Send,
	Trash2,
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
	testAgentConnection,
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
	integrationMode: "http_json";
	portfolioCases: AgentRegistrationValues["portfolioCases"];
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
	integrationMode: "http_json",
	portfolioCases: [],
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
	priceAmount: "priceAmount",
	priceCurrency: "priceAmount",
	payoutWalletAddress: "payoutWalletAddress",
	portfolioCases: "portfolio-title-0",
};

const AGENT_FIELD_ORDER = [
	"name",
	"capabilityDesc",
	"categoryId",
	"tags",
	"portfolioCases",
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

/**
 * 连接成功只对当前“执行地址 + 访问密钥”组合有效。任一字段变化都会回到 idle，
 * 避免用户测试地址 A 后改成地址 B，却仍携带旧的成功状态提交。
 */
type ConnectionState =
	| { kind: "idle" }
	| { kind: "testing" }
	| { kind: "success"; latencyMs: number }
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
	const [connectionState, setConnectionState] = useState<ConnectionState>({
		kind: "idle",
	});
	const [exampleOpen, setExampleOpen] = useState(false);
	const idempotencyKey = useRef(newIdempotencyKey());
	// 自增编号使过期的异步响应失效：测试进行中修改地址时，旧响应不得覆盖新表单。
	const connectionAttemptId = useRef(0);
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
		if (field === "serviceEndpoint" || field === "credentialSecret") {
			connectionAttemptId.current += 1;
			setConnectionState({ kind: "idle" });
		}
		setForm((current) => ({ ...current, [field]: value }));
		setFieldErrors((current) => {
			if (!(field in current)) return current;
			const next = { ...current };
			delete next[field as keyof AgentRegistrationFieldErrors];
			return next;
		});
	}

	/**
	 * 只探测同域 `/healthz`，不会向 Agent 发送真实任务。钱包会话是服务端 SSRF
	 * 防护的一部分，因此未登录时先引导连接钱包，不会悄悄发起匿名探测。
	 */
	async function handleConnectionTest() {
		if (wallet.status !== "connected") {
			setConnectionState({
				kind: "error",
				message: t("请先连接提供者钱包并完成签名登录"),
				retryable: false,
			});
			await wallet.connect();
			return;
		}
		if (form.serviceEndpoint.trim() === "") {
			const message = t("Agent 执行地址不能为空");
			setFieldErrors((current) => ({ ...current, serviceEndpoint: message }));
			// 必填校验已经由输入框下方的字段错误就近说明，不再把同一句话复制到
			// 接入区底部。连接状态区只负责展示真实探测过程和服务端探测结果。
			setConnectionState({ kind: "idle" });
			document.getElementById("serviceEndpoint")?.focus();
			return;
		}

		const attemptId = ++connectionAttemptId.current;
		setConnectionState({ kind: "testing" });
		const result = await testAgentConnection({
			serviceEndpoint: form.serviceEndpoint,
			...(form.credentialSecret === ""
				? {}
				: { credentialSecret: form.credentialSecret }),
		});
		if (connectionAttemptId.current !== attemptId) return;
		if (result.success) {
			setFieldErrors((current) => {
				if (
					current.serviceEndpoint === undefined &&
					current.credentialSecret === undefined
				)
					return current;
				const next = { ...current };
				delete next.serviceEndpoint;
				delete next.credentialSecret;
				return next;
			});
			setConnectionState({ kind: "success", latencyMs: result.latencyMs });
			return;
		}
		setConnectionState({
			kind: "error",
			message: result.error.message,
			retryable: result.error.retryable,
		});
	}

	/** 案例数组保持不可变更新，避免编辑一条案例时污染其它卡片或已提交请求快照。 */
	function updatePortfolioCase(
		index: number,
		patch: Partial<AgentRegistrationValues["portfolioCases"][number]>,
	) {
		setForm((current) => ({
			...current,
			portfolioCases: current.portfolioCases.map((item, itemIndex) =>
				itemIndex === index ? { ...item, ...patch } : item,
			),
		}));
		setFieldErrors((current) => {
			if (current.portfolioCases === undefined) return current;
			const next = { ...current };
			delete next.portfolioCases;
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
			integrationMode: form.integrationMode,
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
		if (connectionState.kind !== "success") {
			const message = t("请先测试 Agent 连接，确认服务可用后再提交");
			setConnectionState({ kind: "error", message, retryable: false });
			revealFormError({
				form: submittedForm,
				fieldId: "testAgentConnection",
				message,
				toastId: "agent-registration-connection",
			});
			return;
		}

		setFieldErrors({});
		setState({ kind: "submitting" });
		const submitted = validation.data;
		// 请求对象拿到凭证后立即清空输入状态，失败页面也不会继续显示明文。
		setForm((current) => ({ ...current, credentialSecret: "" }));
		setConnectionState({ kind: "idle" });

		const result = await registerAgent(submitted, idempotencyKey.current);
		if (result.success) {
			setForm({
				...INITIAL_STATE,
				payoutWalletAddress: connectedWalletAddress ?? "",
			});
			setState({ kind: "success", agentId: result.data.agentId });
			setConnectionState({ kind: "idle" });
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
				const field = fieldError.field.startsWith("portfolioCases.")
					? "portfolioCases"
					: (SERVER_FIELD_TO_FORM_FIELD[fieldError.field] ?? fieldError.field);
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
							<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
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
									id="testAgentConnection"
									type="button"
									variant="outline"
									size="lg"
									className="shrink-0 rounded-xl"
									disabled={
										connectionState.kind === "testing" ||
										state.kind === "submitting"
									}
									onClick={handleConnectionTest}
								>
									{connectionState.kind === "testing" ? (
										<Loader2 className="size-4 animate-spin" aria-hidden />
									) : (
										<PlugZap className="size-4" aria-hidden />
									)}
									{connectionState.kind === "testing"
										? t("测试中…")
										: t("测试连接")}
								</Button>
							</div>
							<div className="mt-1 flex flex-wrap items-center justify-between gap-2">
								<p className="text-muted-foreground text-xs">
									{t("平台会向该地址派发任务，并自动检查服务是否正常运行。")}
								</p>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-7 rounded-md px-1.5 text-primary hover:bg-primary/10 hover:text-primary"
									onClick={() => setExampleOpen(true)}
								>
									<Code2 className="size-3.5" aria-hidden />
									{t("查看接入示例")}
								</Button>
							</div>
						</Field>
						<Field
							label={t("访问密钥")}
							htmlFor="credentialSecret"
							error={fieldErrors.credentialSecret}
							optional
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
									placeholder={t("如 Agent 需要鉴权，请填写访问密钥")}
									value={form.credentialSecret}
									onChange={(event) =>
										updateField("credentialSecret", event.target.value)
									}
								/>
							</div>
							<p className="mt-1 text-muted-foreground text-xs">
								{t(
									"公开 Agent 可以留空；填写后会加密保存，提交后不再显示明文。",
								)}
							</p>
						</Field>
						{/* 地址必填错误已经紧邻输入框展示，此时隐藏底部状态条，避免用户看到
						    第二块重复或无关提示；修正输入后会自动恢复连接状态说明。 */}
						{fieldErrors.serviceEndpoint === undefined && (
							<ConnectionStatusNotice state={connectionState} />
						)}
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
									"发布者将看到此报价；平台服务费从成功结算的收入中扣除。",
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

					<section
						id="agent-portfolio-cases"
						aria-labelledby="agent-portfolio-heading"
						className="space-y-3 border-primary/10 border-t pt-6"
					>
						<div className="flex flex-wrap items-center justify-between gap-3">
							<div>
								<div className="flex flex-wrap items-center gap-2">
									<h3
										id="agent-portfolio-heading"
										className="font-medium text-sm"
									>
										{t("交付案例")}
									</h3>
									<OptionalBadge />
								</div>
								<p className="mt-1 max-w-2xl text-muted-foreground text-xs leading-5">
									{t(
										"添加案例，帮助用户提前了解 Agent 的实际交付效果。平台任务完成后，已验收交付会自动沉淀为平台验证案例。",
									)}
								</p>
							</div>
							<Button
								type="button"
								variant="outline"
								disabled={form.portfolioCases.length >= 3}
								onClick={() =>
									updateField("portfolioCases", [
										...form.portfolioCases,
										{
											title: "",
											summary: "",
											artifactKind: "website",
											previewRef: "",
										},
									])
								}
							>
								<Plus className="size-4" aria-hidden />
								{t("添加案例")}
							</Button>
						</div>
						{fieldErrors.portfolioCases !== undefined && (
							<p
								id="portfolioCases-error"
								role="alert"
								className="text-destructive text-xs"
							>
								{fieldErrors.portfolioCases}
							</p>
						)}
						{form.portfolioCases.map((portfolioCase, index) => (
							<article
								key={`portfolio-case-${index}`}
								className="rounded-xl border border-primary/15 bg-accent/35 p-4"
							>
								<div className="mb-4 flex items-center justify-between gap-3">
									<p className="font-medium text-sm">
										{t("案例 {number}", { number: index + 1 })}
									</p>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										aria-label={t("删除案例 {number}", { number: index + 1 })}
										onClick={() =>
											updateField(
												"portfolioCases",
												form.portfolioCases.filter(
													(_, itemIndex) => itemIndex !== index,
												),
											)
										}
									>
										<Trash2 className="size-4" aria-hidden />
									</Button>
								</div>
								<div className="grid gap-4 sm:grid-cols-2">
									<Field
										label={t("案例标题")}
										htmlFor={`portfolio-title-${index}`}
									>
										<Input
											id={`portfolio-title-${index}`}
											value={portfolioCase.title}
											maxLength={120}
											placeholder={t("例如：电商营销首页设计")}
											onChange={(event) =>
												updatePortfolioCase(index, {
													title: event.target.value,
												})
											}
										/>
									</Field>
									<Field
										label={t("案例类型")}
										htmlFor={`portfolio-kind-${index}`}
									>
										<SelectField
											id={`portfolio-kind-${index}`}
											value={portfolioCase.artifactKind}
											onValueChange={(artifactKind) =>
												updatePortfolioCase(index, {
													artifactKind:
														artifactKind as AgentRegistrationValues["portfolioCases"][number]["artifactKind"],
												})
											}
											options={portfolioKindOptions(t)}
										/>
									</Field>
								</div>
								{/* 单列字段共用同一个垂直节奏：既与上方双列输入保持间距，
								    也避免相邻字段的标签紧贴前一个输入框边缘。 */}
								<div className="mt-4 space-y-4">
									<Field
										label={t("公开预览地址")}
										htmlFor={`portfolio-url-${index}`}
									>
										<Input
											id={`portfolio-url-${index}`}
											type="url"
											maxLength={2000}
											value={portfolioCase.previewRef}
											placeholder="https://example.com/case"
											onChange={(event) =>
												updatePortfolioCase(index, {
													previewRef: event.target.value,
												})
											}
										/>
									</Field>
									<Field
										label={t("案例说明")}
										htmlFor={`portfolio-summary-${index}`}
									>
										<Textarea
											id={`portfolio-summary-${index}`}
											className="min-h-20"
											maxLength={600}
											value={portfolioCase.summary}
											placeholder={t(
												"说明这个案例解决了什么问题，以及最终交付结果。",
											)}
											onChange={(event) =>
												updatePortfolioCase(index, {
													summary: event.target.value,
												})
											}
										/>
									</Field>
								</div>
							</article>
						))}
					</section>
				</div>
			</form>

			<aside className="h-fit space-y-4 lg:sticky lg:top-24">
				<AgentSubmitCard
					form={form}
					categoryName={selectedCategory?.name ?? "—"}
					state={state}
					connectionState={connectionState}
					taxonomyReady={taxonomy.kind === "loaded"}
					walletStatus={wallet.status}
					onConnect={() => wallet.connect()}
				/>
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
	connectionState,
	taxonomyReady,
	walletStatus,
	onConnect,
}: {
	form: FormState;
	categoryName: string;
	state: SubmitState;
	connectionState: ConnectionState;
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
					label={t("连接状态")}
					value={
						connectionState.kind === "success" ? t("连接成功") : t("尚未测试")
					}
				/>
				<AgentPreviewRow
					label={t("单次服务报价（USDC）")}
					value={form.priceAmount === "" ? "—" : `${form.priceAmount} USDC`}
				/>
				{form.portfolioCases.length > 0 && (
					<AgentPreviewRow
						label={t("公开案例")}
						value={String(form.portfolioCases.length)}
					/>
				)}
			</dl>
			{/* 右栏只提醒提交后的关键动作；凭证与计费细节已在对应字段旁说明，
			    避免用户在提交前重复阅读大段提示。 */}
			<div className="mt-5 flex items-start gap-2 rounded-lg border border-primary/15 bg-primary/5 px-3 py-2.5 text-muted-foreground text-xs leading-5">
				<CheckCircle2
					className="mt-0.5 size-4 shrink-0 text-primary"
					aria-hidden
				/>
				<p>{t("连接测试通过后即可提交；平台上架后会持续记录服务运行状态。")}</p>
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

/**
 * 连接状态紧邻接入字段展示，用户无需滚到右栏猜测按钮是否生效。成功状态包含本次
 * 探测耗时作为真实反馈，但它只代表 `/healthz` 当前可达，不冒充任务执行验收。
 */
function ConnectionStatusNotice({ state }: { state: ConnectionState }) {
	const { t } = useLocale();
	if (state.kind === "idle") {
		return (
			<div className="flex items-center gap-2 rounded-xl border border-primary/10 bg-primary/5 px-3 py-2.5 text-muted-foreground text-xs">
				<PlugZap className="size-4 shrink-0" aria-hidden />
				<p>{t("填写完成后测试连接，确认平台可以访问你的 Agent。")}</p>
			</div>
		);
	}
	if (state.kind === "testing") {
		return (
			<div
				className="flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/10 px-3 py-2.5 text-primary text-xs"
				role="status"
			>
				<Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
				<p>{t("正在检查 Agent 服务…")}</p>
			</div>
		);
	}
	if (state.kind === "success") {
		return (
			<div
				className="flex items-center gap-2 rounded-xl border border-success/25 bg-success/10 px-3 py-2.5 text-success text-xs"
				role="status"
			>
				<CheckCircle2 className="size-4 shrink-0" aria-hidden />
				<p>
					{t("连接成功，响应耗时 {latency} ms", { latency: state.latencyMs })}
				</p>
			</div>
		);
	}
	return (
		<div
			className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-destructive text-xs"
			role="alert"
		>
			<CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
			<p>{state.message}</p>
		</div>
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

/** 案例类型的值属于接口协议，显示文案则统一走国际化，避免把英文枚举直接暴露给用户。 */
function portfolioKindOptions(t: ReturnType<typeof useLocale>["t"]) {
	return [
		{ value: "document", label: t("文档") },
		{ value: "image", label: t("图片") },
		{ value: "video", label: t("视频") },
		{ value: "website", label: t("网站") },
		{ value: "code", label: t("代码") },
		{ value: "other", label: t("其他") },
	] as const;
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
		<div className="fixed inset-0 z-80 flex items-end justify-center bg-background/75 p-0 backdrop-blur-md sm:items-center sm:p-6">
			<section
				role="dialog"
				aria-modal="true"
				aria-labelledby="integration-example-title"
				className="surface-elevated max-h-[92svh] w-full max-w-3xl overflow-y-auto rounded-t-2xl border border-primary/25 shadow-[0_30px_100px_rgba(0,0,0,0.65)] sm:rounded-2xl"
			>
				<header className="sticky top-0 flex items-start justify-between gap-4 border-primary/15 border-b bg-card/95 px-5 py-4 backdrop-blur-xl">
					<div>
						<p className="font-mono text-secondary text-xs">AGENT CONNECT</p>
						<h2
							id="integration-example-title"
							className="mt-1 font-semibold text-xl"
						>
							{t("快速接入你的 Agent")}
						</h2>
						<p className="mt-1 text-muted-foreground text-sm">
							{t("保留现有 Agent，只需让执行地址接收任务并返回交付结果。")}
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
					{copyState === "error" && (
						<p className="text-destructive text-xs" role="alert">
							{t("复制失败，请选中代码手动复制。")}
						</p>
					)}
					<ol className="grid gap-3 sm:grid-cols-3">
						<QuickStartStep
							number="01"
							title={t("保留现有 Agent")}
							description={t("无需更换模型或重写执行逻辑")}
						/>
						<QuickStartStep
							number="02"
							title={t("返回交付结果")}
							description={t("按示例返回产物类型与内容")}
						/>
						<QuickStartStep
							number="03"
							title={t("填写接入信息")}
							description={t("填写地址，按需填写访问密钥")}
						/>
					</ol>
					<div className="flex flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between">
						<div>
							<p className="font-semibold text-sm">HTTP API</p>
							<p className="mt-1 text-muted-foreground text-xs">
								{t("提供执行地址，并在同域开放 /healthz")}
							</p>
						</div>
						<CopyTemplateButton copyState={copyState} onCopy={copyTemplate} />
					</div>
					<CodeExample title="server.ts" code={AICP_TYPESCRIPT_TEMPLATE} />
					<div className="rounded-xl border border-primary/10 bg-muted/30 px-4 py-3 text-muted-foreground text-xs leading-5">
						{t(
							"平台负责任务状态、重试和产物保存；Agent 只需完成任务并返回结果。",
						)}
					</div>
				</div>
			</section>
		</div>
	);
}

function CopyTemplateButton({
	copyState,
	onCopy,
}: {
	copyState: "idle" | "copied" | "error";
	onCopy(): void;
}) {
	const { t } = useLocale();
	return (
		<Button
			type="button"
			variant={copyState === "copied" ? "default" : "outline"}
			className="shrink-0 rounded-xl"
			onClick={onCopy}
		>
			{copyState === "copied" ? (
				<Check className="size-4" aria-hidden />
			) : (
				<Copy className="size-4" aria-hidden />
			)}
			{copyState === "copied" ? t("代码已复制") : t("复制接入模板")}
		</Button>
	);
}

/** 三步接入信息使用独立卡片，长命令允许换行，避免窄屏横向溢出。 */
function QuickStartStep({
	number,
	title,
	description,
}: {
	number: string;
	title: string;
	description: string;
}) {
	return (
		<li className="min-w-0 rounded-xl border border-primary/15 bg-background/45 p-4">
			<p className="font-mono text-primary text-xs">{number}</p>
			<p className="mt-2 font-semibold text-sm">{title}</p>
			<p className="mt-1 break-words text-muted-foreground text-xs leading-5">
				{description}
			</p>
		</li>
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

interface FieldProps {
	label: string;
	htmlFor: string;
	error?: string;
	hint?: string;
	optional?: boolean;
	children: React.ReactNode;
}

function Field({
	label,
	htmlFor,
	error,
	hint,
	optional = false,
	children,
}: FieldProps) {
	return (
		<div>
			<div className="mb-2 flex items-center gap-2">
				<Label htmlFor={htmlFor} className="font-semibold text-sm">
					{label}
				</Label>
				{optional && <OptionalBadge />}
			</div>
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

/**
 * 所有可选字段共用同一个弱提示徽标，保证颜色、字号和间距完全一致；它只说明
 * 填写要求，不应抢占字段标题或主要操作的视觉注意力。
 */
function OptionalBadge() {
	const { t } = useLocale();
	return (
		<span className="rounded-md border border-primary/15 bg-primary/5 px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground">
			{t("可选")}
		</span>
	);
}
