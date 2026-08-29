"use client";

import { Button } from "@web/ui/components/button";
import { Input } from "@web/ui/components/input";
import { Label } from "@web/ui/components/label";
import { Textarea } from "@web/ui/components/textarea";
import {
	CalendarClock,
	Check,
	CheckCircle2,
	ChevronDown,
	Loader2,
	LockKeyhole,
	Send,
	SlidersHorizontal,
	Sparkles,
	type Tags,
	Wallet,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useRef, useState } from "react";
import { useWalletSession } from "@/components/auth/wallet-session-provider";
import { useLocale } from "@/components/i18n/locale-provider";
import {
	CapabilityTaxonomyFields,
	findCapabilityCategory,
	UNSELECTED_CAPABILITY_CATEGORY_ID,
	useCapabilityTaxonomy,
} from "@/components/platform/capability-taxonomy-fields";
import { DatePicker } from "@/components/platform/date-picker";
import {
	createTaskDraft,
	submitTask,
	TaskApiRequestError,
	type TaskDraftInput,
	updateTaskDraft,
} from "@/lib/api/tasks";
import { revealFormError } from "@/lib/forms/reveal-form-error";
import type { MessageId } from "@/lib/i18n/messages";
import { localDateToDeadlineIso } from "@/lib/platform/deadline";
import {
	formatMinorAmount,
	MAX_TASK_BUDGET_MINOR,
	MIN_USDC_BUSINESS_AMOUNT_MINOR,
	MVP_CURRENCY,
	parseUsdcToMinor,
} from "@/lib/platform/money";

type SubmitState =
	| Readonly<{ kind: "idle" }>
	| Readonly<{ kind: "saving" | "submitting" }>
	| Readonly<{
			kind: "error";
			message: string;
			issues: readonly string[];
			draftId: string | null;
	  }>;

type TaskValidationField =
	| "title"
	| "description"
	| "categoryId"
	| "tags"
	| "budget"
	| "deadline";

const TASK_FIELD_IDS: Readonly<Record<TaskValidationField, string>> = {
	title: "task-title",
	description: "task-description",
	categoryId: "task-capability-category",
	tags: "task-custom-tag",
	budget: "task-budget",
	deadline: "task-deadline",
};

export default function NewTaskForm() {
	const { locale, t } = useLocale();
	const router = useRouter();
	const wallet = useWalletSession();
	const taxonomy = useCapabilityTaxonomy();
	const [categoryId, setCategoryId] = useState(
		UNSELECTED_CAPABILITY_CATEGORY_ID,
	);
	const [selectedTags, setSelectedTags] = useState<readonly string[]>([]);
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [budget, setBudget] = useState("");
	const [deadline, setDeadline] = useState("");
	const [visibility, setVisibility] = useState<"public" | "private">("public");
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [state, setState] = useState<SubmitState>({ kind: "idle" });
	const [validationError, setValidationError] = useState<Readonly<{
		field: TaskValidationField;
		message: string;
	}> | null>(null);
	const [draftId, setDraftId] = useState<string | null>(null);
	const createKey = useRef(crypto.randomUUID());
	const updateKey = useRef(crypto.randomUUID());
	const submitKey = useRef(crypto.randomUUID());

	const budgetMinor = useMemo(() => parseUsdcToMinor(budget), [budget]);
	const selectedCategory =
		taxonomy.kind === "loaded"
			? findCapabilityCategory(taxonomy.categories, categoryId)
			: null;
	const structuredFields = buildStructuredTaskFields(
		description,
		selectedCategory?.name ?? "",
		selectedTags,
		locale,
	);

	function markDirty() {
		updateKey.current = crypto.randomUUID();
		setState({ kind: "idle" });
		setValidationError(null);
	}

	function rejectSubmit(
		formElement: HTMLFormElement,
		field: TaskValidationField,
		message: string,
	) {
		setValidationError({ field, message });
		setState({ kind: "idle" });
		revealFormError({
			form: formElement,
			fieldId: TASK_FIELD_IDS[field],
			message,
			toastId: "new-task-validation",
		});
	}

	async function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const submittedForm = event.currentTarget;
		if (wallet.status !== "connected") {
			revealFormError({
				form: submittedForm,
				message: t("请先连接发布者钱包并完成签名登录"),
				toastId: "new-task-validation",
			});
			return;
		}
		const normalizedTitle = title.trim();
		if (
			countCharacters(normalizedTitle) < 6 ||
			countCharacters(normalizedTitle) > 72
		) {
			rejectSubmit(submittedForm, "title", t("请输入 6–72 个字符的任务标题"));
			return;
		}
		// 用户只负责描述真实需求，不能为了满足服务端最小长度而由前端虚构正文。
		// 使用和领域校验一致的 Unicode 字符计数，让中文、英文和 emoji 的提示结果一致。
		if (countCharacters(description.trim()) < 30) {
			rejectSubmit(
				submittedForm,
				"description",
				t("请至少用 30 个字符描述目标、使用场景和必须满足的限制"),
			);
			return;
		}
		if (taxonomy.kind !== "loaded") {
			rejectSubmit(submittedForm, "categoryId", t("任务分类尚未加载完成"));
			return;
		}
		if (categoryId === UNSELECTED_CAPABILITY_CATEGORY_ID) {
			rejectSubmit(submittedForm, "categoryId", t("请选择服务分类"));
			return;
		}
		if (selectedTags.length === 0) {
			rejectSubmit(submittedForm, "tags", t("请至少选择一个技能标签"));
			return;
		}
		if (
			budgetMinor === null ||
			BigInt(budgetMinor) < MIN_USDC_BUSINESS_AMOUNT_MINOR ||
			BigInt(budgetMinor) > MAX_TASK_BUDGET_MINOR
		) {
			rejectSubmit(
				submittedForm,
				"budget",
				t("任务预算须在 1–100,000 USDC 之间，最多保留 6 位小数"),
			);
			return;
		}
		let deadlineIso: string;
		try {
			deadlineIso = localDateToDeadlineIso(deadline);
		} catch {
			rejectSubmit(submittedForm, "deadline", t("请选择有效截止时间"));
			return;
		}
		setValidationError(null);
		const input: TaskDraftInput = {
			title: normalizedTitle,
			description,
			acceptanceCriteria: structuredFields.acceptanceCriteria,
			deliverableFormat: structuredFields.deliverableFormat,
			categoryId,
			tags: selectedTags,
			pricing: { type: "fixed", amountMinor: budgetMinor },
			currency: MVP_CURRENCY,
			deadline: deadlineIso,
			requiredCapability: structuredFields.requiredCapability,
			attachments: [],
			visibility,
			// 正式工作流统一由平台自动选择每个阶段的 Agent；没有合格候选时服务端暂停，
			// 而不是把匹配算法和恢复策略暴露成发布表单里的额外决策。
			assignmentMode: {
				mode: "automatic",
				priceCapMinor: budgetMinor,
				rankingBasis: "active-ranking-rule",
				fallbackOnFail: "manual",
			},
			// 中间节点由工作流契约自动验收，最终节点仍由发布者人工验收；任务级模式因此
			// 保留 manual，避免终端 Coding 产物被旧的通用自动验收语义直接结算。
			acceptanceMode: { mode: "manual" },
		};

		let currentDraftId = draftId;
		try {
			setState({ kind: "saving" });
			if (currentDraftId === null) {
				const created = await createTaskDraft(input, createKey.current);
				currentDraftId = created.taskId;
				setDraftId(created.taskId);
			} else {
				await updateTaskDraft(currentDraftId, input, updateKey.current);
			}
			setState({ kind: "submitting" });
			await submitTask(currentDraftId, submitKey.current);
			router.push(`/tasks/${currentDraftId}`);
		} catch (error) {
			const apiError = error instanceof TaskApiRequestError ? error : null;
			const firstIssue = apiError?.body.issues?.[0];
			const targetField = firstIssue ? taskIssueField(firstIssue.field) : null;
			const message = apiError?.body.message ?? t("任务发布失败，请稍后重试");
			setState({
				kind: "error",
				message,
				issues:
					apiError?.body.issues?.map(
						(issue) => `${fieldLabel(issue.field, t)}: ${issue.message}`,
					) ?? [],
				draftId: currentDraftId,
			});
			if (targetField !== null && firstIssue !== undefined) {
				setValidationError({ field: targetField, message: firstIssue.message });
			}
			revealFormError({
				form: submittedForm,
				fieldId: targetField === null ? undefined : TASK_FIELD_IDS[targetField],
				message,
				toastId: "new-task-submit",
			});
		}
	}

	return (
		<main>
			<section className="page-hero border-b">
				<div className="scan-beam" aria-hidden />
				<div className="relative mx-auto max-w-[1280px] px-4 py-9 sm:px-6 lg:px-12">
					<div>
						<p className="cyber-kicker font-semibold text-secondary text-xs">
							POST A REQUEST · FIND YOUR AGENT
						</p>
						<h1 className="mt-2 font-bold text-3xl tracking-tight sm:text-5xl">
							{t("发布你的需求")}
						</h1>
						<p className="mt-2 text-muted-foreground">
							{t("告诉我们你想完成什么，平台会为你推荐合适的 Agent。")}
						</p>
						<ol className="mt-5 flex flex-wrap items-center gap-2 text-xs">
							{[t("填写需求"), t("托管预算"), t("选择 Agent")].map(
								(step, index) => (
									<li
										key={step}
										className="flex items-center gap-2 rounded-full border border-primary/20 bg-card/70 px-3 py-2 text-foreground backdrop-blur"
									>
										<span className="font-mono text-secondary">
											0{index + 1}
										</span>
										{step}
									</li>
								),
							)}
						</ol>
					</div>
				</div>
			</section>
			<form
				onSubmit={handleSubmit}
				className="mx-auto grid max-w-[1280px] items-start gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:px-12"
			>
				<div className="space-y-5">
					<FormSection
						number="01"
						title={t("描述你的需求")}
						description={t(
							"填写标题、详细需求、分类、标签、预算和截止时间即可开始",
						)}
						icon={Sparkles}
					>
						<Field
							label={t("任务标题")}
							htmlFor="task-title"
							hint={t("用一句话说明需要完成的任务")}
							error={
								validationError?.field === "title"
									? validationError.message
									: undefined
							}
						>
							<Input
								id="task-title"
								maxLength={72}
								placeholder={t("例如：开发一个电商后台管理系统")}
								value={title}
								aria-invalid={validationError?.field === "title"}
								aria-describedby={
									validationError?.field === "title"
										? "task-title-error"
										: undefined
								}
								onChange={(event) => {
									setTitle(event.target.value);
									markDirty();
								}}
							/>
						</Field>
						<Field
							label={t("详细需求")}
							htmlFor="task-description"
							hint={t("描述目标、使用场景和必须满足的限制")}
							error={
								validationError?.field === "description"
									? validationError.message
									: undefined
							}
						>
							<Textarea
								id="task-description"
								className="min-h-48 rounded-xl text-sm leading-6"
								placeholder={t(
									"例如：为跨境电商团队开发一个可管理商品、订单和权限的后台系统……",
								)}
								value={description}
								aria-invalid={validationError?.field === "description"}
								aria-describedby={
									validationError?.field === "description"
										? "task-description-error"
										: undefined
								}
								onChange={(event) => {
									setDescription(event.target.value);
									markDirty();
								}}
							/>
						</Field>
						<CapabilityTaxonomyFields
							idPrefix="task"
							state={taxonomy}
							categoryId={categoryId}
							selectedTags={selectedTags}
							onCategoryChange={(value) => {
								setCategoryId(value);
								markDirty();
							}}
							onTagsChange={(value) => {
								setSelectedTags(value);
								markDirty();
							}}
							categoryError={
								validationError?.field === "categoryId"
									? validationError.message
									: undefined
							}
							tagsError={
								validationError?.field === "tags"
									? validationError.message
									: undefined
							}
						/>
						<div className="grid gap-4 sm:grid-cols-2">
							<Field
								label={t("固定预算")}
								htmlFor="task-budget"
								hint={t(
									"这是你愿意托管的最高金额，已包含平台服务费，不会额外加收。",
								)}
								error={
									validationError?.field === "budget"
										? validationError.message
										: undefined
								}
							>
								<div className="relative">
									<Input
										id="task-budget"
										inputMode="decimal"
										placeholder={t("例如：50")}
										value={budget}
										aria-invalid={validationError?.field === "budget"}
										aria-describedby={
											validationError?.field === "budget"
												? "task-budget-error"
												: undefined
										}
										onChange={(event) => {
											setBudget(event.target.value);
											markDirty();
										}}
										className="pr-16"
									/>
									<span className="absolute top-3 right-3 text-muted-foreground text-sm">
										USDC
									</span>
								</div>
							</Field>
							<Field
								label={t("截止时间")}
								htmlFor="task-deadline"
								error={
									validationError?.field === "deadline"
										? validationError.message
										: undefined
								}
							>
								<DatePicker
									id="task-deadline"
									label={t("截止时间")}
									value={deadline}
									onChange={(value) => {
										setDeadline(value);
										markDirty();
									}}
									invalid={validationError?.field === "deadline"}
									aria-describedby={
										validationError?.field === "deadline"
											? "task-deadline-error"
											: undefined
									}
								/>
							</Field>
						</div>
						<div className="flex items-start gap-2 rounded-xl bg-warning/10 p-3 text-sm text-warning">
							<CalendarClock className="mt-0.5 size-4 shrink-0" />
							<p>{t("选择预计完成日期，当天结束前均可交付。")}</p>
						</div>
					</FormSection>

						<DisclosureSection
							icon={SlidersHorizontal}
							title={t("高级设置")}
							description={t("平台自动执行完整流程，最终交付由你验收")}
						open={advancedOpen}
						onToggle={() => setAdvancedOpen((current) => !current)}
						openLabel={t("收起高级设置")}
						closedLabel={t("展开高级设置")}
					>
							<Choice
							label={t("可见范围")}
							value={visibility}
							onChange={(value) => {
								setVisibility(value);
								markDirty();
							}}
							options={[
								[
									"public",
									t("公开任务"),
									t("托管后进入市场，不展示附件、身份和私密验收信息"),
								],
								[
									"private",
									t("私密任务"),
									t("仅发布者、已分配 Agent 和平台可信边界可见"),
								],
							]}
						/>
					</DisclosureSection>
				</div>

				<aside className="sticky top-28 space-y-4">
					<section className="cyber-panel cyber-corner rounded-2xl border p-5">
						<div className="flex items-center justify-between">
							<h2 className="font-semibold text-lg">{t("需求预览")}</h2>
							<span className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground text-xs">
								{draftId ? t("准备发布") : t("尚未发布")}
							</span>
						</div>
						<div className="mt-5 rounded-lg border border-primary/10 bg-accent/70 p-4">
							<p className="font-semibold leading-6">
								{title.trim() || t("填写任务标题后显示预览")}
							</p>
							<p className="mt-2 line-clamp-3 text-muted-foreground text-sm leading-5">
								{description}
							</p>
							<div className="mt-3 flex flex-wrap gap-1.5">
								{selectedTags.slice(0, 4).map((tag) => (
									<span
										key={tag}
										className="rounded-full bg-card px-2 py-1 text-xs"
									>
										{tag}
									</span>
								))}
								{selectedTags.length > 4 && (
									<span
										role="note"
										aria-label={t("另有 {count} 个技能标签", {
											count: selectedTags.length - 4,
										})}
										className="rounded-full border border-primary/20 bg-primary-container px-2 py-1 font-medium text-primary text-xs"
									>
										+{selectedTags.length - 4}
									</span>
								)}
							</div>
						</div>
						<dl className="mt-5 space-y-3 text-sm">
							<PreviewRow
								label={t("任务预算")}
								value={
									budgetMinor === null
										? t("格式无效")
										: formatMinorAmount(budgetMinor, MVP_CURRENCY)
								}
								strong
							/>
							<PreviewRow
								label={t("平台服务费")}
								value={t("成功结算时从 Agent 收入中扣除")}
							/>
							<PreviewRow label={t("预算外平台费用")} value="0 USDC" />
								<PreviewRow
									label={t("分配方式")}
									value={t("平台自动分配")}
								/>
								<PreviewRow
									label={t("验收方式")}
									value={t("中间阶段自动推进，最终交付由你验收")}
								/>
						</dl>
						<div className="mt-5 flex gap-2 rounded-lg border border-tertiary/20 bg-tertiary-container p-3">
							<LockKeyhole className="mt-0.5 size-4 shrink-0 text-tertiary" />
							<p className="text-tertiary-container-foreground text-xs leading-5">
								{t(
									"发布需求后，在任务详情页确认 USDC 托管。资金进入托管合约并完成链上确认后才开始匹配，验收前不会支付给 Agent。",
								)}
							</p>
						</div>
						{wallet.status === "connected" ? (
							<Button
								type="submit"
								size="lg"
								className="mt-5 w-full rounded-full shadow-[0_0_24px_var(--brand-glow)]"
								disabled={
									state.kind === "saving" ||
									state.kind === "submitting" ||
									taxonomy.kind !== "loaded"
								}
							>
								{state.kind === "saving" || state.kind === "submitting" ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									<Send className="size-4" />
								)}
								{state.kind === "saving"
									? t("正在准备任务")
									: state.kind === "submitting"
										? t("正在发布需求")
										: t("发布并继续托管")}
							</Button>
						) : (
							<Button
								type="button"
								size="lg"
								className="mt-5 w-full rounded-full shadow-[0_0_24px_var(--brand-glow)]"
								onClick={() => wallet.connect()}
								disabled={
									wallet.status === "checking" || wallet.status === "connecting"
								}
							>
								{wallet.status === "checking" ||
								wallet.status === "connecting" ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									<Wallet className="size-4" />
								)}
								{t("连接钱包后发布")}
							</Button>
						)}
						<p className="mt-3 text-center text-muted-foreground text-xs">
							{t("所有操作都会与你当前连接的钱包绑定")}
						</p>
					</section>
					<section className="cyber-panel rounded-xl border p-4">
						<p className="flex items-center gap-2 font-semibold text-sm">
							<CheckCircle2 className="size-4 text-success" />
							{t("发布保障")}
						</p>
						<ul className="mt-3 space-y-2 text-muted-foreground text-xs">
							<li className="flex gap-2">
								<Check className="size-3.5 text-success" />
								{t("预算金额会被精确记录")}
							</li>
							<li className="flex gap-2">
								<Check className="size-3.5 text-success" />
								{t("重复点击不会创建多个任务")}
							</li>
							<li className="flex gap-2">
								<Check className="size-3.5 text-success" />
								{t("发布前会自动整理并检查需求")}
							</li>
						</ul>
					</section>
				</aside>
			</form>
		</main>
	);
}

function FormSection({
	number,
	title,
	description,
	icon: Icon,
	children,
}: {
	number: string;
	title: string;
	description: string;
	icon: typeof Tags;
	children: React.ReactNode;
}) {
	return (
		<section className="cyber-panel cyber-corner rounded-2xl border">
			<header className="flex items-start gap-3 border-primary/15 border-b px-5 py-4">
				<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-container text-primary shadow-[0_0_18px_var(--brand-glow)]">
					<Icon className="size-4" />
				</span>
				<div>
					<div className="flex items-center gap-2">
						<span className="font-mono text-secondary text-xs">{number}</span>
						<h2 className="font-semibold">{title}</h2>
					</div>
					<p className="mt-1 text-muted-foreground text-xs">{description}</p>
				</div>
			</header>
			<div className="space-y-5 p-5">{children}</div>
		</section>
	);
}
function DisclosureSection({
	icon: Icon,
	title,
	description,
	open,
	onToggle,
	openLabel,
	closedLabel,
	children,
}: {
	icon: typeof Tags;
	title: string;
	description: string;
	open: boolean;
	onToggle(): void;
	openLabel: string;
	closedLabel: string;
	children: React.ReactNode;
}) {
	return (
		<section
			className={`cyber-panel overflow-hidden rounded-2xl border transition-colors ${open ? "border-primary/25" : "hover:border-primary/20"}`}
		>
			<button
				type="button"
				aria-expanded={open}
				aria-label={open ? openLabel : closedLabel}
				onClick={onToggle}
				className="flex min-h-20 w-full cursor-pointer items-center gap-3 px-5 py-4 text-left"
			>
				<span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-container text-primary">
					<Icon className="size-4" aria-hidden />
				</span>
				<span className="min-w-0 flex-1">
					<span className="block font-semibold">{title}</span>
					<span className="mt-1 block text-muted-foreground text-xs">
						{description}
					</span>
				</span>
				<ChevronDown
					className={`size-5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180 text-primary" : ""}`}
					aria-hidden
				/>
			</button>
			{open && (
				<div className="space-y-5 border-primary/15 border-t p-5">
					{children}
				</div>
			)}
		</section>
	);
}
function Field({
	label,
	htmlFor,
	hint,
	error,
	children,
}: {
	label: string;
	htmlFor: string;
	hint?: string;
	error?: string;
	children: React.ReactNode;
}) {
	return (
		<div>
			<Label htmlFor={htmlFor} className="mb-2 block font-semibold text-sm">
				{label}
			</Label>
			{children}
			{error ? (
				<p
					id={`${htmlFor}-error`}
					className="mt-1.5 text-destructive text-xs"
					role="alert"
				>
					{error}
				</p>
			) : (
				hint && <p className="mt-1.5 text-muted-foreground text-xs">{hint}</p>
			)}
		</div>
	);
}

function Choice<T extends string>({
	label,
	value,
	onChange,
	options,
}: {
	label: string;
	value: T;
	onChange(value: T): void;
	options: readonly (readonly [T, string, string])[];
}) {
	return (
		<fieldset>
			<legend className="mb-2 font-semibold text-sm">{label}</legend>
			<div className="grid gap-3 sm:grid-cols-2">
				{options.map(([option, title, description]) => (
					<label
						key={option}
						className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors ${value === option ? "border-primary bg-primary-container/50" : "hover:bg-accent"}`}
					>
						<input
							type="radio"
							className="mt-1 accent-primary"
							checked={value === option}
							onChange={() => onChange(option)}
						/>
						<span>
							<span className="block font-semibold text-sm">{title}</span>
							<span className="mt-1 block text-muted-foreground text-xs leading-5">
								{description}
							</span>
						</span>
					</label>
				))}
			</div>
		</fieldset>
	);
}
function PreviewRow({
	label,
	value,
	strong = false,
}: {
	label: string;
	value: string;
	strong?: boolean;
}) {
	return (
		<div className="flex justify-between gap-4">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className={`text-right ${strong ? "font-semibold" : ""}`}>{value}</dd>
		</div>
	);
}

type StructuredTaskFields = Readonly<{
	acceptanceCriteria: string;
	deliverableFormat: string;
	requiredCapability: string;
}>;

/**
 * 发布页只收集用户真正知道的信息。这里把同一份需求机械整理成旧任务 API 需要的
 * 结构化字段，既不调用模型，也不补写用户未表达的具体功能，避免把生成结果冒充事实。
 */
function buildStructuredTaskFields(
	description: string,
	categoryName: string,
	tags: readonly string[],
	locale: string,
): StructuredTaskFields {
	const english = locale === "en";
	const capabilitySource = tags.length > 0 ? tags.join(", ") : categoryName;

	return {
		acceptanceCriteria: english
			? "The final result must cover the goals, use cases, and explicit constraints in the detailed request, and remain reviewable by the client."
			: "最终结果需覆盖详细需求中描述的目标、使用场景和明确限制，并可由发布者逐项检查确认。",
		deliverableFormat: english
			? "A usable final deliverable, required source files, and concise usage instructions."
			: "可直接使用的最终交付物、必要源文件和简明使用说明。",
		requiredCapability:
			capabilitySource ||
			(english
				? "Professional capabilities required to complete the detailed request"
				: "完成详细需求所需的专业能力"),
	};
}

function countCharacters(value: string): number {
	return [...value].length;
}

function fieldLabel(
	field: string,
	t: ReturnType<typeof useLocale>["t"],
): string {
	const labels: Record<string, MessageId> = {
		title: "任务标题",
		description: "详细需求",
		acceptanceCriteria: "验收标准",
		deliverableFormat: "交付格式",
		categoryId: "服务分类",
		tags: "技能标签",
		pricing: "预算",
		deadline: "截止时间",
		requiredCapability: "所需能力",
	};
	return labels[field] === undefined ? field : t(labels[field]);
}

/** 服务端仍使用完整任务合同字段，这里把首个问题映射回快速发布页真实可编辑的控件。 */
function taskIssueField(field: string): TaskValidationField | null {
	const mapping: Readonly<Record<string, TaskValidationField>> = {
		title: "title",
		description: "description",
		acceptanceCriteria: "description",
		deliverableFormat: "description",
		categoryId: "categoryId",
		tags: "tags",
		pricing: "budget",
		deadline: "deadline",
		requiredCapability: "tags",
	};
	return mapping[field] ?? null;
}
