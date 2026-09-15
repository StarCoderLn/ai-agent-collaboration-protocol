import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PgScoringRepository } from "../scoring/scoring-repository";
import { emitTaskEvent } from "./task-event-repository";

const DATABASE_URL = process.env.DATABASE_URL;
const integration = DATABASE_URL === undefined ? describe.skip : describe;
const CATEGORY_ID = "40000000-0000-4000-8000-000000000001";

/**
 * 真实数据库用例验证接入模式与生命周期通知的边界。每个用例都在事务中运行并回滚，
 * 不会污染用户正在体验的任务或 Agent；没有显式 DATABASE_URL 时自动跳过。
 */
integration("任务事件按 Agent 接入模式创建 Webhook", () => {
	let pool: Pool;

	beforeAll(() => {
		pool = new Pool({ connectionString: requiredDatabaseUrl() });
	});

	afterAll(async () => {
		await pool.end();
	});

	it("HMAC Agent 创建 outbox，评分相关事件同时合并刷新请求", async () => {
		const client = await pool.connect();
		await client.query("BEGIN");
		try {
			const taskId = "91000000-0000-4000-8000-000000000011";
			const agentId = "91000000-0000-4000-8000-000000000012";
			const distributionId = "91000000-0000-4000-8000-000000000013";
			const assignmentId = "91000000-0000-4000-8000-000000000014";

			await client.query(
				`INSERT INTO tasks (
           id,publisher_id,title,description,acceptance_criteria,deliverable_format,
           category_id,category_version,tag_names,pricing_type,budget_min_minor,budget_max_minor,
           currency,deadline,required_capability,attachments,visibility,status,status_version,
           assignment_mode_config,acceptance_mode,acceptor_config
         ) VALUES ($1,'publisher-webhook-mode','接入模式通知测试','验证快速接入不会收到生命周期 Webhook。',
           'HMAC 产生一条投递，快速模式不产生。','集成测试证据',$2,1,ARRAY['agent'],
           'fixed',1000000,1000000,'USDC','2026-12-31T00:00:00Z','HTTP Agent',
           '[]'::jsonb,'private','executing',0,'{"mode":"manual"}'::jsonb,'manual','{}'::jsonb)`,
				[taskId, CATEGORY_ID],
			);
			await client.query(
				`INSERT INTO agents (
           id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,
           pricing_type,price_amount,price_currency,service_endpoint,integration_mode,status,
           estimated_duration_seconds,response_minutes
         ) VALUES ($1,'0x9191919191919191919191919191919191919191',
           '0x9292929292929292929292929292929292929292','通知模式测试 Agent',$2,
           '验证生命周期通知按接入模式隔离。',ARRAY['agent'],'fixed',1000000,'USDC',
           'http://127.0.0.1:3999/run','aicp_hmac','active',60,1)`,
				[agentId, CATEGORY_ID],
			);
			await client.query(
				`INSERT INTO job_distribution_records (
           id,task_id,rule_version,input_fingerprint,input_snapshot,candidates,filter_reasons
         ) VALUES ($1,$2,'ranking-v1','webhook-mode-fixture','{}'::jsonb,$3::jsonb,'{}'::jsonb)`,
				[distributionId, taskId, JSON.stringify([{ agentId }])],
			);
			await client.query(
				`INSERT INTO task_assignments (
           id,task_id,agent_id,distribution_record_id,agreed_amount_minor,status,assigned_by,accept_by
         ) VALUES ($1,$2,$3,$4,1000000,'accepted','publisher-webhook-mode',now()+interval '5 minutes')`,
				[assignmentId, taskId, agentId, distributionId],
			);

			await emitTaskEvent(client, event(taskId, 1n, "task.hmac_event"));
			await client.query(
				"UPDATE agents SET integration_mode='http_json' WHERE id=$1",
				[agentId],
			);
			await emitTaskEvent(client, event(taskId, 2n, "task.quick_event"));
			await emitTaskEvent(client, event(taskId, 3n, "task.rated"));
			await emitTaskEvent(
				client,
				event(taskId, 4n, "task.settlement_confirmed"),
			);

			const evidence = await client.query<{
				events: string;
				deliveries: string;
				delivery_event: string;
				refresh_requests: string;
				refresh_reason: string;
			}>(
				`SELECT
           (SELECT count(*)::text FROM task_events WHERE task_id=$1) AS events,
           (SELECT count(*)::text FROM webhook_deliveries delivery
              JOIN task_events event ON event.id=delivery.task_event_id WHERE event.task_id=$1) AS deliveries,
           (SELECT min(event.event_type) FROM webhook_deliveries delivery
              JOIN task_events event ON event.id=delivery.task_event_id WHERE event.task_id=$1) AS delivery_event,
           (SELECT count(*)::text FROM agent_score_refresh_requests WHERE agent_id=$2) AS refresh_requests,
           (SELECT event.event_type FROM agent_score_refresh_requests request
              JOIN task_events event ON event.id=request.reason_event_id
             WHERE request.agent_id=$2) AS refresh_reason`,
				[taskId, agentId],
			);
			expect(evidence.rows[0]).toEqual({
				events: "4",
				deliveries: "1",
				delivery_event: "task.hmac_event",
				refresh_requests: "1",
				refresh_reason: "task.settlement_confirmed",
			});

			// 定向 Worker 消费永久队列表，写入快照后才删除请求；整个测试事务最终回滚，
			// 因此既验证真实表协作，也不留下 Agent、事件或快照夹具。
			const snapshots = await new PgScoringRepository(
				client,
			).computeRequestedSnapshots(10, new Date("2026-09-03T08:00:05.000Z"));
			expect(snapshots).toHaveLength(1);
			const remaining = await client.query<{ count: string }>(
				"SELECT count(*)::text AS count FROM agent_score_refresh_requests WHERE agent_id=$1",
				[agentId],
			);
			expect(remaining.rows[0]?.count).toBe("0");
		} finally {
			await client.query("ROLLBACK");
			client.release();
		}
	});
});

function event(taskId: string, statusVersion: bigint, eventType: string) {
	return {
		taskId,
		statusVersion,
		eventType,
		payload: { status: "executing" },
		createdAt: new Date("2026-09-03T08:00:00.000Z"),
	} as const;
}

function requiredDatabaseUrl(): string {
	if (DATABASE_URL === undefined) throw new Error("DATABASE_URL_REQUIRED");
	return DATABASE_URL;
}
