import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgScoringRepository } from "./scoring-repository";
import { PgWorkflowFeedbackRepository } from "./workflow-feedback-repository";

const DATABASE_URL = process.env.DATABASE_URL;
const integration = DATABASE_URL === undefined ? describe.skip : describe;
const CATEGORY_ID = "40000000-0000-4000-8000-000000000001";
const PUBLISHER = `0x${"aB".repeat(20)}`;
const OTHER_PUBLISHER = `0x${"72".repeat(20)}`;
const PROVIDER = `0x${"73".repeat(20)}`;
const PAYOUT = `0x${"74".repeat(20)}`;
const SUBMITTED_AT = new Date("2026-09-02T01:00:00.000Z");

type FeedbackFixture = Readonly<{
	taskId: string;
	nodeId: string;
	agentId: string;
	assignmentId: string;
}>;

/**
 * 真实 PostgreSQL 测试固定反馈最关键的不变量：发布者只能评价已验收节点、节点自动解析
 * 实际 Agent、每阶段只能写一次，并且事件 Webhook 发送给被评价 Agent 而非最后一个节点。
 * 所有夹具都包在回滚事务中，不污染开发数据。
 */
integration("workflow feedback PostgreSQL contract", () => {
	let pool: Pool;

	beforeAll(() => {
		pool = new Pool({ connectionString: requiredDatabaseUrl() });
	});

	afterAll(async () => {
		await pool.end();
	});

	it("writes an accepted node review and exposes it in the Agent scoring history", async () => {
		await withRollbackClient(pool, async (client) => {
			const fixture = await insertFeedbackFixture(client);
			const repository = new PgWorkflowFeedbackRepository(client);

			const result = await repository.submit(
				fixture.taskId,
				fixture.nodeId,
				PUBLISHER,
				{
					quality: 5,
					communication: 4,
					comment: "设计还原准确，页面可以直接体验。",
					strengths: ["design_fidelity", "usability"],
					improvement: "移动端间距可以更紧凑。",
					allowModelTraining: true,
				},
				SUBMITTED_AT,
			);

			expect(result).toMatchObject({
				statusCode: 201,
				body: {
					taskId: fixture.taskId,
					workflowNodeId: fixture.nodeId,
					agentId: fixture.agentId,
				},
			});
			await expect(
				repository.list(fixture.taskId, PUBLISHER),
			).resolves.toMatchObject({
				body: {
					feedback: [
						expect.objectContaining({
							workflowNodeId: fixture.nodeId,
							assignmentId: fixture.assignmentId,
							agentId: fixture.agentId,
							quality: 5,
							communication: 4,
							allowModelTraining: true,
						}),
					],
				},
			});
			const storedFeedback = await client.query<{ id: string }>(
				"SELECT id::text FROM workflow_node_feedback WHERE task_id=$1 AND workflow_node_id=$2",
				[fixture.taskId, fixture.nodeId],
			);
			const feedbackId = storedFeedback.rows[0]?.id;
			expect(feedbackId).toBeDefined();
			const scoring = new PgScoringRepository(client);
			await scoring.computeSnapshots(500, new Date("2026-09-02T02:00:00.000Z"));
			const scoreEvidence = await client.query<{
				input_evidence: { ratingIds: string[] };
			}>(
				`SELECT input_evidence
				   FROM agent_score_snapshots
				  WHERE agent_id=$1
				  ORDER BY computed_at DESC,id DESC
				  LIMIT 1`,
				[fixture.agentId],
			);
			expect(scoreEvidence.rows[0]?.input_evidence.ratingIds).toContain(
				feedbackId,
			);
			await expect(
				client.query(
					`SELECT event.event_type,delivery.agent_id::text
				   FROM task_events event
				   JOIN webhook_deliveries delivery ON delivery.task_event_id=event.id
				  WHERE event.task_id=$1 AND event.event_type='task.workflow_feedback_submitted'`,
					[fixture.taskId],
				),
			).resolves.toMatchObject({
				rows: [
					{
						event_type: "task.workflow_feedback_submitted",
						agent_id: fixture.agentId,
					},
				],
			});
		});
	});

	it("rejects unauthorized, unaccepted, and duplicate feedback", async () => {
		await withRollbackClient(pool, async (client) => {
			const fixture = await insertFeedbackFixture(client);
			const repository = new PgWorkflowFeedbackRepository(client);
			const input = {
				quality: 5,
				communication: 5,
				strengths: [],
				allowModelTraining: false,
			};

			await expect(
				repository.submit(
					fixture.taskId,
					fixture.nodeId,
					OTHER_PUBLISHER,
					input,
					SUBMITTED_AT,
				),
			).rejects.toMatchObject({
				code: "WORKFLOW_NODE_NOT_FOUND",
				statusCode: 404,
			});

			await client.query(
				"UPDATE task_workflow_nodes SET status='awaiting_review',accepted_at=NULL WHERE id=$1",
				[fixture.nodeId],
			);
			await expect(
				repository.submit(
					fixture.taskId,
					fixture.nodeId,
					PUBLISHER.toLowerCase(),
					input,
					SUBMITTED_AT,
				),
			).rejects.toMatchObject({
				code: "WORKFLOW_NODE_NOT_ACCEPTED",
				statusCode: 409,
			});

			await client.query(
				"UPDATE task_workflow_nodes SET status='accepted',accepted_at=$2 WHERE id=$1",
				[fixture.nodeId, SUBMITTED_AT],
			);
			await repository.submit(
				fixture.taskId,
				fixture.nodeId,
				PUBLISHER,
				input,
				SUBMITTED_AT,
			);
			await expect(
				repository.submit(
					fixture.taskId,
					fixture.nodeId,
					PUBLISHER.toLowerCase(),
					input,
					SUBMITTED_AT,
				),
			).rejects.toMatchObject({
				code: "WORKFLOW_FEEDBACK_ALREADY_SUBMITTED",
				statusCode: 409,
			});
		});
	});
});

async function insertFeedbackFixture(
	client: PoolClient,
): Promise<FeedbackFixture> {
	const taskId = randomUUID();
	const runId = randomUUID();
	const nodeId = randomUUID();
	const agentId = randomUUID();
	const distributionId = randomUUID();
	const assignmentId = randomUUID();

	await client.query(
		`INSERT INTO tasks(
		   id,publisher_id,title,description,acceptance_criteria,deliverable_format,category_id,
		   category_version,currency,deadline,required_capability,visibility,status,status_version
		 ) VALUES ($1,$2,'逐阶段反馈集成测试','验证真实 Agent 接单历史。','已验收节点可以评价',
		   '结构化反馈',$3,1,'USDC','2026-12-31T00:00:00Z','产品设计','private','settled',10)`,
		[taskId, PUBLISHER, CATEGORY_ID],
	);
	await client.query(
		`INSERT INTO agents(
		   id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,
		   pricing_type,price_amount,price_currency,service_endpoint,email,status
		 ) VALUES ($1,$2,$3,'反馈集成测试 Agent',$4,'生成可以直接验收的设计稿',ARRAY['ui/ux'],
		   'fixed',10000000,'USDC','http://127.0.0.1:3997/execute',$5,'active')`,
		[agentId, PROVIDER, PAYOUT, CATEGORY_ID, `feedback-${agentId}@example.com`],
	);
	await client.query(
		`INSERT INTO task_workflow_runs(
		   id,task_id,status,version,currency,total_budget_minor,released_amount_minor,refundable_amount_minor
		 ) VALUES ($1,$2,'completed',4,'USDC',10000000,10000000,0)`,
		[runId, taskId],
	);
	await client.query(
		`INSERT INTO task_workflow_nodes(
		   id,workflow_run_id,task_id,node_key,kind,title,description,category_id,tags,
		   required_capability,input_contract,output_contract,budget_cap_minor,
		   price_preference_weight,position_index,status,version,accepted_at
		 ) VALUES ($1,$2,$3,'design','design','界面设计','生成可验收设计稿',$4,ARRAY['ui/ux'],
		   '产品界面设计','RequirementsArtifact','DesignArtifact',10000000,100,0,'accepted',4,$5)`,
		[nodeId, runId, taskId, CATEGORY_ID, SUBMITTED_AT],
	);
	await client.query(
		`INSERT INTO job_distribution_records(
		   id,task_id,workflow_node_id,rule_version,input_fingerprint,input_snapshot,candidates,
		   filter_reasons,final_selection_agent_id
		 ) VALUES ($1,$2,$3,'ranking-v1',$4,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb,$5)`,
		[distributionId, taskId, nodeId, `feedback-${randomUUID()}`, agentId],
	);
	await client.query(
		`UPDATE task_workflow_nodes
		    SET selected_agent_id=$2,selection_record_id=$3,agreed_amount_minor=10000000
		  WHERE id=$1`,
		[nodeId, agentId, distributionId],
	);
	await client.query(
		`INSERT INTO task_assignments(
		   id,task_id,workflow_node_id,agent_id,distribution_record_id,agreed_amount_minor,status,
		   version,assigned_by,accept_by,responded_at
		 ) VALUES ($1,$2,$3,$4,$5,10000000,'accepted',2,'workflow-feedback-test',
		   $6::timestamptz + interval '1 hour',$6::timestamptz)`,
		[assignmentId, taskId, nodeId, agentId, distributionId, SUBMITTED_AT],
	);

	return { taskId, nodeId, agentId, assignmentId };
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

function requiredDatabaseUrl(): string {
	if (DATABASE_URL === undefined) throw new Error("DATABASE_URL_REQUIRED");
	return DATABASE_URL;
}
