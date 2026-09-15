import { describe, expect, it } from "vitest";

import type { QueryExecutor } from "../db/pool";
import { updateOwnedWorkflowNodeCapabilities } from "./workflow-capabilities";
import { updateOwnedWorkflowBudgetPreference } from "./workflow-preferences";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const NODE_ID = "33333333-3333-4333-8333-333333333333";
const PUBLISHER = `0x${"12".repeat(20)}`;
const UPDATED_AT = new Date("2026-08-31T10:00:00.000Z");

describe("workflow preferences", () => {
	it("把预算偏好按权重分配，但不写入任何冻结金额列", async () => {
		const db = new PreferenceDb();
		const result = await updateOwnedWorkflowBudgetPreference(db, {
			taskId: TASK_ID,
			actorId: PUBLISHER.toUpperCase(),
			rawInput: { budgetPreferenceMinor: "60000000" },
			idempotencyKey: "budget-preference-unit-1",
			updatedAt: UPDATED_AT,
		});

		expect(
			result.body.nodePreferences.map((item) => item.pricePreferenceMinor),
		).toEqual(["12000000", "18000000", "30000000"]);
		const mutationSql = db.executedSql.filter((sql) =>
			sql.startsWith("UPDATE task_workflow"),
		);
		expect(mutationSql.join("\n")).not.toMatch(
			/budget_cap_minor|agreed_amount_minor|quoted_total_minor/,
		);
	});

	it("已有节点选择后锁定预算偏好，且非法金额不会进入数据库", async () => {
		const locked = new PreferenceDb({
			selectedAgentId: "44444444-4444-4444-8444-444444444444",
		});
		await expect(
			updateOwnedWorkflowBudgetPreference(locked, {
				taskId: TASK_ID,
				actorId: PUBLISHER,
				rawInput: { budgetPreferenceMinor: "60000000" },
				idempotencyKey: "budget-preference-unit-2",
				updatedAt: UPDATED_AT,
			}),
		).rejects.toMatchObject({
			code: "WORKFLOW_PREFERENCE_LOCKED",
			statusCode: 409,
		});

		const untouched = new PreferenceDb();
		await expect(
			updateOwnedWorkflowBudgetPreference(untouched, {
				taskId: TASK_ID,
				actorId: PUBLISHER,
				rawInput: { budgetPreferenceMinor: "100000000001" },
				idempotencyKey: "budget-preference-unit-3",
				updatedAt: UPDATED_AT,
			}),
		).rejects.toMatchObject({ code: "VALIDATION_FAILED", statusCode: 422 });
		expect(untouched.executedSql).toHaveLength(0);
	});

	it("归一能力同义词并允许清空软能力，不影响预算与报价", async () => {
		const db = new PreferenceDb();
		const result = await updateOwnedWorkflowNodeCapabilities(db, {
			taskId: TASK_ID,
			nodeId: NODE_ID,
			actorId: PUBLISHER,
			rawInput: { tags: [" NextJS ", "界面设计", "next.js"] },
			idempotencyKey: "capability-preference-unit-1",
			updatedAt: UPDATED_AT,
		});
		expect(result.body.tags).toEqual(["next.js", "ui/ux"]);
		expect(db.savedNodeTags).toEqual(["next.js", "ui/ux"]);
		expect(db.executedSql.join("\n")).not.toMatch(
			/SET[^;]*(budget_cap_minor|agreed_amount_minor|price_preference_minor)/,
		);

		const cleared = new PreferenceDb();
		await expect(
			updateOwnedWorkflowNodeCapabilities(cleared, {
				taskId: TASK_ID,
				nodeId: NODE_ID,
				actorId: PUBLISHER,
				rawInput: { tags: [] },
				idempotencyKey: "capability-preference-unit-2",
				updatedAt: UPDATED_AT,
			}),
		).resolves.toMatchObject({ body: { tags: [] } });
	});

	it("能力修改对越权与已选节点使用同一安全锁定边界", async () => {
		await expect(
			updateOwnedWorkflowNodeCapabilities(new PreferenceDb(), {
				taskId: TASK_ID,
				nodeId: NODE_ID,
				actorId: `0x${"ff".repeat(20)}`,
				rawInput: { tags: ["next.js"] },
				idempotencyKey: "capability-preference-unit-3",
				updatedAt: UPDATED_AT,
			}),
		).rejects.toMatchObject({
			code: "WORKFLOW_NODE_NOT_FOUND",
			statusCode: 404,
		});

		await expect(
			updateOwnedWorkflowNodeCapabilities(
				new PreferenceDb({ nodeStatus: "selected" }),
				{
					taskId: TASK_ID,
					nodeId: NODE_ID,
					actorId: PUBLISHER,
					rawInput: { tags: ["next.js"] },
					idempotencyKey: "capability-preference-unit-4",
					updatedAt: UPDATED_AT,
				},
			),
		).rejects.toMatchObject({
			code: "WORKFLOW_CAPABILITY_LOCKED",
			statusCode: 409,
		});
	});
});

type PreferenceDbOptions = Readonly<{
	selectedAgentId?: string | null;
	nodeStatus?: string;
}>;

/**
 * 这个假仓储只实现两个命令公开依赖的 SQL 契约。遇到未知查询立即失败，避免测试因
 * “什么都返回空”而掩盖生产代码新增了未验证的读写路径。
 */
class PreferenceDb implements QueryExecutor {
	readonly executedSql: string[] = [];
	savedNodeTags: readonly string[] | null = null;

	constructor(private readonly options: PreferenceDbOptions = {}) {}

	async query<Row>(
		text: string,
		params: readonly unknown[],
	): Promise<{ rows: Row[]; rowCount: number | null }> {
		const sql = text.replace(/\s+/g, " ").trim();
		this.executedSql.push(sql);

		if (sql.startsWith("INSERT INTO idempotency_records")) {
			return result([{ idempotency_key: String(params[0]) }]);
		}
		if (
			sql.includes("FROM tasks task") &&
			sql.includes("JOIN task_workflow_nodes node")
		) {
			return result([
				{
					workflow_run_id: RUN_ID,
					publisher_id: PUBLISHER,
					task_status: "planning",
					run_status: "planning",
					node_status: this.options.nodeStatus ?? "selecting",
					selected_agent_id: this.options.selectedAgentId ?? null,
					version: "1",
					tags: ["ui/ux"],
				},
			]);
		}
		if (
			sql.includes("FROM tasks task") &&
			sql.includes("JOIN task_workflow_runs run") &&
			!sql.includes("task_workflow_nodes")
		) {
			return result([
				{
					id: RUN_ID,
					publisher_id: PUBLISHER,
					task_status: "planning",
					run_status: "planning",
					budget_preference_minor: null,
				},
			]);
		}
		if (
			sql.includes("FROM task_workflow_nodes") &&
			sql.includes("price_preference_weight")
		) {
			return result([
				{
					id: NODE_ID,
					price_preference_weight: 20,
					selected_agent_id: this.options.selectedAgentId ?? null,
				},
				{
					id: "33333333-3333-4333-8333-333333333334",
					price_preference_weight: 30,
					selected_agent_id: null,
				},
				{
					id: "33333333-3333-4333-8333-333333333335",
					price_preference_weight: 50,
					selected_agent_id: null,
				},
			]);
		}
		if (sql === "SELECT canonical_name,synonyms,forbidden FROM tags") {
			return result([
				{
					canonical_name: "next.js",
					synonyms: ["nextjs", "next js"],
					forbidden: false,
				},
				{
					canonical_name: "ui/ux",
					synonyms: ["ui", "界面设计"],
					forbidden: false,
				},
			]);
		}
		if (
			sql.startsWith("UPDATE task_workflow_nodes") &&
			sql.includes("SET tags=")
		) {
			this.savedNodeTags = params[2] as readonly string[];
			return result([], 1);
		}
		if (
			sql.startsWith("UPDATE task_workflow_runs") ||
			sql.startsWith("UPDATE task_workflow_nodes") ||
			sql.startsWith("INSERT INTO workflow_node_events") ||
			sql.startsWith("INSERT INTO audit_logs")
		) {
			return result([], 1);
		}
		if (sql.startsWith("UPDATE idempotency_records")) return result([], 1);

		throw new Error(`UNEXPECTED_TEST_QUERY: ${sql}`);
	}
}

/** 泛型断言只存在于测试数据库边界；每个调用点仍显式声明真实行结构。 */
function result<Row>(rows: readonly unknown[], rowCount: number = rows.length) {
	return { rows: rows as Row[], rowCount };
}
