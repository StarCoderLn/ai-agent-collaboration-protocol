import { describe, expect, it, vi } from "vitest";

import type { QueryExecutor } from "../db/pool";
import { PgScoringRepository } from "./scoring-repository";

const AGENT_ID = "92000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-15T06:00:00.000Z");

describe("PgScoringRepository 事件驱动刷新", () => {
	it("没有待处理请求时不读取规则或历史事实", async () => {
		const query = vi.fn(async (_sql: string, _params: readonly unknown[]) => ({
			rows: [],
			rowCount: 0,
		}));
		const repository = new PgScoringRepository({
			query,
		} as unknown as QueryExecutor);

		await expect(
			repository.computeRequestedSnapshots(100, NOW),
		).resolves.toEqual([]);
		expect(query).toHaveBeenCalledTimes(1);
		expect(query.mock.calls[0]?.[0]).toContain("FOR UPDATE SKIP LOCKED");
	});

	it("只为领取的 Agent 生成快照并在成功后删除刷新请求", async () => {
		const statements: string[] = [];
		const query = vi.fn(async (sql: string, _params: readonly unknown[]) => {
			statements.push(sql);
			if (sql.includes("FROM agent_score_refresh_requests"))
				return { rows: [{ id: AGENT_ID }], rowCount: 1 };
			if (sql.includes("FROM scoring_rule_versions"))
				return {
					rows: [
						{
							version: "score-v1",
							weights: {
								completionStrength: 25,
								qualityFeedback: 30,
								communicationExperience: 15,
								disputeReliability: 20,
								completedHistory: 10,
							},
							bayesian_prior: {
								priorMean: 3.5,
								priorWeight: 20,
								recentWindowDays: 90,
								historySaturationScale: 3,
							},
							half_life_seconds: "7776000",
						},
					],
					rowCount: 1,
				};
			if (sql.includes("FROM task_ratings legacy"))
				return {
					rows: [
						{
							id: "rating-1",
							task_id: "task-1",
							quality: 5,
							communication: 4,
							created_at: NOW,
						},
					],
					rowCount: 1,
				};
			if (sql.includes("FROM task_assignments assignment"))
				return {
					rows: [
						{
							id: "assignment-1",
							task_id: "task-1",
							assigned_at: new Date("2026-09-15T05:58:00.000Z"),
							responded_at: new Date("2026-09-15T05:59:00.000Z"),
							completed: true,
						},
					],
					rowCount: 1,
				};
			if (sql.includes("FROM arbitration_decisions decision"))
				return { rows: [], rowCount: 0 };
			return { rows: [], rowCount: 1 };
		});
		const repository = new PgScoringRepository({
			query,
		} as unknown as QueryExecutor);

		const snapshots = await repository.computeRequestedSnapshots(100, NOW);

		expect(snapshots).toHaveLength(1);
		expect(statements).toContainEqual(
			expect.stringContaining("INSERT INTO agent_score_snapshots"),
		);
		expect(statements.at(-1)).toContain(
			"DELETE FROM agent_score_refresh_requests",
		);
	});
});
