import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acceptTaskResult,
	confirmTaskCandidate,
	createTaskDraft,
	getTaskAcceptancePreview,
	getTaskCandidates,
	getTaskPreview,
	getTaskWorkflow,
	listOwnedTasks,
	listPublicTasks,
	listTaskCategories,
	prepareTaskEscrow,
	subscribeTaskEvents,
	TaskApiRequestError,
} from "./tasks";
import { subscribeAuthSessionExpired } from "@/lib/wallet/session-expiry";

const taskId = "11111111-1111-4111-8111-111111111111";
const categoryId = "40000000-0000-4000-8000-000000000001";
const agentId = "22222222-2222-4222-8222-222222222222";
const assignmentId = "33333333-3333-4333-8333-333333333333";
const distributionId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";

describe("formal task API client", () => {
	beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
	afterEach(() => vi.unstubAllGlobals());

	it("loads controlled categories through the public taxonomy endpoint", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			Response.json({
				categories: [
					{
						id: categoryId,
						parentId: null,
						name: "产品与开发",
						slug: "product-development",
						version: 1,
						children: [],
					},
				],
			}),
		);

		const categories = await listTaskCategories();

		expect(categories[0]?.name).toBe("产品与开发");
		expect(fetch).toHaveBeenCalledWith(
			"https://business-api.test/api/categories",
			expect.objectContaining({ headers: expect.any(Headers) }),
		);
	});

	it("creates a credentialed draft with an idempotency key", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			Response.json(
				{ taskId, status: "draft", statusVersion: "0", visibility: "public" },
				{ status: 201 },
			),
		);

		await createTaskDraft(
			{
				title: "实现正式任务工作台",
				description: "通过真实 API 保存任务，不再依赖浏览器本地状态。",
				acceptanceCriteria: "创建和提交使用独立幂等命令。",
				deliverableFormat: "源码与测试",
				categoryId,
				tags: ["agent"],
				pricing: { type: "fixed", amountMinor: "12800000000000000" },
				currency: "USDC",
				deadline: "2026-09-30T10:00:00.000Z",
				requiredCapability: "TypeScript",
				attachments: [],
				visibility: "public",
				assignmentMode: { mode: "manual" },
				acceptanceMode: { mode: "manual" },
			},
			"create-task-idempotency-1",
		);

		const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
		expect(init).toEqual(
			expect.objectContaining({ method: "POST", credentials: "include" }),
		);
		expect(new Headers(init?.headers).get("idempotency-key")).toBe(
			"create-task-idempotency-1",
		);
	});

	it("accepts incomplete private drafts in the owned list", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			Response.json({
				tasks: [
					{
						id: taskId,
						title: "",
						description: "",
						categoryId: null,
						tags: [],
						pricing: null,
						currency: "USDC",
						deadline: null,
						visibility: "private",
						assignmentMode: { mode: "manual" },
						acceptanceMode: { mode: "manual" },
						status: "draft",
						statusVersion: "0",
						createdAt: "2026-08-23T08:00:00+08:00",
						updatedAt: "2026-08-23T00:00:00.000Z",
					},
				],
				limit: 100,
				offset: 0,
			}),
		);

		const tasks = await listOwnedTasks();

		expect(tasks[0]).toMatchObject({
			status: "draft",
			pricing: null,
			visibility: "private",
		});
	});

	it("受保护任务接口返回 401 时通知钱包会话立即失效", async () => {
		const expired = vi.fn();
		const unsubscribe = subscribeAuthSessionExpired(expired);
		vi.mocked(fetch).mockResolvedValueOnce(
			Response.json(
				{ error_code: "UNAUTHENTICATED", message: "登录会话已过期", retryable: false },
				{ status: 401 },
			),
		);

		await expect(listOwnedTasks()).rejects.toMatchObject({ status: 401 });
		expect(expired).toHaveBeenCalledTimes(1);
		unsubscribe();
	});

	it("parses the server-authoritative fee rule used before escrow", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			Response.json({
				taskId,
				status: "awaiting_escrow",
				summary: {
					title: "开发可信任务平台",
					description:
						"展示托管前的完整费用明细，并确保发布者不会在预算外被额外收费。",
					acceptanceCriteria: "费用明细来自服务端权威规则。",
					deliverableFormat: "源码与测试",
					categoryId,
					tags: ["agent"],
					pricing: { type: "fixed", amountMinor: "100000000" },
					currency: "USDC",
					deadline: "2026-09-30T10:00:00.000Z",
					requiredCapability: "TypeScript",
					attachments: [],
				},
				valid: true,
				issues: [],
				amountMinor: "100000000",
				platformFeeMinor: "400000",
				agentReceivesMinor: "99600000",
				feeBasisPoints: "40",
				minimumPlatformFeeMinor: "50000",
				feeRuleVersion: "fee-v3-usdc",
				irreversibleWarning: "链上托管确认后只能按状态机释放资金",
			}),
		);

		await expect(getTaskPreview(taskId)).resolves.toMatchObject({
			feeBasisPoints: "40",
			minimumPlatformFeeMinor: "50000",
			platformFeeMinor: "400000",
		});
	});

	it("validates the persisted multi-Agent workflow before exposing it to the page", async () => {
		const workflowNodeId = "66666666-6666-4666-8666-666666666666";
		vi.mocked(fetch).mockResolvedValueOnce(
			Response.json({
				run: {
					id: "77777777-7777-4777-8777-777777777777",
					taskId,
					status: "running",
					version: "3",
					currency: "USDC",
					totalBudgetMinor: "100000000",
					releasedAmountMinor: "20000000",
					refundableAmountMinor: "80000000",
					createdAt: "2026-08-23T00:00:00.000Z",
					updatedAt: "2026-08-23T00:10:00.000Z",
				},
				nodes: [
					{
						id: workflowNodeId,
						key: "requirements",
						kind: "prd",
						title: "需求拆解",
						description: "把用户需求拆成可验收任务。",
						categoryId,
						tags: ["prd"],
						requiredCapability: "需求分析",
						inputContract: "task.v1",
						outputContract: "prd.v1",
						budgetCapMinor: "20000000",
						positionIndex: 0,
						status: "accepted",
						version: "4",
						acceptedAt: "2026-08-23T00:09:00.000Z",
						assignment: null,
						execution: null,
						candidateRecord: null,
						latestResultBatch: null,
						acceptance: null,
						latestRework: null,
					},
				],
				edges: [],
			}),
		);

		await expect(getTaskWorkflow(taskId)).resolves.toMatchObject({
			run: { currency: "USDC", releasedAmountMinor: "20000000" },
			nodes: [{ id: workflowNodeId, status: "accepted" }],
		});
		expect(fetch).toHaveBeenCalledWith(
			`https://business-api.test/api/tasks/${taskId}/workflow`,
			expect.objectContaining({ credentials: "include" }),
		);
	});

	it("rejects public amounts encoded as JSON numbers", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			Response.json({
				tasks: [
					{
						access: "public",
						id: taskId,
						title: "任务",
						description: "说明",
						categoryId,
						tags: [],
						budgetMinMinor: 100,
						budgetMaxMinor: "100",
						currency: "USDC",
						deadline: "2026-09-30T10:00:00.000Z",
						requiredCapability: "测试",
						status: "matching",
						createdAt: "2026-08-23T00:00:00.000Z",
					},
				],
				limit: 50,
				offset: 0,
			}),
		);

		await expect(listPublicTasks({})).rejects.toBeInstanceOf(
			TaskApiRequestError,
		);
	});

	it("sends keyword, category, tag and failure-state filters to the authoritative market query", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			Response.json({ tasks: [], limit: 50, offset: 0 }),
		);

		await listPublicTasks({
			keyword: "  Coding  ",
			category: categoryId,
			tag: " TypeScript ",
			status: "execution_failed",
		});

		const [url] = vi.mocked(fetch).mock.calls[0] ?? [];
		const parsed = new URL(String(url));
		expect(parsed.searchParams.get("keyword")).toBe("Coding");
		expect(parsed.searchParams.get("category")).toBe(categoryId);
		expect(parsed.searchParams.get("tag")).toBe("TypeScript");
		expect(parsed.searchParams.get("status")).toBe("execution_failed");
	});

	it("keeps candidate and assignment amounts exact beyond JavaScript safe integers", async () => {
		vi.mocked(fetch)
			.mockResolvedValueOnce(
				Response.json({
					id: distributionId,
					taskId,
					ruleVersion: "ranking-v1",
					inputFingerprint: "fingerprint",
					inputSnapshot: { task: taskId },
					candidates: [
						{
							agentId,
							name: "协议原生 Coding Agent",
							matchedTags: ["next.js"],
							quoteMinor: "9007199254740993",
							estimatedDurationSeconds: 1800,
							score: 4.8,
							completed: 42,
							responseMinutes: 3,
							isNew: false,
							rankScore: "9223372036854775807",
						},
					],
					filterReasons: {},
					createdAt: "2026-08-23T08:00:00+08:00",
				}),
			)
			.mockResolvedValueOnce(
				Response.json(
					{
						assignment: {
							id: assignmentId,
							taskId,
							agentId,
							agreedAmountMinor: "9007199254740993",
							idempotencyKey: "assignment-contract-test",
							assignedBy: "0x1111111111111111111111111111111111111111",
							version: "1",
							status: "pending_ack",
							lockedAt: "2026-08-23T08:00:00+08:00",
							acceptBy: "2026-08-23T08:05:00+08:00",
							respondedAt: "1970-01-01T00:00:00.000Z",
						},
						dispatchAttempt: {
							id: attemptId,
							assignmentId,
							idempotencyKey: "assignment-contract-test",
							protocolRequestId: "request-1",
							status: "queued",
							attemptNo: 1,
						},
						replayed: false,
					},
					{ status: 201 },
				),
			);

		const candidates = await getTaskCandidates(taskId);
		const assignment = await confirmTaskCandidate(
			taskId,
			agentId,
			"assignment-contract-test",
		);

		expect(candidates.candidates[0]?.quoteMinor).toBe("9007199254740993");
		expect(candidates.candidates[0]?.rankScore).toBe("9223372036854775807");
		expect(assignment.assignment.agreedAmountMinor).toBe("9007199254740993");
		const [, init] = vi.mocked(fetch).mock.calls[1] ?? [];
		expect(init).toEqual(
			expect.objectContaining({ method: "POST", credentials: "include" }),
		);
		expect(new Headers(init?.headers).get("idempotency-key")).toBe(
			"assignment-contract-test",
		);
	});

	it("rejects a candidate quote encoded as a JSON number", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			Response.json({
				id: distributionId,
				taskId,
				ruleVersion: "ranking-v1",
				inputFingerprint: "fingerprint",
				inputSnapshot: {},
				candidates: [
					{
						agentId,
						name: "Agent",
						matchedTags: [],
						quoteMinor: 9007199254740992,
						estimatedDurationSeconds: 1,
						score: 1,
						completed: 0,
						responseMinutes: 1,
						isNew: true,
						rankScore: "1",
					},
				],
				filterReasons: {},
				createdAt: "2026-08-23T00:00:00.000Z",
			}),
		);

		await expect(getTaskCandidates(taskId)).rejects.toBeInstanceOf(
			TaskApiRequestError,
		);
	});

	it("validates the wallet transaction prepared by the escrow service", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			Response.json({
				taskId,
				status: "prepared",
				chainId: "31337",
				contractAddress: "0x1111111111111111111111111111111111111111",
				paymentTokenAddress: "0x2222222222222222222222222222222222222222",
				taskKey: `0x${"ab".repeat(32)}`,
				transactions: {
					approve: {
						to: "0x2222222222222222222222222222222222222222",
						data: `0x${"cd".repeat(36)}`,
						value: "0x0",
					},
					deposit: {
						to: "0x1111111111111111111111111111111111111111",
						data: `0x${"ef".repeat(36)}`,
						value: "0x0",
					},
				},
				amountMinor: "10000000",
			}),
		);

		const prepared = await prepareTaskEscrow(
			taskId,
			"prepare-escrow-contract-test",
		);

		expect(prepared.amountMinor).toBe("10000000");
		expect(prepared.transactions.approve.value).toBe("0x0");
		expect(prepared.transactions.deposit.value).toBe("0x0");
	});

	it("confirms the exact server preview instead of accepting an unpriced result", async () => {
		const resultId = "66666666-6666-4666-8666-666666666666";
		const preview = {
			taskId,
			resultId,
			status: "awaiting_review" as const,
			statusVersion: "9",
			settlement: {
				grossAmountMinor: "24000000",
				platformFeeMinor: "50000",
				agentAmountMinor: "23950000",
				feeRuleVersion: "fee-v3-usdc",
			},
		};
		vi.mocked(fetch)
			.mockResolvedValueOnce(Response.json(preview))
			.mockResolvedValueOnce(
				Response.json({
					acceptanceId: "77777777-7777-4777-8777-777777777777",
					...preview,
					status: "pending_settlement",
					statusVersion: "10",
				}),
			);

		await expect(getTaskAcceptancePreview(taskId, resultId)).resolves.toEqual(
			preview,
		);
		await acceptTaskResult(taskId, preview, "accept-result-preview-001");

		const [url, init] = vi.mocked(fetch).mock.calls[1] ?? [];
		expect(String(url)).toContain(`/tasks/${taskId}/accept`);
		expect(JSON.parse(String(init?.body))).toEqual({
			resultId,
			expectedStatusVersion: "9",
			expectedSettlement: preview.settlement,
		});
	});

	it("subscribes to the authoritative arbitration confirmation event names", () => {
		const eventNames: string[] = [];
		class RecordingEventSource {
			onerror: (() => void) | null = null;
			onopen: (() => void) | null = null;
			constructor(_url: string, _options: EventSourceInit) {}
			addEventListener(type: string) {
				eventNames.push(type);
			}
			close() {}
		}
		vi.stubGlobal("EventSource", RecordingEventSource);

		const unsubscribe = subscribeTaskEvents(taskId, { onEvent: vi.fn() });

		expect(eventNames).toContain("task.arbitration_refund_confirmed");
		expect(eventNames).toContain("task.arbitration_release_confirmed");
		expect(eventNames).toContain("task.match_criteria_updated");
		expect(eventNames).toContain("task.assignment_failed");
		expect(eventNames).toContain("task.execution_failed");
		expect(eventNames).toContain("task.input_requested");
		expect(eventNames).not.toContain("task.refund_confirmed");
		unsubscribe();
	});
});
