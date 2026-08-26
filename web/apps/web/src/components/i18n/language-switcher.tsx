"use client";

import { Check, Languages } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { AppLocale } from "@/lib/i18n/locale";
import { useLocale } from "./locale-provider";

// 语言名称使用本语言自称，避免用户切换前还需要先理解当前界面的翻译。
const localeOptions: ReadonlyArray<
	Readonly<{ locale: AppLocale; label: string; mark: string }>
> = [
	{ locale: "en", label: "English", mark: "EN" },
	{ locale: "zh-CN", label: "简体中文", mark: "中" },
];

export default function LanguageSwitcher() {
	const { locale, setLocale, t } = useLocale();
	const [open, setOpen] = useState(false);
	const menuId = useId();
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!open) return;

		const closeOnOutsideClick = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			setOpen(false);
			triggerRef.current?.focus();
		};

		document.addEventListener("pointerdown", closeOnOutsideClick);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOnOutsideClick);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [open]);

	const selectLocale = (nextLocale: AppLocale) => {
		setLocale(nextLocale);
		setOpen(false);
	};

	return (
		<div ref={rootRef} className="relative shrink-0">
			<button
				ref={triggerRef}
				type="button"
				className="flex size-10 cursor-pointer items-center justify-center rounded-xl border border-primary/20 bg-card/70 text-muted-foreground shadow-[0_0_18px_var(--brand-glow)] transition-[color,background-color,border-color,box-shadow] hover:border-primary/35 hover:bg-primary-container hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
				aria-label={t("切换语言")}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={menuId}
				title={t("切换语言")}
				onClick={() => setOpen((current) => !current)}
			>
				<Languages className="size-4.5" strokeWidth={1.7} aria-hidden />
			</button>

			{open && (
				<div
					id={menuId}
					role="menu"
					aria-label={t("切换语言")}
					className="surface-elevated absolute top-[calc(100%+10px)] right-0 z-50 grid w-48 gap-1 overflow-hidden rounded-xl border border-primary/20 p-1.5 shadow-[0_22px_60px_rgba(0,0,0,0.45)]"
				>
					{localeOptions.map((option) => {
						const active = locale === option.locale;
						return (
							<button
								key={option.locale}
								type="button"
								role="menuitemradio"
								aria-checked={active}
								className={`flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 text-left text-sm transition-colors ${active ? "bg-primary-container font-semibold text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
								onClick={() => selectLocale(option.locale)}
							>
								<span
									className={`flex size-7 shrink-0 items-center justify-center rounded-lg border font-bold text-[10px] ${active ? "border-primary/30 bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground"}`}
									aria-hidden
								>
									{option.mark}
								</span>
								<span className="flex-1">{option.label}</span>
								{active && (
									<Check
										className="size-4 shrink-0"
										strokeWidth={2}
										aria-hidden
									/>
								)}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}
