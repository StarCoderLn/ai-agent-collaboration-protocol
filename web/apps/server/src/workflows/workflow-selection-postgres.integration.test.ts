import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { taskKeyForTaskId } from "../escrow/escrow-chain-client";
import type { EscrowDatabase } from "../escrow/escrow-repository";
import { PgEscrowRepository } from "../escrow/escrow-repository";
import { updateOwnedWorkflowNodeCapabilities } from "./workflow-capabilities";
import { updateOwnedWorkflowBudgetPreference } from "./workflow-preferences";
import { PgWorkflowSelectionRepository } from "./workflow-selection-repository";

const DATABASE_URL = process.env.DATABASE_URL;
const integration = DATABASE_URL === undefined ? describe.skip : describe;
const CATEGORY_ID = "40000000-0000-4000-8000-000000000001";
const PUBLISHER = `0x${"31".repeat(20)}`;
const PROVIDER = `0x${"32".repeat(20)}`;
const PAYOUT = `0x${"33".repeat(20)}`;
const ESCROW_CONTRACT = `0x${"34".repeat(20)}`;
const SELECTED_AT = new Date("2026-08-31T08:00:00.000Z");

type SelectionFixture = Readonly<{
	taskId: string;
	runId: string;
	agentId: string;
	nodeIds: readonly [string, string, string];
	quoteMinorByNode: ReadonlyMap<string, string>;
}>;

/**
 * 这组测试用真实 PostgreSQL 约束证明托管前选人流程。每个用例由外层事务隔离，仓储
 * 自己的 BEGIN/COMMIT 被映射为 SAVEPOINT，因此既验证正式事务边界，也不会污染开发库。
 */
integration("workflow selection PostgreSQL contract", () => {
	let pool: Pool;

	beforeAll(() => {
		pool = new Pool({ connectionString: requiredDatabaseUrl() });
	});

	afterAll(async () => {
		await pool.end();
	});

	it("keeps partial selections in planning, freezes the exact sum, and prepares escrow from that sum", async () => {
		await withRollbackClient(pool, async (client) => {
			const fixture = await insertSelectionFixture(client);
			const database = asNestedTransactionDatabase(client);
			const repository = new PgWorkflowSelectionRepository(database);

			const firstInput = selectionInput(
				fixture,
				fixture.nodeIds[0],
				"select-first",
			);
			const first = await repository.select(firstInput);
			expect(first.body).toMatchObject({
				taskStatus: "planning",
				selectedNodeCount: 1,
				totalNodeCount: 3,
				quotedTotalMinor: null,
				agreedAmountMinor: "10000000",
			});
			await expect(
				client.query(
					`SELECT task.status AS task_status,run.quoted_total_minor::text,
				        node.status AS node_status,node.agreed_amount_minor::text
				   FROM tasks task JOIN task_workflow_runs run ON run.task_id=task.id
				   JOIN task_workflow_nodes node ON node.id=$2 WHERE task.id=$1`,
					[fixture.taskId, fixture.nodeIds[0]],
				),
			).resolves.toMatchObject({
				rows: [
					{
						task_status: "planning",
						quoted_total_minor: null,
						node_status: "selected",
						agreed_amount_minor: "10000000",
					},
				],
			});

			await repository.select(
				selectionInput(fixture, fixture.nodeIds[1], "select-second"),
			);
			const finalSelection = await repository.select(
				selectionInput(fixture, fixture.nodeIds[2], "select-third"),
			);
			expect(finalSelection.body).toEqual({
				taskId: fixture.taskId,
				nodeId: fixture.nodeIds[2],
				agentId: fixture.agentId,
				agreedAmountMinor: "30000000",
				selectedNodeCount: 3,
				totalNodeCount: 3,
				quotedTotalMinor: "60000000",
				taskStatus: "awaiting_escrow",
			});

			const frozen = await client.query<{
				task_status: string;
				pricing_type: string;
				budget_max_minor: string;
				quoted_total_minor: string;
				total_budget_minor: string;
				selected_nodes: string;
			}>(
				`SELECT task.status AS task_status,task.pricing_type,task.budget_max_minor::text,
				        run.quoted_total_minor::text,run.total_budget_minor::text,
				        count(*) FILTER (WHERE node.status='selected')::text AS selected_nodes
				   FROM tasks task JOIN task_workflow_runs run ON run.task_id=task.id
				   JOIN task_workflow_nodes node ON node.workflow_run_id=run.id
				  WHERE task.id=$1 GROUP BY task.status,task.pricing_type,task.budget_max_minor,
				    run.quoted_total_minor,run.total_budget_minor`,
				[fixture.taskId],
			);
			expect(frozen.rows[0]).toEqual({
				task_status: "awaiting_escrow",
				pricing_type: "fixed",
				budget_max_minor: "60000000",
				quoted_total_minor: "60000000",
				total_budget_minor: "60000000",
				selected_nodes: "3",
			});

			const escrow = new PgEscrowRepository(database);
			const intent = await escrow.prepareIntent({
				taskId: fixture.taskId,
				publisherId: PUBLISHER,
				chainId: 31_337n,
				contractAddress: ESCROW_CONTRACT,
				taskKey: taskKeyForTaskId(fixture.taskId),
			});
			expect(intent.amountMinor).toBe(60_000_000n);

			// 相同幂等键必须重放第一次的 planning 快照，不能在任务已待托管后重新改价。
			await expect(repository.select(firstInput)).resolves.toEqual(first);
		});
	});

	it("allows reselection after a verified pre-broadcast failure and locks once Deposit is submitted", async () => {
		await withRollbackClient(pool, async (client) => {
			const fixture = await insertSelectionFixture(client);
			const database = asNestedTransactionDatabase(client);
			const repository = new PgWorkflowSelectionRepository(database);
			await repository.select(
				selectionInput(fixture, fixture.nodeIds[0], "revise-first"),
			);
			await repository.select(
				selectionInput(fixture, fixture.nodeIds[1], "revise-second"),
			);
			await repository.select(
				selectionInput(fixture, fixture.nodeIds[2], "revise-third"),
			);

			const replacementAgentId = await addReplacementCandidate(
				client,
				fixture,
				fixture.nodeIds[1],
				"17000000",
			);
			const revised = await repository.select({
				...selectionInput(fixture, fixture.nodeIds[1], "revise-design"),
				agentId: replacementAgentId,
			});
			expect(revised.body).toEqual({
				taskId: fixture.taskId,
				nodeId: fixture.nodeIds[1],
				agentId: replacementAgentId,
				agreedAmountMinor: "17000000",
				selectedNodeCount: 3,
				totalNodeCount: 3,
				quotedTotalMinor: "57000000",
				taskStatus: "awaiting_escrow",
			});

			const facts = await client.query<{
				task_status: string;
				status_version: string;
				quoted_total_minor: string;
				selected_agent_id: string;
				agreed_amount_minor: string;
				unchanged_count: string;
			}>(
				`SELECT task.status AS task_status,task.status_version::text,
				        run.quoted_total_minor::text,node.selected_agent_id::text,
				        node.agreed_amount_minor::text,
				        (SELECT count(*)::text FROM task_workflow_nodes other
				          WHERE other.workflow_run_id=run.id AND other.id<>node.id
				            AND other.selected_agent_id=$3) AS unchanged_count
				   FROM tasks task JOIN task_workflow_runs run ON run.task_id=task.id
				   JOIN task_workflow_nodes node ON node.id=$2
				  WHERE task.id=$1`,
				[fixture.taskId, fixture.nodeIds[1], fixture.agentId],
			);
			expect(facts.rows[0]).toEqual({
				task_status: "awaiting_escrow",
				status_version: "3",
				quoted_total_minor: "57000000",
				selected_agent_id: replacementAgentId,
				agreed_amount_minor: "17000000",
				unchanged_count: "2",
			});
			await expect(
				client.query(
					`SELECT event_type,payload FROM task_events
				  WHERE task_id=$1 AND event_type='task.workflow_quote_revised'`,
					[fixture.taskId],
				),
			).resolves.toMatchObject({
				rows: [
					{
						event_type: "task.workflow_quote_revised",
						payload: expect.objectContaining({
							nodeId: fixture.nodeIds[1],
							previousQuotedTotalMinor: "60000000",
							quotedTotalMinor: "57000000",
						}),
					},
				],
			});

			const escrow = new PgEscrowRepository(database);
			await expect(
				escrow.prepareIntent({
					taskId: fixture.taskId,
					publisherId: PUBLISHER,
					chainId: 31_337n,
					contractAddress: ESCROW_CONTRACT,
					taskKey: taskKeyForTaskId(fixture.taskId),
				}),
			).resolves.toMatchObject({ amountMinor: 57_000_000n });

			await expect(
				repository.select({
					...selectionInput(fixture, fixture.nodeIds[1], "revise-after-escrow"),
					agentId: fixture.agentId,
				}),
			).rejects.toMatchObject({
				code: "WORKFLOW_SELECTION_LOCKED",
				statusCode: 409,
			});

			// 用户明确取消钱包操作后，failed + 无 txHash + 无链事件证明资金从未广播。
			// 此时改选必须同步修订工作流总价与旧托管意图金额，不能留下旧报价。
			await escrow.markSubmissionFailed(
				fixture.taskId,
				PUBLISHER,
				"用户取消了尚未广播的托管交易",
			);
			await expect(
				repository.select({
					...selectionInput(
						fixture,
						fixture.nodeIds[1],
						"revise-after-failed-escrow",
					),
					agentId: fixture.agentId,
				}),
			).resolves.toMatchObject({
				body: {
					agentId: fixture.agentId,
					quotedTotalMinor: "60000000",
					taskStatus: "awaiting_escrow",
				},
			});
			// failed intent 保持可改选，次数不是业务门禁；每次都从候选快照重算并覆盖
			// intent 金额。这里来回更换两次，防止实现意外退化成“只允许更换一次”。
			await expect(
				repository.select({
					...selectionInput(
						fixture,
						fixture.nodeIds[1],
						"revise-failed-second-time",
					),
					agentId: replacementAgentId,
				}),
			).resolves.toMatchObject({ body: { quotedTotalMinor: "57000000" } });
			await expect(
				repository.select({
					...selectionInput(
						fixture,
						fixture.nodeIds[1],
						"revise-failed-third-time",
					),
					agentId: fixture.agentId,
				}),
			).resolves.toMatchObject({ body: { quotedTotalMinor: "60000000" } });
			await expect(
				escrow.resetFailedIntent(fixture.taskId, PUBLISHER),
			).resolves.toMatchObject({
				amountMinor: 60_000_000n,
				status: "prepared",
			});

			const txHash = `0x${"91".repeat(32)}`;
			await expect(
				escrow.recordSubmission(fixture.taskId, PUBLISHER, txHash, 57_000_000n),
			).rejects.toMatchObject({
				code: "ESCROW_SUBMISSION_NOT_ALLOWED",
				statusCode: 409,
			});
			await escrow.recordSubmission(
				fixture.taskId,
				PUBLISHER,
				txHash,
				60_000_000n,
			);
			await expect(
				repository.select({
					...selectionInput(
						fixture,
						fixture.nodeIds[1],
						"revise-after-submission",
					),
					agentId: replacementAgentId,
				}),
			).rejects.toMatchObject({
				code: "WORKFLOW_SELECTION_LOCKED",
				statusCode: 409,
			});
		});
	});

	it("persists an optional budget preference separately from all frozen money fields", async () => {
		await withRollbackClient(pool, async (client) => {
			const fixture = await insertSelectionFixture(client);
			const input = {
				taskId: fixture.taskId,
				actorId: PUBLISHER,
				rawInput: { budgetPreferenceMinor: "60000000" },
				idempotencyKey: `budget-preference:${randomUUID()}`,
				updatedAt: SELECTED_AT,
			} as const;
			const result = await updateOwnedWorkflowBudgetPreference(client, input);
			expect(
				result.body.nodePreferences.map((item) => item.pricePreferenceMinor),
			).toEqual(["12000000", "18000000", "30000000"]);
			// 相同幂等键重放第一次快照，不能重复增加 run/node 版本。
			await expect(
				updateOwnedWorkflowBudgetPreference(client, input),
			).resolves.toEqual(result);

			const facts = await client.query<{
				budget_preference_minor: string;
				total_budget_minor: string | null;
				quoted_total_minor: string | null;
				frozen_node_count: string;
			}>(
				`SELECT run.budget_preference_minor::text,run.total_budget_minor::text,
				        run.quoted_total_minor::text,
				        count(*) FILTER (WHERE node.budget_cap_minor IS NOT NULL)::text AS frozen_node_count
				   FROM task_workflow_runs run
				   JOIN task_workflow_nodes node ON node.workflow_run_id=run.id
				  WHERE run.id=$1
				  GROUP BY run.budget_preference_minor,run.total_budget_minor,run.quoted_total_minor`,
				[fixture.runId],
			);
			expect(facts.rows[0]).toEqual({
				budget_preference_minor: "60000000",
				total_budget_minor: null,
				quoted_total_minor: null,
				frozen_node_count: "0",
			});
		});
	});

	it("normalizes editable capabilities without changing any pricing field", async () => {
		await withRollbackClient(pool, async (client) => {
			const fixture = await insertSelectionFixture(client);
			const result = await updateOwnedWorkflowNodeCapabilities(client, {
				taskId: fixture.taskId,
				nodeId: fixture.nodeIds[1],
				actorId: PUBLISHER,
				rawInput: { tags: ["NextJS", "ui/ux", "next.js"] },
				idempotencyKey: `capability-preference:${randomUUID()}`,
				updatedAt: SELECTED_AT,
			});
			expect(result.body.tags).toEqual(["next.js", "ui/ux"]);

			const facts = await client.query<{
				tags: string[];
				budget_cap_minor: string | null;
				price_preference_minor: string | null;
				agreed_amount_minor: string | null;
				quoted_total_minor: string | null;
			}>(
				`SELECT node.tags,node.budget_cap_minor::text,node.price_preference_minor::text,
				        node.agreed_amount_minor::text,run.quoted_total_minor::text
				   FROM task_workflow_nodes node
				   JOIN task_workflow_runs run ON run.id=node.workflow_run_id
				  WHERE node.id=$1`,
				[fixture.nodeIds[1]],
			);
			expect(facts.rows[0]).toEqual({
				tags: ["next.js", "ui/ux"],
				budget_cap_minor: null,
				price_preference_minor: null,
				agreed_amount_minor: null,
				quoted_total_minor: null,
			});
		});
	});

	it("locks budget and capability preferences after any Agent quote is frozen", async () => {
		await withRollbackClient(pool, async (client) => {
			const fixture = await insertSelectionFixture(client);
			const repository = new PgWorkflowSelectionRepository(
				asNestedTransactionDatabase(client),
			);
			await repository.select(
				selectionInput(fixture, fixture.nodeIds[0], "lock-preferences"),
			);

			await expect(
				updateOwnedWorkflowBudgetPreference(client, {
					taskId: fixture.taskId,
					actorId: PUBLISHER,
					rawInput: { budgetPreferenceMinor: "50000000" },
					idempotencyKey: `locked-budget:${randomUUID()}`,
					updatedAt: SELECTED_AT,
				}),
			).rejects.toMatchObject({
				code: "WORKFLOW_PREFERENCE_LOCKED",
				statusCode: 409,
			});

			await expect(
				updateOwnedWorkflowNodeCapabilities(client, {
					taskId: fixture.taskId,
					nodeId: fixture.nodeIds[0],
					actorId: PUBLISHER,
					rawInput: { tags: ["next.js"] },
					idempotencyKey: `locked-capability:${randomUUID()}`,
					updatedAt: SELECTED_AT,
				}),
			).rejects.toMatchObject({
				code: "WORKFLOW_CAPABILITY_LOCKED",
				statusCode: 409,
			});
		});
	});

	it("rejects unauthorized, non-candidate, and malformed snapshots without changing any node", async () => {
		await withRollbackClient(pool, async (client) => {
			const fixture = await insertSelectionFixture(client);
			const repository = new PgWorkflowSelectionRepository(
				asNestedTransactionDatabase(client),
			);

			await expect(
				repository.select({
					...selectionInput(fixture, fixture.nodeIds[0], "unauthorized"),
					actorId: `0x${"ff".repeat(20)}`,
				}),
			).rejects.toMatchObject({
				code: "WORKFLOW_NODE_NOT_FOUND",
				statusCode: 404,
			});

			await expect(
				repository.select({
					...selectionInput(fixture, fixture.nodeIds[0], "not-candidate"),
					agentId: randomUUID(),
				}),
			).rejects.toMatchObject({
				code: "CANDIDATE_NOT_FOUND",
				statusCode: 409,
			});

			await client.query(
				"UPDATE job_distribution_records SET candidates='[{\"quoteMinor\":1}]'::jsonb WHERE workflow_node_id=$1",
				[fixture.nodeIds[0]],
			);
			await expect(
				repository.select(
					selectionInput(fixture, fixture.nodeIds[0], "invalid-snapshot"),
				),
			).rejects.toMatchObject({
				code: "CANDIDATE_SNAPSHOT_INVALID",
				statusCode: 409,
			});

			await expect(
				client.query(
					"SELECT count(*)::text AS count FROM task_workflow_nodes WHERE task_id=$1 AND selected_agent_id IS NOT NULL",
					[fixture.taskId],
				),
			).resolves.toMatchObject({ rows: [{ count: "0" }] });
		});
	});
});

async function insertSelectionFixture(
	client: PoolClient,
): Promise<SelectionFixture> {
	const taskId = randomUUID();
	const runId = randomUUID();
	const agentId = randomUUID();
	const nodeIds = [randomUUID(), randomUUID(), randomUUID()] as const;
	const quoteMinorByNode = new Map([
		[nodeIds[0], "10000000"],
		[nodeIds[1], "20000000"],
		[nodeIds[2], "30000000"],
	]);

	await client.query(
		`INSERT INTO tasks(
		   id,publisher_id,title,description,acceptance_criteria,deliverable_format,category_id,
		   category_version,currency,deadline,
		   required_capability,visibility,status,status_version
		 ) VALUES ($1,$2,'托管前选择集成测试','验证工作流先选人、冻结报价，再按准确总额托管。',
		   '三阶段报价总和必须等于托管金额','工作流与资金证据',$3,1,
		   'USDC','2026-12-31T00:00:00Z','产品需求、设计与开发','private','planning',1)`,
		[taskId, PUBLISHER, CATEGORY_ID],
	);
	await client.query(
		`INSERT INTO agents(
		   id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,
		   pricing_type,price_amount,price_currency,service_endpoint,email,status
		 ) VALUES ($1,$2,$3,'选择集成测试 Agent',$4,'根据节点契约生成可验收制品',
		   ARRAY['prd','ui/ux','next.js'],'fixed',10000000,'USDC','http://127.0.0.1:3999/execute',
		   'selection-test@example.com','active')`,
		[agentId, PROVIDER, PAYOUT, CATEGORY_ID],
	);
	await client.query(
		`INSERT INTO task_workflow_runs(
		   id,task_id,status,version,currency,total_budget_minor,released_amount_minor,refundable_amount_minor
		 ) VALUES ($1,$2,'planning',1,'USDC',NULL,0,NULL)`,
		[runId, taskId],
	);

	const definitions = [
		[nodeIds[0], "requirements", "requirements", "需求澄清", 20, 0],
		[nodeIds[1], "design", "design", "界面设计", 30, 1],
		[nodeIds[2], "coding", "coding", "代码开发", 50, 2],
	] as const;
	for (const [nodeId, nodeKey, kind, title, weight, position] of definitions) {
		await client.query(
			`INSERT INTO task_workflow_nodes(
			   id,workflow_run_id,task_id,node_key,kind,title,description,category_id,tags,
			   required_capability,input_contract,output_contract,budget_cap_minor,
			   price_preference_weight,position_index,status,version
			 ) VALUES ($1,$2,$3,$4,$5,$6,'托管前生成候选并由发布者选择',$7,
			   ARRAY[$5],$6,'TaskBrief','StageArtifact',NULL,$8,$9,'selecting',1)`,
			[
				nodeId,
				runId,
				taskId,
				nodeKey,
				kind,
				title,
				CATEGORY_ID,
				weight,
				position,
			],
		);
		const quoteMinor = required(quoteMinorByNode.get(nodeId));
		await client.query(
			`INSERT INTO job_distribution_records(
			   id,task_id,workflow_node_id,rule_version,input_fingerprint,input_snapshot,candidates,filter_reasons
			 ) VALUES ($1,$2,$3,'ranking-v1',$4,'{}'::jsonb,$5::jsonb,'{}'::jsonb)`,
			[
				randomUUID(),
				taskId,
				nodeId,
				`selection-${nodeKey}-${randomUUID()}`,
				JSON.stringify([{ agentId, quoteMinor, name: "选择集成测试 Agent" }]),
			],
		);
	}

	return { taskId, runId, agentId, nodeIds, quoteMinorByNode };
}

/** 为指定阶段追加第二个真实候选，测试更换时不能伪造候选 ID 或浏览器报价。 */
async function addReplacementCandidate(
	client: PoolClient,
	fixture: SelectionFixture,
	nodeId: string,
	quoteMinor: string,
): Promise<string> {
	const agentId = randomUUID();
	await client.query(
		`INSERT INTO agents(
		   id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,
		   pricing_type,price_amount,price_currency,service_endpoint,email,status
		 ) VALUES ($1,$2,$3,'替换候选 Agent',$4,'用于验证托管前安全更换 Agent',
		   ARRAY['ui/ux'],'fixed',$5,'USDC','http://127.0.0.1:3998/execute',$6,'active')`,
		[
			agentId,
			`0x${"35".repeat(20)}`,
			`0x${"36".repeat(20)}`,
			CATEGORY_ID,
			quoteMinor,
			`replacement-${agentId}@example.com`,
		],
	);
	await client.query(
		`UPDATE job_distribution_records
		    SET candidates=candidates || $3::jsonb
		  WHERE task_id=$1 AND workflow_node_id=$2`,
		[
			fixture.taskId,
			nodeId,
			JSON.stringify([{ agentId, quoteMinor, name: "替换候选 Agent" }]),
		],
	);
	return agentId;
}

function selectionInput(
	fixture: SelectionFixture,
	nodeId: string,
	keySuffix: string,
) {
	return {
		taskId: fixture.taskId,
		nodeId,
		agentId: fixture.agentId,
		actorId: PUBLISHER,
		idempotencyKey: `${keySuffix}:${randomUUID()}`,
		selectedAt: SELECTED_AT,
	};
}

async function withRollbackClient(
	pool: Pool,
	test: (client: PoolClient) => Promise<void>,
): Promise<void> {
	const client = await pool.connect();
	await client.query("BEGIN");
	try {
		await test(client);
	} finally {
		await client.query("ROLLBACK");
		client.release();
	}
}

/** 把仓储内部事务映射为嵌套 SAVEPOINT，使集成夹具仍能由外层事务统一回滚。 */
function asNestedTransactionDatabase(client: PoolClient): EscrowDatabase {
	const query: EscrowDatabase["query"] = (text, params) =>
		client.query(text, [...params]);
	return {
		query,
		connect: async () => ({
			query: async (text, params) => {
				if (text === "BEGIN")
					return client.query("SAVEPOINT workflow_selection_nested");
				if (text === "COMMIT")
					return client.query("RELEASE SAVEPOINT workflow_selection_nested");
				if (text === "ROLLBACK") {
					await client.query("ROLLBACK TO SAVEPOINT workflow_selection_nested");
					return client.query("RELEASE SAVEPOINT workflow_selection_nested");
				}
				return client.query(text, [...params]);
			},
			release: () => undefined,
		}),
	};
}

function required<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error("EXPECTED_VALUE");
	return value;
}

function requiredDatabaseUrl(): string {
	if (DATABASE_URL === undefined) throw new Error("DATABASE_URL_REQUIRED");
	return DATABASE_URL;
}
