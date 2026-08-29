"use client";

import { Button } from "@web/ui/components/button";
import { Maximize2, Minimize2 } from "lucide-react";
import type { RefObject } from "react";

import { useFullscreenTarget } from "@/components/fullscreen/use-fullscreen-target";
import { useLocale } from "@/components/i18n/locale-provider";

/**
 * 全屏状态属于浏览器，而不属于点击按钮本身：用户可以按 Esc、通过浏览器菜单退出，或由
 * 系统撤销全屏。因此这里统一监听 fullscreenchange，并始终用 fullscreenElement 与目标
 * 元素的真实关系刷新界面，避免按钮文案和实际状态脱节。
 */
export default function FullscreenToggleButton({
	targetRef,
}: {
	targetRef: RefObject<HTMLElement | null>;
}) {
	const { t } = useLocale();
	const { isFullscreen, syncFullscreenState, toggleFullscreen } =
		useFullscreenTarget(targetRef);

	const label = isFullscreen ? t("退出全屏") : t("全屏查看");
	const Icon = isFullscreen ? Minimize2 : Maximize2;

	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			className="cursor-pointer"
			aria-pressed={isFullscreen}
			onClick={() => {
				// 调用失败时仍以浏览器状态回正界面，避免产生未处理的 Promise 拒绝。
				void toggleFullscreen().catch(syncFullscreenState);
			}}
		>
			<Icon className="size-4" />
			{label}
		</Button>
	);
}
