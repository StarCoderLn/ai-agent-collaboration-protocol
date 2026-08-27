"use client";

import { toast } from "sonner";

type RevealFormErrorOptions = Readonly<{
	form: HTMLFormElement;
	message: string;
	fieldId?: string;
	toastId: string;
}>;

/**
 * 让提交错误出现在用户最需要处理的位置，避免同一条信息重复展示。
 *
 * React 的字段错误需要等下一次渲染才能带上 `aria-invalid`，因此这里延后两个动画帧
 * 再滚动和聚焦。有明确字段时，就地错误已经能够同时说明“哪里错了”和“如何修改”，
 * 不再重复弹出 Toast；只有钱包、网络或服务端整体失败等无法定位字段的错误才使用
 * Toast，保证用户在长页面任意位置都能立即看到。
 */
export function revealFormError({
	form,
	message,
	fieldId,
	toastId,
}: RevealFormErrorOptions): void {
	if (fieldId === undefined) {
		toast.error(message, { id: toastId, duration: 5_000 });
		return;
	}
	if (typeof window === "undefined") return;

	window.requestAnimationFrame(() => {
		window.requestAnimationFrame(() => {
			const candidate = document.getElementById(fieldId);
			if (!(candidate instanceof HTMLElement) || !form.contains(candidate))
				return;

			const reduceMotion = window.matchMedia?.(
				"(prefers-reduced-motion: reduce)",
			).matches;
			if (typeof candidate.scrollIntoView === "function") {
				candidate.scrollIntoView({
					behavior: reduceMotion ? "auto" : "smooth",
					block: "center",
					inline: "nearest",
				});
			}
			candidate.focus({ preventScroll: true });
		});
	});
}
