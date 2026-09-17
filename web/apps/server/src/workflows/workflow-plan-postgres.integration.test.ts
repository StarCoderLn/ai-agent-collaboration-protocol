import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EditableWorkflowPlan } from "./workflow-plan-contract";
import {
	appendOwnedWorkflowPlanRevision,
	confirmOwnedWorkflowPlan,
	createInitialWorkflowPlan,
	readOwnedWorkflowPlan,
	recoverUnfundedWorkflowPlan,
	WorkflowPlanRepositoryError,
} from "./workflow-plan-repository";

const DATABASE_URL = process.env.DATABASE_URL;
const integration = DATABASE_URL === undefined ? describe.skip : describe;
const CATEGORY_ID = "40000000-0000-4000-8000-000000000001";
const RESEARCH_CATEGORY_ID = "40000000-0000-4000-8000-000000000002";
const PUBLISHER = "0x1111111111111111111111111111111111111111";
const EXECUTOR_OWNER = "0x2222222222222222222222222222222222222222";
const RESEARCH_AGENT = "10000000-0000-4000-8000-000000000091";
const DELIVERY_AGENT = "10000000-0000-4000-8000-000000000092";

const plan: EditableWorkflowPlan = {
	summary: "先研究需求，再完成交付。",
	assumptions: ["用户会提供必要背景材料"],
	nodes: [
		{
			key: "research",
			kind: "research",
			title: "需求研究",
			description: "分析任务背景并形成结构化结论。",
			tags: ["research"],
			requiredCapability: "研究分析",
			inputContract: "TaskContract",
			outputContract: "ResearchReport",
			budgetWeight: 40,
		},
		{
			key: "delivery",
			kind: "generic",
			title: "成果交付",
			description: "消费研究报告并完成最终交付。",
			tags: ["delivery"],
			requiredCapability: "内容交付",
			inputContract: "ResearchReport",
			outputContract: "TaskArtifact",
			budgetWeight: 60,
		},
	],
	edges: [
		{
			sourceKey: "research",
			targetKey: "delivery",
			artifactContract: "ResearchReport",
		},
	],
};

/**
 * 该测试只在显式提供本机 DATABASE_URL 时运行。所有写入都包在单个事务中并最终回滚，
 * 因而能验证真实约束和事务语义，同时不会把测试任务、修订或工作流留在体验数据库。
 */
integration("workflow plan PostgreSQL lifecycle", () => {
	let pool: Pool;

	beforeAll(() => {
		pool = new Pool({ connectionString: requiredDatabaseUrl() });
	});

	afterAll(async () => {
		await pool.end();
	});

	it("版本化保存草案，并在确认事务中只固化正式 DAG", async () => {
		const client = await pool.connect();
		await client.query("BEGIN");
		try {
			const createdTask = await client.query<{ id: string }>(
				`INSERT INTO tasks (
				 publisher_id,title,description,acceptance_criteria,deliverable_format,
				 category_id,category_version,tag_names,currency,deadline,required_capability,
				 attachments,visibility,status,status_version,assignment_mode_config,
				 acceptance_mode,acceptor_config
				) VALUES ($1,'AI 工作流集成测试','验证草案和正式执行图严格分离。',
				 '修订可审计且确认后不可再编辑。','集成测试报告',$2,1,ARRAY['agent'],
				 'USDC',now()+interval '1 day','研究与交付','[]'::jsonb,'private','planning',1,
				 '{"mode":"manual"}'::jsonb,'manual','{}'::jsonb) RETURNING id::text`,
				[PUBLISHER, CATEGORY_ID],
			);
			const taskId = requiredRow(createdTask.rows[0]).id;
			await client.query(
				`INSERT INTO agents(
				 id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,
				 pricing_type,price_amount,price_currency,service_endpoint,email,status
				) VALUES
				 ($1,$3,$3,'研究协议测试 Agent',$4,'研究并输出报告',ARRAY['research'],
				  'fixed',1000000,'USDC','http://127.0.0.1:3999/research','plan-research@example.com','active'),
				 ($2,$3,$3,'交付协议测试 Agent',$5,'消费报告并完成交付',ARRAY['delivery'],
				  'fixed',1000000,'USDC','http://127.0.0.1:3999/delivery','plan-delivery@example.com','active')`,
				[
					RESEARCH_AGENT,
					DELIVERY_AGENT,
					EXECUTOR_OWNER,
					RESEARCH_CATEGORY_ID,
					CATEGORY_ID,
				],
			);
			await client.query(
				`INSERT INTO agent_workflow_contracts(agent_id,input_contract,output_contract)
				 VALUES ($1,'TaskContract','ResearchReport'),
				        ($2,'ResearchReport','TaskArtifact')`,
				[RESEARCH_AGENT, DELIVERY_AGENT],
			);

			const initial = await createInitialWorkflowPlan(
				client,
				taskId,
				PUBLISHER,
			);
			expect(initial).toMatchObject({
				revision: "1",
				version: "1",
				status: "draft",
				source: "template",
			});

			const generated = await appendOwnedWorkflowPlanRevision(client, {
				taskId,
				actorId: PUBLISHER,
				expectedVersion: initial.version,
				source: "ai",
				provider: "deepseek",
				model: "deepseek-chat",
				promptVersion: "workflow-plan-v2",
				plan,
			});
			expect(generated).toMatchObject({
				revision: "2",
				version: "2",
				source: "ai",
				provider: "deepseek",
			});

			await expect(
				appendOwnedWorkflowPlanRevision(client, {
					taskId,
					actorId: PUBLISHER,
					expectedVersion: "1",
					source: "user",
					plan,
				}),
			).rejects.toMatchObject({
				code: "WORKFLOW_PLAN_VERSION_CONFLICT",
			});

			const editedPlan = structuredClone(plan);
			const delivery = editedPlan.nodes.find((node) => node.key === "delivery");
			if (delivery === undefined) throw new Error("DELIVERY_NODE_MISSING");
			delivery.title = "最终成果交付";
			const edited = await appendOwnedWorkflowPlanRevision(client, {
				taskId,
				actorId: PUBLISHER,
				expectedVersion: generated.version,
				source: "user",
				plan: editedPlan,
			});
			expect(edited).toMatchObject({
				revision: "3",
				version: "3",
				source: "user",
			});

			// 目录能力在确认瞬间不可用时，事务必须停在草案状态，不能先创建一张
			// 永远没有候选的正式 DAG。恢复 Agent 后同一版本仍可正常确认。
			await client.query("UPDATE agents SET status='paused' WHERE id=$1", [
				DELIVERY_AGENT,
			]);
			await expect(
				confirmOwnedWorkflowPlan(client, {
					taskId,
					actorId: PUBLISHER,
					expectedVersion: edited.version,
				}),
			).rejects.toMatchObject({
				code: "WORKFLOW_PLAN_NO_EXECUTABLE_AGENT",
			});
			const rejectedFacts = await client.query<{ runs: string }>(
				"SELECT count(*)::text AS runs FROM task_workflow_runs WHERE task_id=$1",
				[taskId],
			);
			expect(requiredRow(rejectedFacts.rows[0]).runs).toBe("0");
			await client.query("UPDATE agents SET status='active' WHERE id=$1", [
				DELIVERY_AGENT,
			]);

			const confirmed = await confirmOwnedWorkflowPlan(client, {
				taskId,
				actorId: PUBLISHER,
				expectedVersion: edited.version,
			});
			expect(confirmed.plan).toMatchObject({
				status: "confirmed",
				version: "4",
				revision: "3",
				source: "user",
			});
			expect(confirmed.workflow.nodes.map((node) => node.title)).toEqual([
				"需求研究",
				"最终成果交付",
			]);
			expect(confirmed.workflow.edges).toHaveLength(1);

			const facts = await client.query<{
				revisions: string;
				runs: string;
				nodes: string;
				edges: string;
				candidates: string;
				escrows: string;
			}>(
				`SELECT
				 (SELECT count(*)::text FROM task_workflow_plan_revisions WHERE task_id=$1) revisions,
				 (SELECT count(*)::text FROM task_workflow_runs WHERE task_id=$1) runs,
				 (SELECT count(*)::text FROM task_workflow_nodes WHERE task_id=$1) nodes,
				 (SELECT count(*)::text FROM task_workflow_edges edge
				  JOIN task_workflow_runs run ON run.id=edge.workflow_run_id WHERE run.task_id=$1) edges,
				 (SELECT count(*)::text FROM job_distribution_records WHERE task_id=$1) candidates,
				 (SELECT count(*)::text FROM escrow_intents WHERE task_id=$1) escrows`,
				[taskId],
			);
			expect(requiredRow(facts.rows[0])).toEqual({
				revisions: "3",
				runs: "1",
				nodes: "2",
				edges: "1",
				candidates: "0",
				escrows: "0",
			});

			await expect(
				appendOwnedWorkflowPlanRevision(client, {
					taskId,
					actorId: PUBLISHER,
					expectedVersion: confirmed.plan.version,
					source: "user",
					plan,
				}),
			).rejects.toBeInstanceOf(WorkflowPlanRepositoryError);
			await expect(
				readOwnedWorkflowPlan(client, taskId, PUBLISHER),
			).resolves.toMatchObject({ status: "confirmed" });

			const workflowNodes = await client.query<{ id: string }>(
				"SELECT id::text FROM task_workflow_nodes WHERE task_id=$1 ORDER BY position_index",
				[taskId],
			);
			const firstNodeId = requiredRow(workflowNodes.rows[0]).id;
			const distribution = await client.query<{ id: string }>(
				`INSERT INTO job_distribution_records(
				   task_id,workflow_node_id,rule_version,input_fingerprint,input_snapshot,candidates,
				   filter_reasons,final_selection_agent_id
				 ) VALUES ($1,$2,'ranking-v1','workflow-recovery-candidate','{}'::jsonb,
				   $3::jsonb,'{}'::jsonb,NULL) RETURNING id::text`,
				[
					taskId,
					firstNodeId,
					JSON.stringify([{ agentId: RESEARCH_AGENT, quoteMinor: "1000000" }]),
				],
			);
			const distributionId = requiredRow(distribution.rows[0]).id;
			await client.query(
				`INSERT INTO matching_candidate_exposures(
				   event_key,view_session_id,distribution_record_id,task_id,workflow_node_id,
				   agent_id,actor_id,position,visible_millis,data_origin,occurred_at
				 ) VALUES ('workflow-recovery-exposure','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
				   $1,$2,$3,$4,$5,1,1200,'real',now())`,
				[distributionId, taskId, firstNodeId, RESEARCH_AGENT, PUBLISHER],
			);
			await client.query(
				`INSERT INTO matching_v2_shadow_jobs(
				   distribution_record_id,feature_schema_version,request_payload
				 ) VALUES ($1,'matching-v2-feature-v1',$2::jsonb)`,
				[
					distributionId,
					JSON.stringify({ candidates: [{ agentId: RESEARCH_AGENT }] }),
				],
			);
			await client.query(
				`INSERT INTO workflow_node_events(
				   workflow_node_id,task_id,node_version,event_type,payload
				 ) VALUES ($1,$2,1,'workflow_node.plan_confirmed','{}'::jsonb)`,
				[firstNodeId, taskId],
			);

			// 一旦出现分配或托管事实，即使它们尚未完成，恢复也必须拒绝；清除测试事实后
			// 同一工作流才可进入“先归档、再重建”的安全恢复路径。
			await client.query(
				`INSERT INTO task_assignments(
				   task_id,workflow_node_id,agent_id,distribution_record_id,agreed_amount_minor,
				   status,assigned_by,accept_by
				 ) VALUES ($1,$2,$3,$4,1000000,'pending_ack',$5,now()+interval '5 minutes')`,
				[taskId, firstNodeId, RESEARCH_AGENT, distributionId, PUBLISHER],
			);
			await expect(
				recoverUnfundedWorkflowPlan(client, {
					taskId,
					actorId: PUBLISHER,
					reason: "集成测试验证不可执行工作流的安全恢复",
				}),
			).rejects.toMatchObject({
				code: "WORKFLOW_PLAN_RECOVERY_HAS_EXECUTION_FACTS",
			});
			await client.query("DELETE FROM task_assignments WHERE task_id=$1", [
				taskId,
			]);

			await client.query(
				`INSERT INTO escrow_intents(
				   task_id,chain_id,contract_address,task_key,payer_wallet,amount_minor,status
				 ) VALUES ($1,11155111,$2,$3,$4,1000000,'prepared')`,
				[taskId, `0x${"11".repeat(20)}`, `0x${"22".repeat(32)}`, PUBLISHER],
			);
			await expect(
				recoverUnfundedWorkflowPlan(client, {
					taskId,
					actorId: PUBLISHER,
					reason: "集成测试验证不可执行工作流的安全恢复",
				}),
			).rejects.toMatchObject({
				code: "WORKFLOW_PLAN_RECOVERY_HAS_EXECUTION_FACTS",
			});
			await client.query("DELETE FROM escrow_intents WHERE task_id=$1", [
				taskId,
			]);

			const recovered = await recoverUnfundedWorkflowPlan(client, {
				taskId,
				actorId: PUBLISHER,
				reason: "集成测试验证不可执行工作流的安全恢复",
			});
			expect(recovered.plan).toMatchObject({
				status: "draft",
				version: "5",
				revision: "3",
			});
			const recoveryFacts = await client.query<{
				archives: string;
				runs: string;
				nodes: string;
				distributions: string;
				exposures: string;
				shadow_jobs: string;
				archived_nodes: number;
				archived_distributions: number;
				archived_exposures: number;
				archived_shadow_jobs: number;
			}>(
				`SELECT
				 (SELECT count(*)::text FROM workflow_plan_recovery_archives WHERE task_id=$1) archives,
				 (SELECT count(*)::text FROM task_workflow_runs WHERE task_id=$1) runs,
				 (SELECT count(*)::text FROM task_workflow_nodes WHERE task_id=$1) nodes,
				 (SELECT count(*)::text FROM job_distribution_records WHERE task_id=$1) distributions,
				 (SELECT count(*)::text FROM matching_candidate_exposures WHERE task_id=$1) exposures,
				 (SELECT count(*)::text FROM matching_v2_shadow_jobs job JOIN job_distribution_records record
				   ON record.id=job.distribution_record_id WHERE record.task_id=$1) shadow_jobs,
				 jsonb_array_length(snapshot->'nodes') archived_nodes,
				 jsonb_array_length(snapshot->'distributionRecords') archived_distributions,
				 jsonb_array_length(snapshot->'candidateExposures') archived_exposures,
				 jsonb_array_length(snapshot->'shadowJobs') archived_shadow_jobs
				 FROM workflow_plan_recovery_archives WHERE id=$2`,
				[taskId, recovered.archiveId],
			);
			expect(requiredRow(recoveryFacts.rows[0])).toEqual({
				archives: "1",
				runs: "0",
				nodes: "0",
				distributions: "0",
				exposures: "0",
				shadow_jobs: "0",
				archived_nodes: 2,
				archived_distributions: 1,
				archived_exposures: 1,
				archived_shadow_jobs: 1,
			});
		} finally {
			await client.query("ROLLBACK");
			client.release();
		}
	});
});

function requiredDatabaseUrl(): string {
	if (DATABASE_URL === undefined) throw new Error("DATABASE_URL_REQUIRED");
	return DATABASE_URL;
}

function requiredRow<T>(row: T | undefined): T {
	if (row === undefined) throw new Error("EXPECTED_DATABASE_ROW");
	return row;
}
