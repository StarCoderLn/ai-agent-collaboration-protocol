"use client";

import { type RefObject, useCallback, useEffect, useState } from "react";

/**
 * 统一管理某个页面区域的浏览器全屏状态。
 *
 * 全屏可能由按钮、Esc 或浏览器菜单结束，因此调用方不能只在点击时切换本地布尔值。
 * 本 Hook 以 document.fullscreenElement 为唯一事实来源，保证所有全屏入口的图标、文案
 * 与浏览器真实状态保持一致。
 */
export function useFullscreenTarget(
	targetRef: RefObject<HTMLElement | null>,
) {
	const [isFullscreen, setIsFullscreen] = useState(false);

	const syncFullscreenState = useCallback(() => {
		setIsFullscreen(document.fullscreenElement === targetRef.current);
	}, [targetRef]);

	useEffect(() => {
		syncFullscreenState();
		document.addEventListener("fullscreenchange", syncFullscreenState);
		return () =>
			document.removeEventListener("fullscreenchange", syncFullscreenState);
	}, [syncFullscreenState]);

	const toggleFullscreen = useCallback(async () => {
		const target = targetRef.current;
		if (target === null) return;

		if (document.fullscreenElement === target) {
			await document.exitFullscreen?.();
			return;
		}

		await target.requestFullscreen?.();
	}, [targetRef]);

	return { isFullscreen, syncFullscreenState, toggleFullscreen } as const;
}
