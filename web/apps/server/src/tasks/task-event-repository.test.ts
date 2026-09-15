import { describe, expect, it, vi } from "vitest";

import type { QueryExecutor } from "../db/pool";
import {
	emitTaskEvent,
	emitTaskEventToAgent,
	type TaskEventToEmit,
} from "./task-event-repository";

const EVENT: TaskEventToEmit = {
	taskId: "91000000-0000-4000-8000-000000000001",
	statusVersion: 3n,
	eventType: "task.execution_started",
	payload: { status: "executing" },
	createdAt: new Date("2026-09-03T08:00:00.000Z"),
};

/**
 * 这里验证的不是 PostgreSQL 语法细节，而是事件仓储最关键的收件人不变量：只有高级
 * AICP HMAC Agent 才接收生命周期 Webhook。快速 HTTP Agent 的同步结果由平台代管，
 * 如果遗漏这个过滤条件，平台会把事件错误 POST 到提供者的任务执行服务。
 */
describe("任务事件 Webhook 收件人", () => {
	it("任务级事件仅为 aicp_hmac Agent 创建 outbox", async () => {
		const query = vi.fn(async (_text: string, _params: readonly unknown[]) => ({
			rows: [],
			rowCount: 0,
		}));
		const db = { query } as unknown as QueryExecutor;

		await emitTaskEvent(db, EVENT);

		const [sql] = query.mock.calls[0] ?? [];
		expect(sql).toContain("agent.integration_mode='aicp_hmac'");
		expect(sql).toContain("agent_score_refresh_requests");
		expect(query.mock.calls[0]?.[1]?.[5]).toContain("task.rated");
	});

	it("指定工作流 Agent 的事件同样仅为 aicp_hmac Agent 创建 outbox", async () => {
		const query = vi.fn(async (_text: string, _params: readonly unknown[]) => ({
			rows: [],
			rowCount: 0,
		}));
		const db = { query } as unknown as QueryExecutor;
		const agentId = "91000000-0000-4000-8000-000000000002";

		await emitTaskEventToAgent(db, EVENT, agentId);

		const [sql, params] = query.mock.calls[0] ?? [];
		expect(sql).toContain("agent.integration_mode='aicp_hmac'");
		expect(params?.[5]).toBe(agentId);
		expect(params?.[6]).toContain("task.workflow_feedback_submitted");
	});
});
