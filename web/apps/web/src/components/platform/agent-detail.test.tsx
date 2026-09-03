import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AgentDetail from "./agent-detail";

const agentId = "83100000-0000-4000-8000-000000000001";
const agent = {
	id: agentId,
	name: "可信 Coding Agent",
	categoryId: "83100000-0000-4000-8000-000000000002",
	categoryName: "代码开发",
	provider: { label: "0x1234…5678" },
	description: "交付可验证的 TypeScript 代码",
	tags: ["TypeScript"],
	pricing: {
		type: "per_task",
		amountMinor: "2500000000000000",
		currency: "USDC",
	},
	status: "active",
	score: 4.1,
	sampleSize: 1,
	disputeRate: 0,
	completedCount: 1,
	successRate: 1,
	isNew: true,
	createdAt: "2026-08-23T00:00:00.000Z",
	updatedAt: "2026-08-23T01:00:00.000Z",
	verified: true,
	health: { status: "healthy", checkedAt: "2026-08-23T01:10:00.000Z" },
};
const score = {
	agentId,
	ruleVersion: "score-v1",
	score: 4.123,
	sampleSize: 1,
	disputeRate: 0,
	completedScale: Math.LN2,
	dimensions: {
		completionStrength: { recentValue: 5, lifetimeValue: 5, sampleSize: 1 },
		qualityFeedback: { recentValue: 3.57, lifetimeValue: 3.57, sampleSize: 1 },
		communicationExperience: {
			recentValue: 3.57,
			lifetimeValue: 3.57,
			sampleSize: 1,
		},
		disputeReliability: { recentValue: 5, lifetimeValue: 5, sampleSize: 0 },
		completedHistory: { recentValue: 0.8, lifetimeValue: 0.8, sampleSize: 1 },
	},
	systemMetrics: {
		responseTimeSeconds: {
			recentValue: 90,
			lifetimeValue: 120,
			recentSampleSize: 1,
			lifetimeSampleSize: 1,
		},
	},
	lowSample: true,
	computedAt: "2026-08-23T02:00:00.000Z",
	evidenceSummary: {
		ratingCount: 1,
		acceptedTaskCount: 1,
		respondedTaskCount: 1,
		completedTaskCount: 1,
		arbitrationDecisionCount: 0,
	},
};

describe("AgentDetail", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				return url.endsWith("/score")
					? Response.json(score)
					: Response.json({ agent });
			}),
		);
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("renders the real versioned score with recent, lifetime and low-sample evidence", async () => {
		render(<AgentDetail agentId={agentId} />);

		expect(await screen.findByText("可信 Coding Agent")).toBeInTheDocument();
		expect(screen.getByText("五维可信评分")).toBeInTheDocument();
		expect(screen.getByText("低样本 · 已校正")).toBeInTheDocument();
		expect(screen.getByText("完成强度")).toBeInTheDocument();
		expect(screen.getByText("质量反馈")).toBeInTheDocument();
		expect(screen.getByText("沟通体验")).toBeInTheDocument();
		expect(screen.getByText("争议可靠性")).toBeInTheDocument();
		expect(screen.getByText("历史完成规模")).toBeInTheDocument();
		expect(screen.getByText("系统响应时间")).toBeInTheDocument();
		expect(screen.getByText("1.5 分钟")).toBeInTheDocument();
		expect(screen.getByText("2.0 分钟")).toBeInTheDocument();
		expect(screen.getAllByText("近期")).toHaveLength(5);
		expect(screen.getAllByText("全周期")).toHaveLength(5);
		expect(screen.getAllByText(/规则 score-v1/)).toHaveLength(2);
		expect(screen.getByText(/原始 ID 仅供平台审计/)).toBeInTheDocument();
	});

	it("零样本时只展示暂无评分，不把冷启动先验描述成真实评价", async () => {
		const unratedAgent = {
			...agent,
			score: null,
			sampleSize: 0,
			completedCount: 0,
		};
		const unratedScore = {
			agentId,
			score: null,
			sampleSize: 0,
			lowSample: true,
			message: "尚无真实用户评分",
		};
		vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			return url.endsWith("/score")
				? Response.json(unratedScore)
				: Response.json({ agent: unratedAgent });
		});

		render(<AgentDetail agentId={agentId} />);

		expect(await screen.findAllByText("暂无评分")).not.toHaveLength(0);
		expect(
			screen.getByText("当前没有真实用户评分，平台不会用冷启动分数补位。"),
		).toBeInTheDocument();
		expect(screen.queryByText("3.5")).not.toBeInTheDocument();
	});
});
