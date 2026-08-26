"use client";

import { Button } from "@web/ui/components/button";
import { Input } from "@web/ui/components/input";
import { Label } from "@web/ui/components/label";
import { Textarea } from "@web/ui/components/textarea";
import {
	AlertCircle,
	ArrowRight,
	CalendarClock,
	Check,
	CheckCircle2,
	ChevronDown,
	Loader2,
	LockKeyhole,
	SlidersHorizontal,
	Sparkles,
	type Tags,
	Wallet,
} from "lucide-react";
import Link from "next/link";
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
import type { MessageId } from "@/lib/i18n/messages";
import { localDateToDeadlineIso } from "@/lib/platform/deadline";
import {
	formatMinorAmount,
	MVP_CURRENCY,
	parseEthToWei,
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
export default function NewTaskForm() {
	const { locale, t } = useLocale();
	const router = useRouter();
	const wallet = useWalletSession();
	const taxonomy = useCapabilityTaxonomy();
	const [categoryId, setCategoryId] = useState(
		UNSELECTED_CAPABILITY_CATEGORY_ID,
	);
	const [selectedTags, setSelectedTags] = useState<readonly string[]>([]);
	const [description, setDescription] = useState("");
	const [budget, setBudget] = useState("");
	const [deadline, setDeadline] = useState("");
	const [visibility, setVisibility] = useState<"public" | "private">("public");
	const [assignmentMode, setAssignmentMode] = useState<"manual" | "automatic">(
		"manual",
	);
	const [acceptanceMode, setAcceptanceMode] = useState<"manual" | "automatic">(
		"manual",
	);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [state, setState] = useState<SubmitState>({ kind: "idle" });
	const [draftId, setDraftId] = useState<string | null>(null);
	const createKey = useRef(crypto.randomUUID());
	const updateKey = useRef(crypto.randomUUID());
	const submitKey = useRef(crypto.randomUUID());

	const budgetMinor = useMemo(() => parseEthToWei(budget), [budget]);
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
	}

	async function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (wallet.status !== "connected") {
			setState({
				kind: "error",
				message: t("请先连接发布者钱包并完成签名登录"),
				issues: [],
				draftId,
			});
			return;
		}
		if (taxonomy.kind !== "loaded") {
			setState({
				kind: "error",
				message: t("任务分类尚未加载完成"),
				issues: [],
				draftId,
			});
			return;
		}
		if (categoryId === UNSELECTED_CAPABILITY_CATEGORY_ID) {
			setState({
				kind: "error",
				message: t("请选择服务分类"),
				issues: [],
				draftId,
			});
			return;
		}
		// 用户只负责描述真实需求，不能为了满足服务端最小长度而由前端虚构正文。
		// 使用和领域校验一致的 Unicode 字符计数，让中文、英文和 emoji 的提示结果一致。
		if (countCharacters(description.trim()) < 30) {
			setState({
				kind: "error",
				message: t("请至少用 30 个字符描述目标、使用场景和必须满足的限制"),
				issues: [],
				draftId,
			});
			return;
		}
		if (selectedTags.length === 0) {
			setState({
				kind: "error",
				message: t("请至少选择一个技能标签"),
				issues: [],
				draftId,
			});
			return;
		}
		if (budgetMinor === null) {
			setState({
				kind: "error",
				message: t("预算必须是大于 0、最多 18 位小数的 ETH 金额"),
				issues: [],
				draftId,
			});
			return;
		}
		let deadlineIso: string;
		try {
			deadlineIso = localDateToDeadlineIso(deadline);
		} catch {
			setState({
				kind: "error",
				message: t("请选择有效截止时间"),
				issues: [],
				draftId,
			});
			return;
		}
		const input: TaskDraftInput = {
			title: structuredFields.title,
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
			assignmentMode:
				assignmentMode === "manual"
					? { mode: "manual" }
					: {
							mode: "automatic",
							priceCapMinor: budgetMinor,
							rankingBasis: "active-ranking-rule",
							fallbackOnFail: "manual",
						},
			acceptanceMode:
				acceptanceMode === "manual"
					? { mode: "manual" }
					: {
							mode: "automatic",
							acceptorId: "platform-default-acceptor",
							ruleVersion: "acceptance-v1",
						},
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
			setState({
				kind: "error",
				message: apiError?.body.message ?? t("任务发布失败，请稍后重试"),
				issues:
					apiError?.body.issues?.map(
						(issue) => `${fieldLabel(issue.field, t)}: ${issue.message}`,
					) ?? [],
				draftId: currentDraftId,
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
						description={t("填写需求、分类、标签、预算和截止时间即可开始")}
						icon={Sparkles}
					>
						<Field
							label={t("详细需求")}
							htmlFor="task-description"
							hint={t("描述目标、使用场景和必须满足的限制")}
						>
							<Textarea
								id="task-description"
								className="min-h-48 rounded-xl text-sm leading-6"
								placeholder={t(
									"例如：为跨境电商团队开发一个可管理商品、订单和权限的后台系统……",
								)}
								value={description}
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
						/>
						<div className="grid gap-4 sm:grid-cols-2">
							<Field
								label={t("固定预算")}
								htmlFor="task-budget"
								hint={t("预算将通过托管保护，验收完成后才支付给 Agent。")}
							>
								<div className="relative">
									<Input
										id="task-budget"
										inputMode="decimal"
										placeholder="0.01"
										value={budget}
										onChange={(event) => {
											setBudget(event.target.value);
											markDirty();
										}}
										className="pr-16"
									/>
									<span className="absolute top-3 right-3 text-muted-foreground text-sm">
										ETH
									</span>
								</div>
							</Field>
							<Field label={t("截止时间")} htmlFor="task-deadline">
								<DatePicker
									id="task-deadline"
									label={t("截止时间")}
									value={deadline}
									onChange={(value) => {
										setDeadline(value);
										markDirty();
									}}
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
						description={t("默认采用人工选择、人工验收和公开任务")}
						open={advancedOpen}
						onToggle={() => setAdvancedOpen((current) => !current)}
						openLabel={t("收起高级设置")}
						closedLabel={t("展开高级设置")}
					>
						<Choice
							label={t("候选选择")}
							value={assignmentMode}
							onChange={(value) => {
								setAssignmentMode(value);
								markDirty();
							}}
							options={[
								[
									"manual",
									t("我来选择"),
									t("查看候选的质量、成本和时长后确认"),
								],
								[
									"automatic",
									t("平台自动分配"),
									t("平台会在预算内选择最合适的候选；没有合适结果时再由你选择。"),
								],
							]}
						/>
						<Choice
							label={t("结果验收")}
							value={acceptanceMode}
							onChange={(value) => {
								setAcceptanceMode(value);
								markDirty();
							}}
							options={[
								[
									"manual",
									t("人工验收"),
									t("确认交付后才进入结算，适合大多数任务"),
								],
								[
									"automatic",
									t("规则自动验收"),
									t("仅适用于已经配置机器验收规则的任务"),
								],
							]}
						/>
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

					{state.kind === "error" && (
						<div
							role="alert"
							className="flex gap-3 rounded-lg border border-destructive/20 bg-destructive-container p-4 text-destructive"
						>
							<AlertCircle className="mt-0.5 size-4 shrink-0" />
							<div>
								<p className="font-semibold text-sm">{state.message}</p>
								{state.issues.length > 0 && (
									<ul className="mt-2 list-disc space-y-1 pl-4 text-xs">
										{state.issues.map((issue) => (
											<li key={issue}>{issue}</li>
										))}
									</ul>
								)}
								{state.draftId && (
									<p className="mt-2 text-xs">
										{t("你的填写内容已保留，可以直接重试。")}
									</p>
								)}
							</div>
						</div>
					)}
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
								{structuredFields.title || t("填写详细需求后自动生成标题")}
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
								label={t("平台手续费")}
								value={t("发布时自动计算，并在付款前展示")}
							/>
							<PreviewRow
								label={t("分配方式")}
								value={
									assignmentMode === "manual"
										? t("手动选择候选")
										: t("平台自动分配")
								}
							/>
							<PreviewRow
								label={t("验收方式")}
								value={
									acceptanceMode === "manual"
										? t("发布者人工验收")
										: t("规则自动验收")
								}
							/>
						</dl>
						<div className="mt-5 flex gap-2 rounded-lg border border-tertiary/20 bg-tertiary-container p-3">
							<LockKeyhole className="mt-0.5 size-4 shrink-0 text-tertiary" />
							<p className="text-tertiary-container-foreground text-xs leading-5">
								{t(
									"发布需求不会立即付款。确认预算后，平台才会开始匹配 Agent。",
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
									<CheckCircle2 className="size-4" />
								)}
								{state.kind === "saving"
									? t("正在准备任务")
									: state.kind === "submitting"
										? t("正在发布需求")
										: t("发布需求")}
								<ArrowRight className="size-4" />
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
	children,
}: {
	label: string;
	htmlFor: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<div>
			<Label htmlFor={htmlFor} className="mb-2 block font-semibold text-sm">
				{label}
			</Label>
			{children}
			{hint && <p className="mt-1.5 text-muted-foreground text-xs">{hint}</p>}
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
	title: string;
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
	const normalized = description.replace(/\s+/g, " ").trim();
	const firstStatement = normalized.split(/[。！？!?\n]/u)[0]?.trim() ?? "";
	const titleSource =
		countCharacters(firstStatement) >= 6 ? firstStatement : normalized;
	const title = takeCharacters(titleSource.replace(/[，,；;：:]$/u, ""), 72);
	const english = locale === "en";
	const capabilitySource = tags.length > 0 ? tags.join(", ") : categoryName;

	return {
		title,
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

function takeCharacters(value: string, maximum: number): string {
	return [...value].slice(0, maximum).join("");
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
