"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type SceneStatus = "loading" | "ready" | "fallback";

interface AgentNetworkSceneProps {
	ariaLabel: string;
	loadingLabel: string;
	fallbackLabel: string;
}

/**
 * 首页 3D 场景的 React 边界。Babylon.js 只在浏览器进入此组件后才动态下载，服务端
 * 渲染与首屏文字不依赖 WebGL；初始化失败时保留同一空间和静态网络背景，不让核心
 * CTA 因浏览器能力、节能模式或驱动问题消失。
 */
export default function AgentNetworkScene({
	ariaLabel,
	loadingLabel,
	fallbackLabel,
}: AgentNetworkSceneProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [status, setStatus] = useState<SceneStatus>("loading");
	const [loaderHost, setLoaderHost] = useState<HTMLElement | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) {
			return;
		}

		// 加载提示挂到模型的同一构图锚点，避免全屏画布中心与右侧场景中心错位。
		const anchor = canvas
			.closest("section")
			?.querySelector(".hero-network-shell");
		if (anchor instanceof HTMLElement) setLoaderHost(anchor);

		let disposed = false;
		let disposeRuntime: (() => void) | undefined;

		void import("./agent-network-runtime")
			.then(({ createAgentNetworkRuntime }) => {
				if (disposed) {
					return;
				}
				const runtime = createAgentNetworkRuntime(canvas);
				disposeRuntime = runtime.dispose;
				setStatus("ready");
			})
			.catch(() => {
				if (!disposed) {
					setStatus("fallback");
				}
			});

		return () => {
			disposed = true;
			disposeRuntime?.();
		};
	}, []);

	return (
		<div
			className="agent-network-scene"
			data-scene-status={status}
			role="img"
			aria-label={status === "fallback" ? fallbackLabel : ariaLabel}
		>
			<div className="agent-network-static" aria-hidden />
			<canvas ref={canvasRef} className="agent-network-canvas" aria-hidden />
			{status === "loading" &&
				loaderHost &&
				createPortal(
					<div className="agent-network-loader" role="status">
						<span className="agent-network-loader-label">{loadingLabel}</span>
						{/* 动态导入不提供可靠的百分比，使用循环流光表达进行中，不伪造进度。 */}
						<span className="agent-network-loader-track" aria-hidden>
							<span className="agent-network-loader-beam" />
						</span>
					</div>,
					loaderHost,
				)}
			{status === "fallback" && (
				<span className="sr-only">{fallbackLabel}</span>
			)}
		</div>
	);
}
