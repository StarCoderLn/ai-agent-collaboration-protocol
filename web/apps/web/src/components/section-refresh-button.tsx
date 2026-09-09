"use client";

import { Button } from "@web/ui/components/button";
import { Loader2, RefreshCw } from "lucide-react";

/**
 * 卡片和列表头部的只读数据刷新入口。固定轮廓样式、尺寸、可见文案和加载反馈，
 * 避免各业务卡片各自选择纯图标或 ghost 样式。会修改业务状态的重试、返工和重新匹配
 * 不能使用这个组件。
 */
export default function SectionRefreshButton({
	label,
	ariaLabel = label,
	pending = false,
	disabled = false,
	onClick,
}: Readonly<{
	label: string;
	ariaLabel?: string;
	pending?: boolean;
	disabled?: boolean;
	onClick(): void;
}>) {
	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			className="shrink-0"
			aria-label={ariaLabel}
			aria-busy={pending || undefined}
			disabled={disabled || pending}
			onClick={onClick}
		>
			{pending ? (
				<Loader2
					data-icon="inline-start"
					className="animate-spin"
					aria-hidden
				/>
			) : (
				<RefreshCw data-icon="inline-start" aria-hidden />
			)}
			{label}
		</Button>
	);
}
