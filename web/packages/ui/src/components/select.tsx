"use client";

import { Select } from "@base-ui/react/select";
import { cn } from "@web/ui/lib/utils";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import type { ReactNode } from "react";

export type SelectFieldOption = Readonly<{
	value: string;
	label: ReactNode;
	disabled?: boolean;
}>;

type SelectFieldProps = Readonly<{
	id?: string;
	value: string;
	onValueChange(value: string): void;
	options: readonly SelectFieldOption[];
	className?: string;
	"aria-label"?: string;
	"aria-invalid"?: boolean;
	"aria-describedby"?: string;
	disabled?: boolean;
	name?: string;
}>;

/**
 * shadcn 风格的统一 Select 字段。
 *
 * 原生 select 的弹层由操作系统绘制，无法可靠匹配产品主题。这个共享组件基于
 * Base UI（项目现有 shadcn 组件使用的交互底座）封装键盘、焦点和读屏行为，
 * 调用方只需提供受控值与选项，无需重复理解浮层定位和可访问性细节。
 */
function SelectField({
	id,
	value,
	onValueChange,
	options,
	className,
	"aria-label": ariaLabel,
	"aria-invalid": ariaInvalid,
	"aria-describedby": ariaDescribedBy,
	disabled = false,
	name,
}: SelectFieldProps) {
	return (
		<Select.Root
			items={options}
			value={value}
			disabled={disabled}
			name={name}
			onValueChange={(nextValue) => {
				if (nextValue !== null) onValueChange(nextValue);
			}}
		>
			<Select.Trigger
				id={id}
				aria-label={ariaLabel}
				aria-invalid={ariaInvalid}
				aria-describedby={ariaDescribedBy}
				className={cn(
					"group flex h-11 w-full select-none items-center justify-between gap-3 rounded-sm border border-primary/25 bg-card/85 px-3 text-left text-foreground text-sm shadow-[inset_0_1px_0_rgb(255_255_255/0.05),0_8px_24px_rgb(0_0_0/0.12)] outline-none transition-[border-color,background-color,box-shadow] hover:not-data-disabled:border-primary/55 hover:not-data-disabled:bg-primary-container/25 focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/25 data-disabled:cursor-not-allowed data-popup-open:border-primary data-popup-open:bg-primary-container/30 data-disabled:opacity-55 data-popup-open:shadow-[0_0_24px_var(--brand-glow)]",
					className,
				)}
			>
				<Select.Value className="min-w-0 flex-1 truncate" />
				<Select.Icon className="shrink-0 text-primary transition-transform duration-200 group-data-popup-open:rotate-180">
					<ChevronDown className="size-4" aria-hidden />
				</Select.Icon>
			</Select.Trigger>

			<Select.Portal>
				<Select.Positioner
					className="z-[100] select-none outline-none"
					sideOffset={7}
					alignItemWithTrigger={false}
				>
					<Select.Popup className="min-w-[var(--anchor-width)] origin-[var(--transform-origin)] overflow-hidden rounded-xl border border-primary/30 bg-popover/95 p-1.5 text-popover-foreground shadow-[0_18px_55px_rgb(0_0_0/0.48),0_0_30px_var(--brand-glow),inset_0_1px_0_rgb(255_255_255/0.08)] outline-none backdrop-blur-xl transition-[transform,scale,opacity] duration-150 data-ending-style:translate-y-1 data-starting-style:-translate-y-1 data-ending-style:scale-95 data-starting-style:scale-95 data-ending-style:opacity-0 data-starting-style:opacity-0">
						<Select.ScrollUpArrow className="flex h-7 w-full cursor-default items-center justify-center rounded-md bg-popover text-primary shadow-[0_8px_12px_rgb(0_0_0/0.2)]">
							<ChevronUp className="size-4" aria-hidden />
						</Select.ScrollUpArrow>

						<Select.List className="max-h-[min(20rem,var(--available-height))] scroll-py-1 overflow-y-auto overscroll-contain py-0.5 [scrollbar-color:var(--primary)_transparent] [scrollbar-width:thin]">
							{options.map((option) => (
								<Select.Item
									key={option.value}
									value={option.value}
									disabled={option.disabled}
									className="grid min-h-10 cursor-pointer grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-2 rounded-lg px-2.5 py-2 text-sm outline-none transition-[background-color,color,box-shadow] data-disabled:cursor-not-allowed data-highlighted:bg-primary-container data-highlighted:text-primary-container-foreground data-selected:text-primary data-disabled:opacity-45 data-highlighted:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_28%,transparent)]"
								>
									<Select.ItemIndicator className="col-start-1 row-start-1 flex size-5 items-center justify-center rounded-md bg-primary/15 text-primary">
										<Check className="size-3.5" strokeWidth={2.5} aria-hidden />
									</Select.ItemIndicator>
									<Select.ItemText className="col-start-2 row-start-1 truncate">
										{option.label}
									</Select.ItemText>
								</Select.Item>
							))}
						</Select.List>

						<Select.ScrollDownArrow className="flex h-7 w-full cursor-default items-center justify-center rounded-md bg-popover text-primary shadow-[0_-8px_12px_rgb(0_0_0/0.2)]">
							<ChevronDown className="size-4" aria-hidden />
						</Select.ScrollDownArrow>
					</Select.Popup>
				</Select.Positioner>
			</Select.Portal>
		</Select.Root>
	);
}

export { SelectField };
