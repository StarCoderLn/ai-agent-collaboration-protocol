"use client";

import { Label } from "@web/ui/components/label";
import { SelectField } from "@web/ui/components/select";
import { Skeleton } from "@web/ui/components/skeleton";
import { Check, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useLocale } from "@/components/i18n/locale-provider";
import {
	listTaskCategories,
	suggestTaskTags,
	TaskApiRequestError,
	type TaskCategory,
} from "@/lib/api/tasks";
import { listSelectableCapabilityCategories } from "@/lib/platform/capability-categories";
import {
	isMatchingTagSyntaxValid,
	MAX_MATCHING_TAG_COUNT,
	MAX_MATCHING_TAG_LENGTH,
	normalizeMatchingTag,
} from "@/lib/platform/matching-tags";

/**
 * 分类是 Agent 与任务之间的匹配硬条件。使用显式哨兵值可以让下拉框展示占位项，
 * 同时防止任何页面把服务端返回的第一个分类静默当成用户选择。
 */
export const UNSELECTED_CAPABILITY_CATEGORY_ID =
	"__unselected_capability_category__";

export type CapabilityTaxonomyState =
	| Readonly<{ kind: "loading" }>
	| Readonly<{
			kind: "loaded";
			categories: readonly TaskCategory[];
			tags: readonly string[];
	  }>
	| Readonly<{ kind: "error"; message: string }>;

/**
 * 上架 Agent 和发布任务必须读取同一套分类与平台推荐标签。这个 hook 是数据加载的
 * 唯一入口，避免两边推荐内容不同；用户自定义标签由下方共享组件按同一规则处理。
 */
export function useCapabilityTaxonomy(): CapabilityTaxonomyState {
	const { t } = useLocale();
	const [state, setState] = useState<CapabilityTaxonomyState>({
		kind: "loading",
	});

	useEffect(() => {
		const controller = new AbortController();
		Promise.all([
			listTaskCategories(controller.signal),
			suggestTaskTags("", controller.signal),
		])
			.then(([categories, suggestions]) => {
				setState({
					kind: "loaded",
					categories,
					tags: suggestions.map((item) => item.canonicalName),
				});
			})
			.catch((error: unknown) => {
				if (error instanceof DOMException && error.name === "AbortError")
					return;
				setState({
					kind: "error",
					message:
						error instanceof TaskApiRequestError
							? error.body.message
							: t("分类与标签加载失败"),
				});
			});

		return () => controller.abort();
	}, [t]);

	return state;
}

type CapabilityTaxonomyFieldsProps = Readonly<{
	idPrefix: string;
	state: CapabilityTaxonomyState;
	categoryId: string;
	selectedTags: readonly string[];
	onCategoryChange(categoryId: string): void;
	onTagsChange(tags: readonly string[]): void;
	categoryError?: string;
	tagsError?: string;
}>;

/**
 * 两个业务入口共用完整组件，而不是仅复用 CSS。这样文案、下拉行为、标签选择、
 * 加载态和错误态都只有一个权威实现，后续修改不会再次造成两边体验和语义分叉。
 */
export function CapabilityTaxonomyFields({
	idPrefix,
	state,
	categoryId,
	selectedTags,
	onCategoryChange,
	onTagsChange,
	categoryError,
	tagsError,
}: CapabilityTaxonomyFieldsProps) {
	const { t } = useLocale();
	const [customTagInput, setCustomTagInput] = useState("");
	const [customTagError, setCustomTagError] = useState<string | null>(null);
	const categoryOptions = useMemo(
		() =>
			state.kind === "loaded"
				? listSelectableCapabilityCategories(state.categories, t)
				: [],
		[state, t],
	);
	const categoryFieldId = `${idPrefix}-capability-category`;
	const tagsInputId = `${idPrefix}-custom-tag`;
	const recommendedTags = state.kind === "loaded" ? state.tags : [];
	const recommendedByNormalized = useMemo(
		() =>
			new Map(
				recommendedTags.map((tag) => [normalizeMatchingTag(tag), tag] as const),
			),
		[recommendedTags],
	);

	/**
	 * 推荐标签与自定义标签进入同一数组。若用户输入的是平台标签的别名大小写形式，
	 * 优先保留平台 canonical 展示值；重复添加只清空输入，不制造错误或重复 chip。
	 */
	function addCustomTag() {
		const normalized = normalizeMatchingTag(customTagInput);
		if (normalized.length === 0) {
			setCustomTagError(t("请输入要添加的标签"));
			return;
		}
		if ([...normalized].length > MAX_MATCHING_TAG_LENGTH) {
			setCustomTagError(
				t("每个标签最多 {count} 个字符", {
					count: MAX_MATCHING_TAG_LENGTH,
				}),
			);
			return;
		}
		if (!isMatchingTagSyntaxValid(normalized)) {
			setCustomTagError(t("标签不能包含逗号或控制字符"));
			return;
		}

		const canonical = recommendedByNormalized.get(normalized) ?? normalized;
		if (selectedTags.includes(canonical)) {
			setCustomTagInput("");
			setCustomTagError(null);
			return;
		}
		if (selectedTags.length >= MAX_MATCHING_TAG_COUNT) {
			setCustomTagError(
				t("最多选择 {count} 个技能标签", {
					count: MAX_MATCHING_TAG_COUNT,
				}),
			);
			return;
		}

		onTagsChange([...selectedTags, canonical]);
		setCustomTagInput("");
		setCustomTagError(null);
	}

	function toggleRecommendedTag(tag: string) {
		const selected = selectedTags.includes(tag);
		if (!selected && selectedTags.length >= MAX_MATCHING_TAG_COUNT) {
			setCustomTagError(
				t("最多选择 {count} 个技能标签", {
					count: MAX_MATCHING_TAG_COUNT,
				}),
			);
			return;
		}
		onTagsChange(
			selected
				? selectedTags.filter((item) => item !== tag)
				: [...selectedTags, tag],
		);
		setCustomTagError(null);
	}

	return (
		<div className="grid gap-4 sm:grid-cols-2">
			<TaxonomyField
				label={t("服务分类")}
				htmlFor={categoryFieldId}
				hint={t("选择需要或能够提供的服务类型")}
				error={categoryError}
			>
				{state.kind === "loading" ? (
					<Skeleton className="h-11 w-full" />
				) : state.kind === "error" ? (
					<p
						className="rounded-xl border border-destructive/20 bg-destructive-container p-3 text-destructive text-sm"
						role="alert"
					>
						{state.message}
					</p>
				) : (
					<SelectField
						id={categoryFieldId}
						aria-label={t("服务分类")}
						value={categoryId}
						onValueChange={onCategoryChange}
						options={[
							{
								value: UNSELECTED_CAPABILITY_CATEGORY_ID,
								label: t("请选择服务分类"),
								disabled: true,
							},
							...categoryOptions.map((option) => ({
								value: option.id,
								label: option.label,
							})),
						]}
					/>
				)}
			</TaxonomyField>

			<TaxonomyField
				label={t("技能标签")}
				htmlFor={tagsInputId}
				hint={t("可选择平台推荐标签，也可输入自定义标签")}
				error={tagsError}
			>
				<fieldset className="space-y-3 rounded-xl border border-primary/20 bg-card/70 p-3">
					<legend className="sr-only">{t("技能标签")}</legend>
					{selectedTags.length > 0 && (
						<div className="flex flex-wrap gap-2">
							{selectedTags.map((tag) => (
								<span
									key={tag}
									className="inline-flex items-center gap-1 rounded-full border border-primary/35 bg-primary-container px-2.5 py-1 font-medium text-primary text-xs shadow-[0_0_12px_var(--brand-glow)]"
								>
									{tag}
									<button
										type="button"
										aria-label={t("移除标签 {tag}", { tag })}
										onClick={() => {
											onTagsChange(selectedTags.filter((item) => item !== tag));
											setCustomTagError(null);
										}}
										className="cursor-pointer rounded-full p-0.5 transition-colors hover:bg-primary/15"
									>
										<X className="size-3" aria-hidden />
									</button>
								</span>
							))}
						</div>
					)}

					<div className="flex gap-2">
						<input
							id={tagsInputId}
							value={customTagInput}
							onChange={(event) => {
								setCustomTagInput(event.target.value);
								if (customTagError !== null) setCustomTagError(null);
							}}
							onKeyDown={(event) => {
								if (event.key !== "Enter") return;
								event.preventDefault();
								addCustomTag();
							}}
							placeholder={t("输入自定义标签，按回车添加")}
							className="h-10 min-w-0 flex-1 rounded-lg border border-primary/15 bg-background/70 px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
						/>
						<button
							type="button"
							onClick={addCustomTag}
							className="inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-lg border border-primary/30 bg-primary-container px-3 font-medium text-primary text-sm transition-colors hover:bg-primary/15"
						>
							<Plus className="size-4" aria-hidden />
							{t("添加")}
						</button>
					</div>
					<div className="flex items-center justify-between gap-3 text-xs">
						<span
							className={
								customTagError ? "text-destructive" : "text-muted-foreground"
							}
							role={customTagError ? "alert" : undefined}
						>
							{customTagError ?? t("输入后按回车即可添加")}
						</span>
						<span className="shrink-0 text-muted-foreground">
							{t("已选择 {count}/{max}", {
								count: selectedTags.length,
								max: MAX_MATCHING_TAG_COUNT,
							})}
						</span>
					</div>

					{state.kind === "loading" ? (
						<Skeleton className="h-8 w-full" />
					) : state.kind === "loaded" && recommendedTags.length > 0 ? (
						<div>
							<p className="mb-2 font-medium text-muted-foreground text-xs">
								{t("平台推荐")}
							</p>
							<div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto pr-1">
								{recommendedTags.map((tag) => {
									const selected = selectedTags.includes(tag);
									return (
										<button
											key={tag}
											type="button"
											aria-pressed={selected}
											onClick={() => toggleRecommendedTag(tag)}
											className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-all ${selected ? "border-primary bg-primary-container text-primary shadow-[0_0_16px_var(--brand-glow)]" : "border-primary/15 bg-accent/70 text-muted-foreground hover:border-primary/40 hover:text-foreground"}`}
										>
											{selected && <Check className="size-3" aria-hidden />}
											{tag}
										</button>
									);
								})}
							</div>
						</div>
					) : (
						<span className="px-1 text-muted-foreground text-xs">
							{t("暂时没有推荐标签，你仍然可以添加自定义标签")}
						</span>
					)}
				</fieldset>
			</TaxonomyField>
		</div>
	);
}

/** 从同一棵服务端分类树读取展示名称，不在任一页面复制分类业务知识。 */
export function findCapabilityCategory(
	categories: readonly TaskCategory[],
	categoryId: string,
): TaskCategory | null {
	for (const category of categories) {
		if (category.id === categoryId) return category;
		const child = findCapabilityCategory(category.children, categoryId);
		if (child !== null) return child;
	}
	return null;
}

function TaxonomyField({
	label,
	htmlFor,
	hint,
	error,
	children,
}: Readonly<{
	label: string;
	htmlFor: string;
	hint: string;
	error?: string;
	children: React.ReactNode;
}>) {
	return (
		<div>
			<Label htmlFor={htmlFor} className="mb-2 block font-semibold text-sm">
				{label}
			</Label>
			{children}
			{error ? (
				<p className="mt-1.5 text-destructive text-xs" role="alert">
					{error}
				</p>
			) : (
				<p className="mt-1.5 text-muted-foreground text-xs">{hint}</p>
			)}
		</div>
	);
}
