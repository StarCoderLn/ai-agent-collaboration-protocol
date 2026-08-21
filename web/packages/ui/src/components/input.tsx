import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "@web/ui/lib/utils";
import type * as React from "react";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
	return (
		<InputPrimitive
			type={type}
			data-slot="input"
			className={cn(
				// h-11 (44px) 满足 docs/DESIGN.md 可访问性「44px 最小可交互目标」；
				// rounded-sm 派生自全局 --radius，对应 DESIGN.md 表单控件 8px 圆角。
				"h-11 w-full min-w-0 rounded-sm border border-input bg-transparent px-2.5 py-1 text-sm outline-none transition-colors file:inline-flex file:h-6 file:border-0 file:bg-transparent file:font-medium file:text-foreground file:text-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 dark:disabled:bg-input/80",
				className,
			)}
			{...props}
		/>
	);
}

export { Input };
