"use client";

import {
	CalendarDays,
	Check,
	ChevronLeft,
	ChevronRight,
	Sparkles,
	X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useLocale } from "@/components/i18n/locale-provider";
import { formatLocalDateValue, parseLocalDate } from "@/lib/platform/deadline";

type DatePickerProps = Readonly<{
	id: string;
	label: string;
	value: string;
	onChange(value: string): void;
	disabled?: boolean;
	invalid?: boolean;
	"aria-describedby"?: string;
}>;

type DialogPosition = Readonly<{
	left: number;
	top: number;
	width: number;
	maxHeight: number;
}>;

/**
 * 站内统一的日期选择器。组件只暴露 YYYY-MM-DD，业务层负责把日期转换为精确截止
 * 时间；这样月历无需知道任务 API、时区存储或超时状态机，其他日期场景也能复用。
 */
export function DatePicker({
	id,
	label,
	value,
	onChange,
	disabled = false,
	invalid = false,
	"aria-describedby": ariaDescribedBy,
}: DatePickerProps) {
	const { locale, t } = useLocale();
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const selectedDate = useMemo(() => parseLocalDate(value), [value]);
	const [open, setOpen] = useState(false);
	const [draftDate, setDraftDate] = useState<Date | null>(selectedDate);
	const [visibleMonth, setVisibleMonth] = useState(() =>
		startOfMonth(selectedDate ?? new Date()),
	);
	const [dialogPosition, setDialogPosition] = useState<DialogPosition | null>(
		null,
	);

	useEffect(() => {
		if (!open) return;
		function handlePointerDown(event: PointerEvent) {
			const target = event.target as Node;
			if (
				!rootRef.current?.contains(target) &&
				!dialogRef.current?.contains(target)
			) {
				setOpen(false);
			}
		}
		function handleKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") setOpen(false);
		}
		document.addEventListener("pointerdown", handlePointerDown);
		document.addEventListener("keydown", handleKeyDown);
		const updatePosition = () => {
			const trigger = triggerRef.current;
			if (trigger === null) return;
			const rect = trigger.getBoundingClientRect();
			const viewportPadding = 16;
			const width = Math.min(368, window.innerWidth - viewportPadding * 2);
			const left = Math.min(
				Math.max(viewportPadding, rect.left),
				window.innerWidth - width - viewportPadding,
			);
			/*
			 * 月历通过 portal 脱离卡片的 stacking context；优先放在触发器下方，空间
			 * 不足时放到上方。估算高度只负责初始方向，max-height 仍保证小屏可滚动。
			 */
			const estimatedHeight = 448;
			const below = rect.bottom + 10;
			const above = rect.top - estimatedHeight - 10;
			// 固定导航始终保留可操作空间，月历不应为了向上展开而遮住全站入口。
			const safeTop = 80;
			const top =
				window.innerHeight - below >= estimatedHeight
					? below
					: Math.max(safeTop, above);
			setDialogPosition({
				left,
				top,
				width,
				maxHeight: window.innerHeight - top - viewportPadding,
			});
		};
		updatePosition();
		window.addEventListener("resize", updatePosition);
		window.addEventListener("scroll", updatePosition, true);
		dialogRef.current?.focus();
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown);
			document.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("resize", updatePosition);
			window.removeEventListener("scroll", updatePosition, true);
		};
	}, [open]);

	useEffect(() => {
		if (open && dialogPosition !== null) dialogRef.current?.focus();
	}, [dialogPosition, open]);

	const displayValue =
		selectedDate === null
			? t("请选择截止日期")
			: new Intl.DateTimeFormat(locale, {
					year: "numeric",
					month: "long",
					day: "numeric",
				}).format(selectedDate);
	const days = calendarDays(visibleMonth);
	const today = startOfDay(new Date());
	const weekdayLabels = weekdayNames(locale);

	function openPicker() {
		if (disabled) return;
		const initialDate = selectedDate ?? null;
		setDraftDate(initialDate);
		setVisibleMonth(startOfMonth(initialDate ?? new Date()));
		setOpen(true);
	}

	return (
		<div ref={rootRef} className="relative">
			<button
				ref={triggerRef}
				id={id}
				type="button"
				aria-label={label}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-invalid={invalid}
				aria-describedby={ariaDescribedBy}
				disabled={disabled}
				onClick={openPicker}
				className={`group flex h-11 w-full cursor-pointer items-center justify-between gap-3 rounded-lg border bg-background/45 px-3 text-left text-sm outline-none transition-[border-color,box-shadow,background-color] hover:border-primary/45 hover:bg-primary-container/20 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/25 ${open ? "border-primary bg-primary-container/25 shadow-[0_0_22px_var(--brand-glow)]" : "border-input"}`}
			>
				<span
					className={
						selectedDate === null ? "text-muted-foreground" : "font-medium"
					}
				>
					{displayValue}
				</span>
				<span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-primary/15 bg-primary-container/45 text-primary transition-colors group-hover:border-primary/35 group-hover:bg-primary-container">
					<CalendarDays className="size-4" aria-hidden />
				</span>
			</button>

			{open &&
				dialogPosition !== null &&
				createPortal(
					<div
						ref={dialogRef}
						role="dialog"
						aria-label={t("选择截止日期")}
						tabIndex={-1}
						style={dialogPosition}
						className="fixed z-100 overflow-y-auto rounded-2xl border border-primary/30 bg-[linear-gradient(145deg,rgba(26,17,45,0.99),rgba(10,7,19,0.99))] shadow-[0_24px_80px_rgba(0,0,0,0.55),0_0_42px_var(--brand-glow)] outline-none backdrop-blur-xl"
					>
						<div className="relative border-primary/15 border-b px-4 py-3">
							<div className="absolute inset-x-8 top-0 h-px bg-linear-to-r from-transparent via-primary to-transparent" />
							<div className="flex items-center justify-between gap-3">
								<button
									type="button"
									aria-label={t("上个月")}
									onClick={() => setVisibleMonth(addMonths(visibleMonth, -1))}
									className="flex size-9 cursor-pointer items-center justify-center rounded-lg border border-primary/15 bg-background/35 text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary-container hover:text-primary"
								>
									<ChevronLeft className="size-4" aria-hidden />
								</button>
								<div className="text-center">
									<p className="font-semibold text-sm">
										{new Intl.DateTimeFormat(locale, {
											year: "numeric",
											month: "long",
										}).format(visibleMonth)}
									</p>
									<p className="mt-0.5 flex items-center justify-center gap-1 text-[10px] text-primary uppercase tracking-[0.18em]">
										<Sparkles className="size-3" aria-hidden />
										{t("选择截止日期")}
									</p>
								</div>
								<button
									type="button"
									aria-label={t("下个月")}
									onClick={() => setVisibleMonth(addMonths(visibleMonth, 1))}
									className="flex size-9 cursor-pointer items-center justify-center rounded-lg border border-primary/15 bg-background/35 text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary-container hover:text-primary"
								>
									<ChevronRight className="size-4" aria-hidden />
								</button>
							</div>
						</div>

						<div className="p-4">
							<div className="grid grid-cols-7 gap-1" aria-hidden>
								{weekdayLabels.map((weekday, index) => (
									<span
										key={`${weekday}-${index}`}
										className="flex h-7 items-center justify-center font-medium text-[11px] text-muted-foreground"
									>
										{weekday}
									</span>
								))}
							</div>
							<div className="mt-1 grid grid-cols-7 gap-1">
								{days.map((date) => {
									const outsideMonth =
										date.getMonth() !== visibleMonth.getMonth();
									const unavailable = date.getTime() < today.getTime();
									const selected = sameDay(date, draftDate);
									const isToday = sameDay(date, today);
									const dateLabel = new Intl.DateTimeFormat(locale, {
										year: "numeric",
										month: "long",
										day: "numeric",
									}).format(date);
									return (
										<button
											key={formatLocalDateValue(date)}
											type="button"
											aria-label={t("选择 {date}", { date: dateLabel })}
											aria-pressed={selected}
											disabled={unavailable}
											onClick={() => {
												setDraftDate(date);
												if (outsideMonth) setVisibleMonth(startOfMonth(date));
											}}
											className={`relative flex aspect-square min-h-9 cursor-pointer items-center justify-center rounded-lg text-xs transition-[background-color,color,box-shadow,transform] hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-25 ${selected ? "bg-primary font-bold text-primary-foreground shadow-[0_0_18px_var(--brand-glow-strong)]" : outsideMonth ? "text-muted-foreground/50 hover:bg-primary-container/40 hover:text-foreground" : "text-foreground hover:bg-primary-container hover:text-primary"} ${isToday && !selected ? "text-secondary ring-1 ring-secondary/60" : ""}`}
										>
											{date.getDate()}
										</button>
									);
								})}
							</div>
						</div>

						<div className="flex items-center justify-between gap-3 border-primary/15 border-t bg-background/25 px-4 py-3">
							<p className="max-w-40 text-[11px] text-muted-foreground leading-4">
								{t("所选日期当天结束前为交付截止时间")}
							</p>
							<div className="flex gap-2">
								<button
									type="button"
									aria-label={t("取消选择截止日期")}
									onClick={() => setOpen(false)}
									className="flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-input px-3 text-muted-foreground text-xs transition-colors hover:border-primary/30 hover:bg-accent hover:text-foreground"
								>
									<X className="size-3.5" aria-hidden />
									{t("取消")}
								</button>
								<button
									type="button"
									aria-label={t("确认截止日期")}
									disabled={draftDate === null}
									onClick={() => {
										if (draftDate === null) return;
										onChange(formatLocalDateValue(draftDate));
										setOpen(false);
									}}
									className="flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 font-semibold text-primary-foreground text-xs shadow-[0_0_18px_var(--brand-glow)] transition-[filter,box-shadow] hover:shadow-[0_0_26px_var(--brand-glow-strong)] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
								>
									<Check className="size-3.5" aria-hidden />
									{t("确定")}
								</button>
							</div>
						</div>
					</div>,
					document.body,
				)}
		</div>
	);
}

function startOfDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfMonth(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, amount: number): Date {
	return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

/** 固定渲染六周，月份切换时弹层高度不跳动。 */
function calendarDays(month: Date): readonly Date[] {
	const first = startOfMonth(month);
	const start = new Date(
		first.getFullYear(),
		first.getMonth(),
		1 - first.getDay(),
	);
	return Array.from(
		{ length: 42 },
		(_, index) =>
			new Date(start.getFullYear(), start.getMonth(), start.getDate() + index),
	);
}

function sameDay(left: Date, right: Date | null): boolean {
	return (
		right !== null &&
		left.getFullYear() === right.getFullYear() &&
		left.getMonth() === right.getMonth() &&
		left.getDate() === right.getDate()
	);
}

function weekdayNames(locale: string): readonly string[] {
	const formatter = new Intl.DateTimeFormat(locale, { weekday: "narrow" });
	// 2024-01-07 是星期日；显式日期让不同运行环境都得到 Sunday-first 顺序。
	return Array.from({ length: 7 }, (_, index) =>
		formatter.format(new Date(2024, 0, 7 + index)),
	);
}
