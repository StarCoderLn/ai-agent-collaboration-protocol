import { describe, expect, it, vi } from "vitest";
import { Idempotency, type IdempotencyStore } from "../idempotency/idempotency-store";
import {
	createWorkflowFeedbackService,
	type WorkflowFeedbackRepository,
} from "./workflow-feedback-service";

const TASK_ID = "87000000-0000-4000-8000-000000000001";
const NODE_ID = "87000000-0000-4000-8000-000000000002";
const SUBMITTED_AT = new Date("2026-09-02T01:00:00.000Z");

describe("workflow feedback service", () => {
	it("训练授权没有文字反馈时在仓储写入前拒绝", async () => {
		const repository = repositoryStub();
		const service = createWorkflowFeedbackService(
			repository,
			new Idempotency(idempotencyStore()),
			() => SUBMITTED_AT,
		);

		await expect(service.submit(
			TASK_ID,
			NODE_ID,
			{
				quality: 5,
				communication: 5,
				strengths: [],
				allowModelTraining: true,
			},
			"publisher-1",
			"workflow-feedback-key-1",
		)).rejects.toMatchObject({
			statusCode: 422,
			code: "VALIDATION_FAILED",
		});
		expect(repository.submit).not.toHaveBeenCalled();
	});

	it("相同幂等键重放首次响应，不会重复写入 Agent 历史", async () => {
		const repository = repositoryStub();
		vi.mocked(repository.submit).mockResolvedValue({
			statusCode: 201,
			body: { feedbackId: "feedback-1" },
		});
		const service = createWorkflowFeedbackService(
			repository,
			new Idempotency(idempotencyStore()),
			() => SUBMITTED_AT,
		);
		const input = {
			quality: 5,
			communication: 4,
			comment: "结果可以直接体验。",
			strengths: ["usability"],
			allowModelTraining: false,
		};

		const first = await service.submit(
			TASK_ID,
			NODE_ID,
			input,
			"publisher-1",
			"workflow-feedback-key-2",
		);
		const replay = await service.submit(
			TASK_ID,
			NODE_ID,
			input,
			"publisher-1",
			"workflow-feedback-key-2",
		);

		expect(replay).toEqual(first);
		expect(repository.submit).toHaveBeenCalledTimes(1);
		expect(repository.submit).toHaveBeenCalledWith(
			TASK_ID,
			NODE_ID,
			"publisher-1",
			expect.objectContaining({ strengths: ["usability"] }),
			SUBMITTED_AT,
		);
	});
});

function repositoryStub(): WorkflowFeedbackRepository {
	return {
		submit: vi.fn(),
		list: vi.fn(),
	};
}

/**
 * 内存存储只模拟幂等契约本身：首次 reserve、commit 后重放快照。业务权限和数据库
 * 唯一约束由仓储集成测试覆盖，避免单元测试复制 PostgreSQL 行为。
 */
function idempotencyStore(): IdempotencyStore {
	const snapshots = new Map<string, { statusCode: number; body: unknown } | null>();
	return {
		reserve: vi.fn(async (key) => {
			if (!snapshots.has(key)) {
				snapshots.set(key, null);
				return { inserted: true, committed: false, snapshot: null };
			}
			const snapshot = snapshots.get(key) ?? null;
			return {
				inserted: false,
				committed: snapshot !== null,
				snapshot,
			};
		}),
		commitResponse: vi.fn(async (key, snapshot) => {
			snapshots.set(key, snapshot);
		}),
	};
}
