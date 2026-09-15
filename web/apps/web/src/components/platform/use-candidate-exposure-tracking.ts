"use client";

import { useEffect, useRef } from "react";

import type { CandidateExposureInput } from "@/lib/api/tasks";

type ExposureSender = (input: CandidateExposureInput) => Promise<unknown>;

/**
 * 普通任务和工作流节点共享同一套真实曝光定义：候选卡至少 50% 可见并连续保持一秒。
 * Hook 只负责观察与有限重试，不推进任务状态；遥测失败不能阻塞用户选择 Agent。
 */
export function useCandidateExposureTracking(
	recordId: string | null,
	orderedAgentIds: readonly string[],
	send: ExposureSender,
) {
	// ref 让调用方把观察范围绑定到当前候选容器，避免扫描页面上其他 Agent 卡片。
	const containerRef = useRef<HTMLDivElement>(null);
	// 页面组件生命周期内固定一次会话 ID；服务端可区分真实重新进入与同会话网络重试。
	const viewSessionIdRef = useRef(crypto.randomUUID());
	// 本地集合在请求发出前即登记，防止 IntersectionObserver 抖动并发发送相同事实。
	const recordedExposureKeysRef = useRef(new Set<string>());
	// 数组引用可能每次渲染都变化，稳定字符串只在候选身份或排序改变时重建观察器。
	const orderFingerprint = orderedAgentIds.join("\u0000");

	// 候选身份或顺序变化后，DOM 卡片集合与曝光位置语义都会改变，因此必须重建观察器；
	// fingerprint 只承担失效标记，不应为了满足依赖分析而进入曝光请求。
	// biome-ignore lint/correctness/useExhaustiveDependencies: orderFingerprint 是观察器的显式失效键。
	useEffect(() => {
		const root = containerRef.current;
		if (
			root === null ||
			recordId === null ||
			typeof IntersectionObserver === "undefined"
		)
			return;
		// 每张卡独立计时；可见比例跌破 50% 就取消，不能累计多段短暂滚动时间。
		const timers = new Map<Element, ReturnType<typeof setTimeout>>();
		let disposed = false;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const element = entry.target as HTMLElement;
					const agentId = element.dataset.matchingAgentId;
					const position = Number(element.dataset.matchingPosition);
					if (agentId === undefined || !Number.isInteger(position)) continue;
					// 位置属于曝光事实的一部分；排序变化后同一 Agent 在新位置可形成新事实。
					const exposureKey = `${recordId}:${agentId}:${position}`;
					if (!entry.isIntersecting || entry.intersectionRatio < 0.5) {
						const pending = timers.get(element);
						if (pending !== undefined) clearTimeout(pending);
						timers.delete(element);
						continue;
					}
					if (
						timers.has(element) ||
						recordedExposureKeysRef.current.has(exposureKey)
					)
						continue;
					timers.set(
						element,
						setTimeout(() => {
							timers.delete(element);
							recordedExposureKeysRef.current.add(exposureKey);
							const eventKey = `matching-exposure:${viewSessionIdRef.current}:${exposureKey}`;
							const input: CandidateExposureInput = {
								distributionRecordId: recordId,
								viewSessionId: viewSessionIdRef.current,
								agentId,
								eventKey,
								position,
								visibleMillis: 1000,
								occurredAt: new Date().toISOString(),
							};
							// 遥测与 UI 主流程解耦；失败不阻塞点击，重试由稳定 eventKey 保证幂等。
							void sendWithRetry(input, send, () => disposed);
						}, 1000),
					);
				}
			},
			{ threshold: [0.5] },
		);
		for (const element of root.querySelectorAll("[data-matching-agent-id]"))
			observer.observe(element);
		return () => {
			// 卸载后停止计时和重试，避免旧任务页面向新页面会话补发过期曝光。
			disposed = true;
			observer.disconnect();
			for (const timer of timers.values()) clearTimeout(timer);
		};
	}, [orderFingerprint, recordId, send]);

	return containerRef;
}

async function sendWithRetry(
	input: CandidateExposureInput,
	send: ExposureSender,
	isDisposed: () => boolean,
): Promise<void> {
	// 同一个 eventKey 最多发送三次，数据库会把网络重试收敛为一条不可变事实。短退避
	// 覆盖切页瞬间或服务启动抖动，同时避免遥测长期占用浏览器后台任务。
	for (const delay of [0, 500, 1500]) {
		if (isDisposed()) return;
		if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
		try {
			await send(input);
			return;
		} catch {
			// 最终失败留给新的页面会话重新产生曝光，不把遥测异常展示为选人错误。
		}
	}
}
