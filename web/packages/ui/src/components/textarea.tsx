import { cn } from "@web/ui/lib/utils";
import type * as React from "react";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
	return (
		<textarea
			data-slot="textarea"
			className={cn(
				// 所有长文本输入统一使用 8px 以上圆角和正文级字号，避免业务页回退成脚手架直角控件。
				"field-sizing-content flex min-h-16 w-full resize-none rounded-lg border border-input bg-transparent px-3 py-2.5 text-sm outline-none transition-[border-color,box-shadow,background-color] placeholder:text-muted-foreground hover:border-primary/35 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/15 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 dark:disabled:bg-input/80",
				className,
			)}
			{...props}
		/>
	);
}

export { Textarea };
