import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeAuthSessionExpired } from "@/lib/wallet/session-expiry";
import { formatMinorAmount } from "../platform/money";
import {
	AgentDirectoryRequestError,
	getAgentScore,
	getPublicAgent,
	listOwnedAgents,
	listPublicAgents,
	reviewAgent,
	transitionOwnedAgent,
} from "./agent-directory";

const agentId = "83100000-0000-4000-8000-000000000001";

const publicAgent = {
	id: agentId,
	name: "协议测试 Agent",
	categoryId: "83100000-0000-4000-8000-000000000002",
	categoryName: "代码开发",
	provider: { label: "0x1234…5678" },
	description: "输出可验证代码和测试证据",
	tags: ["TypeScript", "测试"],
	pricing: {
		type: "per_task",
		amountMinor: "900719925474099301",
		currency: "USDC",
	},
	status: "active",
	score: 4.8,
	sampleSize: 32,
	disputeRate: 0.02,
	completedCount: 47,
	successRate: 0.94,
	isNew: false,
	createdAt: "2026-08-23T00:00:00.000Z",
	updatedAt: "2026-08-23T01:00:00.000Z",
	verified: true,
	health: { status: "healthy", checkedAt: "2026-08-23T01:10:00.000Z" },
};

describe("Agent directory API client", () => {
	beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
	afterEach(() => vi.unstubAllGlobals());

	it("validates the public directory response before exposing it to UI", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			Response.json({ agents: [publicAgent], total: 1, limit: 9, offset: 0 }),
		);

		const page = await listPublicAgents({}, { limit: 9, offset: 0 });

		expect(page.agents).toHaveLength(1);
		expect(page.agents[0]?.successRate).toBe(0.94);
		expect(page.total).toBe(1);
		expect(fetch).toHaveBeenCalledWith(
			"https://business-api.test/api/market/agents?limit=9&offset=0",
			expect.objectContaining({
				headers: expect.objectContaining({ accept: "application/json" }),
			}),
		);
	});

	it("rejects a percentage-shaped success rate instead of rendering misleading data", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			Response.json({
				agents: [{ ...publicAgent, successRate: 94 }],
				total: 1,
				limit: 9,
				offset: 0,
			}),
		);

		await expect(
			listPublicAgents({}, { limit: 9, offset: 0 }),
		).rejects.toMatchObject({
			body: { error_code: "AGENT_DIRECTORY_INVALID_RESPONSE" },
		});
	});

	it("rejects a malformed route id without sending a network request", async () => {
		await expect(getPublicAgent("fixture-agent-id")).rejects.toBeInstanceOf(
			AgentDirectoryRequestError,
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("validates the versioned five-dimension score before the detail page consumes it", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			Response.json({
				agentId,
				ruleVersion: "score-v1",
				score: 4.123,
				sampleSize: 12,
				disputeRate: 0.05,
				completedScale: 2.3,
				dimensions: {
					completionStrength: {
						recentValue: 4.5,
						lifetimeValue: 4.4,
						sampleSize: 15,
					},
					qualityFeedback: {
						recentValue: 4.3,
						lifetimeValue: 4.1,
						sampleSize: 12,
					},
					communicationExperience: {
						recentValue: 4.2,
						lifetimeValue: 4,
						sampleSize: 12,
					},
					disputeReliability: {
						recentValue: 4.75,
						lifetimeValue: 4.75,
						sampleSize: 4,
					},
					completedHistory: {
						recentValue: 3.8,
						lifetimeValue: 3.8,
						sampleSize: 13,
					},
				},
				systemMetrics: {
					responseTimeSeconds: {
						recentValue: 90,
						lifetimeValue: 120,
						recentSampleSize: 5,
						lifetimeSampleSize: 15,
					},
				},
				lowSample: true,
				computedAt: "2026-08-23T02:00:00.000Z",
				evidenceSummary: {
					ratingCount: 12,
					acceptedTaskCount: 15,
					respondedTaskCount: 15,
					completedTaskCount: 13,
					arbitrationDecisionCount: 4,
				},
			}),
		);

		const score = await getAgentScore(agentId);

		expect(score).toMatchObject({
			ruleVersion: "score-v1",
			lowSample: true,
			sampleSize: 12,
		});
		expect(fetch).toHaveBeenCalledWith(
			`https://business-api.test/api/agents/${agentId}/score`,
			expect.objectContaining({ signal: undefined }),
		);
	});

	it("sends credentialed lifecycle commands with an idempotency key", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			Response.json({
				agentId,
				status: "paused",
				pauseReason: "manual",
				updatedAt: "2026-08-23T02:00:00.000Z",
			}),
		);

		await transitionOwnedAgent(agentId, "pause", "idem-agent-pause-1");

		expect(fetch).toHaveBeenCalledWith(
			`https://business-api.test/api/agents/${agentId}/pause`,
			expect.objectContaining({
				method: "POST",
				credentials: "include",
				headers: expect.objectContaining({
					"idempotency-key": "idem-agent-pause-1",
				}),
			}),
		);
	});

	it("Agent 私有接口返回 401 时同步撤下过期会话", async () => {
		const expired = vi.fn();
		const unsubscribe = subscribeAuthSessionExpired(expired);
		vi.mocked(fetch).mockResolvedValueOnce(
			Response.json(
				{
					error_code: "UNAUTHENTICATED",
					message: "登录会话已过期",
					retryable: false,
				},
				{ status: 401 },
			),
		);

		await expect(listOwnedAgents()).rejects.toMatchObject({ status: 401 });
		expect(expired).toHaveBeenCalledTimes(1);
		unsubscribe();
	});

	it("accepts a managed Agent response without the retired contact email", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			Response.json({
				agents: [
					{
						...publicAgent,
						providerWalletAddress: "0x1111111111111111111111111111111111111111",
						payoutWalletAddress: "0x2222222222222222222222222222222222222222",
						serviceEndpoint: "https://agent.example.com/run",
						pauseReason: null,
						health: {
							...publicAgent.health,
							consecutiveFailureCount: 0,
							consecutiveSuccessCount: 0,
							intervalSeconds: 300,
						},
					},
				],
			}),
		);

		const [agent] = await listOwnedAgents();

		expect(agent).toBeDefined();
		expect(agent).not.toHaveProperty("email");
	});

	it("submits a simple, auditable approve or reject decision without asking for a fake sandbox UUID", async () => {
		vi.mocked(fetch).mockImplementation(async () =>
			Response.json({
				agentId,
				status: "active",
				pauseReason: null,
				updatedAt: "2026-08-23T02:00:00.000Z",
			}),
		);

		await reviewAgent(
			agentId,
			"approve",
			"  基础资料和服务端点已经核验  ",
			"review-agent-approve-1",
		);
		await reviewAgent(
			agentId,
			"reject",
			"服务端点无法访问",
			"review-agent-reject-1",
		);

		expect(fetch).toHaveBeenNthCalledWith(
			1,
			`https://business-api.test/api/admin/agents/${agentId}/approve`,
			expect.objectContaining({
				method: "POST",
				credentials: "include",
				body: JSON.stringify({ reviewReason: "基础资料和服务端点已经核验" }),
			}),
		);
		expect(fetch).toHaveBeenNthCalledWith(
			2,
			`https://business-api.test/api/admin/agents/${agentId}/reject`,
			expect.objectContaining({
				body: JSON.stringify({ reviewReason: "服务端点无法访问" }),
			}),
		);
	});

	it("formats values above the JavaScript safe integer limit without losing minor units", () => {
		expect(formatMinorAmount("900719925474099301", "USDC")).toBe(
			"900,719,925,474.099301 USDC",
		);
	});
});
