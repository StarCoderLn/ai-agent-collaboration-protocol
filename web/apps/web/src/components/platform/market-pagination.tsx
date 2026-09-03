"use client";

import { Button } from "@web/ui/components/button";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";

import { useLocale } from "@/components/i18n/locale-provider";

type PageItem = number | "gap-start" | "gap-end";

type MarketPaginationProps = Readonly<{
	page: number;
	pageSize: number;
	total: number;
	onPageChange: (page: number) => void;
}>;

/**
 * 两个公开市场共用同一套分页交互，避免页码窗口、禁用条件和无障碍名称在页面间漂移。
 * 组件只负责展示和发出目标页码；数据请求、筛选重置及滚动位置仍由所属市场控制。
 */
export function MarketPagination({
	page,
	pageSize,
	total,
	onPageChange,
}: MarketPaginationProps) {
	const { t } = useLocale();
	const totalPages = Math.ceil(total / pageSize);
	if (totalPages <= 1) return null;

	const currentPage = Math.min(Math.max(page, 1), totalPages);
	const items = paginationItems(currentPage, totalPages);

	return (
		<nav
			className="mt-8 flex flex-wrap items-center justify-between gap-4 border-primary/15 border-t pt-5"
			aria-label={t("列表分页")}
		>
			<p className="text-muted-foreground text-sm">
				{t("第 {page} / {total} 页", {
					page: currentPage,
					total: totalPages,
				})}
			</p>
			<div className="flex items-center gap-1.5">
				<Button
					variant="outline"
					size="sm"
					className="rounded-lg"
					disabled={currentPage === 1}
					onClick={() => onPageChange(currentPage - 1)}
					aria-label={t("上一页")}
				>
					<ChevronLeft className="size-4" aria-hidden />
					<span className="hidden sm:inline">{t("上一页")}</span>
				</Button>

				{items.map((item) =>
					typeof item === "number" ? (
						<Button
							key={item}
							variant={item === currentPage ? "default" : "outline"}
							size="sm"
							className="min-w-9 rounded-lg px-2.5"
							onClick={() => onPageChange(item)}
							aria-label={t("第 {page} 页", { page: item })}
							aria-current={item === currentPage ? "page" : undefined}
						>
							{item}
						</Button>
					) : (
						<span
							key={item}
							className="flex size-8 items-center justify-center text-muted-foreground"
							aria-hidden
						>
							<MoreHorizontal className="size-4" />
						</span>
					),
				)}

				<Button
					variant="outline"
					size="sm"
					className="rounded-lg"
					disabled={currentPage === totalPages}
					onClick={() => onPageChange(currentPage + 1)}
					aria-label={t("下一页")}
				>
					<span className="hidden sm:inline">{t("下一页")}</span>
					<ChevronRight className="size-4" aria-hidden />
				</Button>
			</div>
		</nav>
	);
}

/**
 * 页数较多时始终保留首尾页，并只展开当前页附近的页码。这样既能快速跳转，也不会让
 * 几十个按钮撑宽页面；返回值使用不同的 gap 标识，确保 React key 稳定且无重复。
 */
function paginationItems(currentPage: number, totalPages: number): PageItem[] {
	if (totalPages <= 7) {
		return Array.from({ length: totalPages }, (_, index) => index + 1);
	}

	const visible = new Set([1, totalPages]);
	for (
		let candidate = Math.max(2, currentPage - 1);
		candidate <= Math.min(totalPages - 1, currentPage + 1);
		candidate += 1
	) {
		visible.add(candidate);
	}
	const pages = [...visible].sort((left, right) => left - right);
	const output: PageItem[] = [];
	for (const pageNumber of pages) {
		const previous = output.at(-1);
		if (typeof previous === "number" && pageNumber - previous > 1) {
			output.push(previous === 1 ? "gap-start" : "gap-end");
		}
		output.push(pageNumber);
	}
	return output;
}
