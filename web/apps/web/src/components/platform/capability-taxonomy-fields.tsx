"use client";

import { Label } from "@web/ui/components/label";
import { SelectField } from "@web/ui/components/select";
import { Skeleton } from "@web/ui/components/skeleton";
import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useLocale } from "@/components/i18n/locale-provider";
import {
	listTaskCategories,
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
	  }>
	| Readonly<{ kind: "error"; message: string }>;

/**
 * 上架 Agent 和发布任务必须读取同一棵分类树。标签由用户按真实需求填写，服务端仍
 * 负责同义词归一与禁用词校验；页面不再把缺少上下文的全量技术词表展示给普通用户。
 */
export function useCapabilityTaxonomy(): CapabilityTaxonomyState {
	const { t } = useLocale();
	const [state, setState] = useState<CapabilityTaxonomyState>({
		kind: "loading",
	});

	useEffect(() => {
		const controller = new AbortController();
		listTaskCategories(controller.signal)
			.then((categories) => {
				setState({
					kind: "loaded",
					categories,
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
							: t("服务分类加载失败"),
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

	/**
	 * 页面先做与服务端一致的基础规范化，让用户立即看到最终形式。平台词表的同义词
	 * 收敛仍发生在可信服务边界，避免前端缓存过期后产生两套不同的匹配语义。
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

		if (selectedTags.includes(normalized)) {
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

		onTagsChange([...selectedTags, normalized]);
		setCustomTagInput("");
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
						aria-invalid={categoryError !== undefined}
						aria-describedby={
							categoryError === undefined
								? undefined
								: `${categoryFieldId}-error`
						}
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
				hint={t("填写最能代表需求或 Agent 能力的技术、风格或专业标签")}
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
							aria-invalid={tagsError !== undefined}
							aria-describedby={
								tagsError === undefined ? undefined : `${tagsInputId}-error`
							}
							value={customTagInput}
							onChange={(event) => {
								setCustomTagInput(event.target.value);
								if (customTagError !== null) setCustomTagError(null);
							}}
							onKeyDown={(event) => {
								if (event.key !== "Enter") return;
								// 中文、日文等输入法会用回车确认正在组合的候选词。此时既不能
								// 提交标签，也不能阻止输入法完成上屏；229 兼容仍未正确暴露
								// isComposing 的部分 WebKit/旧版浏览器实现。
								if (event.nativeEvent.isComposing || event.keyCode === 229)
									return;
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
							{t("已添加 {count}/{max}", {
								count: selectedTags.length,
								max: MAX_MATCHING_TAG_COUNT,
							})}
						</span>
					</div>
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
				<p
					id={`${htmlFor}-error`}
					className="mt-1.5 text-destructive text-xs"
					role="alert"
				>
					{error}
				</p>
			) : (
				<p className="mt-1.5 text-muted-foreground text-xs">{hint}</p>
			)}
		</div>
	);
}
