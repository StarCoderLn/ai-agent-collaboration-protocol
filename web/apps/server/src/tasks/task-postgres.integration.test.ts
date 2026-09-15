import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PgAuditLogWriter } from "../audit/audit-log-writer";
import {
	Idempotency,
	PgIdempotencyStore,
} from "../idempotency/idempotency-store";
import { PgScoringRepository } from "../scoring/scoring-repository";
import { createScoringService } from "../scoring/scoring-service";
import {
	ensureFormalWorkflow,
	readOwnedFormalWorkflow,
} from "../workflows/workflow-repository";
import { PgDispatchTransitionRepository } from "./dispatch-transition-repository";
import { PgExecutionRepository } from "./execution-repository";
import { createExecutionService } from "./execution-service";
import { scanExecutionTimeouts } from "./execution-timeout";
import { emitTaskEvent, PgTaskEventReader } from "./task-event-repository";
import {
	getMarketStats,
	getTaskDetail,
	listPublisherTasks,
	listTaskMarket,
} from "./task-market-service";
import { PgTaskRepository } from "./task-repository";
import {
	archiveOwnedTask,
	createTaskDraft,
	editTaskDraft,
	PgTaskEventWriter,
	previewOwnedTask,
	submitTaskDraft,
	type TaskCommandDeps,
	updateOwnedTaskMatchCriteria,
	updateOwnedTaskModeSettings,
} from "./task-service";

const DATABASE_URL = process.env.DATABASE_URL;
const integration = DATABASE_URL === undefined ? describe.skip : describe;
const CATEGORY_ID = "40000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-23T00:00:00.000Z");

/** 归档集成用例复用完整发布形状，避免把字段完整性和归档行为混在同一断言中。 */
function validPublishedDraftInput() {
	return {
		title: "完整的规划阶段任务",
		description:
			"验证规划阶段任务可以从产品界面删除，同时保留工作流和审计证据。",
		acceptanceCriteria: "工作台、市场和详情不再展示，数据库关联证据仍然存在。",
		deliverableFormat: "集成测试证据",
		categoryId: CATEGORY_ID,
		tags: ["agent"],
		currency: "USDC",
		deadline: "2026-08-23T03:00:00.000Z",
		requiredCapability: "任务生命周期与 PostgreSQL",
		attachments: [],
		visibility: "public" as const,
		assignmentMode: { mode: "manual" as const },
		acceptanceMode: { mode: "manual" as const },
	};
}

/**
 * 这组测试只在显式提供 DATABASE_URL 时运行。每个用例使用真实 PostgreSQL 事务并在
 * finally 中回滚，所以能验证 SQL、约束和原子协作，同时不会给开发数据库留下测试任务。
 */
integration("task PostgreSQL vertical slice", () => {
	let pool: Pool;

	beforeAll(() => {
		pool = new Pool({ connectionString: requiredDatabaseUrl() });
	});

	afterAll(async () => {
		await pool.end();
	});

	it("persists an incomplete draft, protects non-draft completeness, then edits and submits atomically", async () => {
		const client = await pool.connect();
		await client.query("BEGIN");
		try {
			const deps = postgresDeps(client);
			const created = await createTaskDraft(
				{ title: "先保存一个尚未完成的真实草稿" },
				"publisher-integration",
				"pg-create-1",
				deps,
			);
			const taskId = requiredString(created.body.taskId);
			expect(
				(await deps.repository.findOwned(taskId, "publisher-integration"))
					?.draft.categoryId,
			).toBeNull();

			// 绕过服务层直接推进半成品时，数据库条件约束仍会拒绝，证明完整性不是只靠 UI。
			await client.query("SAVEPOINT incomplete_transition");
			await expect(
				client.query("UPDATE tasks SET status='awaiting_escrow' WHERE id=$1", [
					taskId,
				]),
			).rejects.toMatchObject({ code: "23514" });
			await client.query("ROLLBACK TO SAVEPOINT incomplete_transition");

			const completePatch = {
				description:
					"实现真实 PostgreSQL 草稿保存、发布预览和提交状态迁移，并提供可重复的集成测试证据。",
				acceptanceCriteria:
					"真实数据库中状态版本单调递增，事件、审计与任务写入位于同一事务。",
				deliverableFormat: "TypeScript 源码、SQL migration 与测试报告",
				categoryId: CATEGORY_ID,
				tags: ["NextJS", "Agent"],
				pricing: { type: "fixed", amountMinor: "10000000" },
				currency: "USDC",
				deadline: "2026-08-23T02:00:00.000Z",
				requiredCapability: "Next.js、PostgreSQL 与严格 TypeScript",
				attachments: [],
				visibility: "public",
				assignmentMode: { mode: "manual" },
				acceptanceMode: { mode: "manual" },
			};
			const edited = await editTaskDraft(
				taskId,
				completePatch,
				"publisher-integration",
				"pg-edit-1",
				deps,
			);
			expect(edited.body.statusVersion).toBe("1");
			const preview = await previewOwnedTask(
				taskId,
				"publisher-integration",
				deps,
			);
			expect(preview.body).toMatchObject({
				valid: true,
				platformFeeMinor: "50000",
				agentReceivesMinor: "9950000",
			});

			const submitted = await submitTaskDraft(
				taskId,
				"publisher-integration",
				"pg-submit-1",
				deps,
			);
			expect(submitted.body).toMatchObject({
				status: "planning",
				statusVersion: "2",
			});
			const eventRows = await client.query<{
				status_version: string;
				event_type: string;
			}>(
				"SELECT status_version::text, event_type FROM task_events WHERE task_id=$1",
				[taskId],
			);
			expect(eventRows.rows).toEqual([
				{ status_version: "2", event_type: "task.submitted" },
			]);
			const auditRows = await client.query<{ action: string }>(
				"SELECT action FROM audit_logs WHERE target_type='task' AND target_id=$1 ORDER BY created_at, action",
				[taskId],
			);
			expect(auditRows.rows.map((row) => row.action).sort()).toEqual([
				"task.create",
				"task.edit",
				"task.submit",
			]);
		} finally {
			await client.query("ROLLBACK");
			client.release();
		}
	});

	it("lists incomplete and private drafts only for their authenticated publisher", async () => {
		const client = await pool.connect();
		await client.query("BEGIN");
		try {
			const deps = postgresDeps(client);
			const publisherA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
			const publisherB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
			const privateDraft = await createTaskDraft(
				{
					title: "只属于发布者 A 的私密草稿",
					visibility: "private",
				},
				publisherA,
				"pg-owned-private-a",
				deps,
			);
			await createTaskDraft(
				{ title: "发布者 B 的草稿" },
				publisherB,
				"pg-owned-private-b",
				deps,
			);

			const owned = await listPublisherTasks(
				publisherA,
				"http://api.local/api/my-tasks?limit=100&offset=0",
				new PgTaskRepository(client),
			);
			const tasks = owned.body.tasks as readonly Record<string, unknown>[];

			expect(tasks).toHaveLength(1);
			expect(tasks[0]).toMatchObject({
				id: privateDraft.body.taskId,
				title: "只属于发布者 A 的私密草稿",
				visibility: "private",
				status: "draft",
				categoryId: null,
				pricing: null,
				deadline: null,
			});
			expect(tasks[0]).not.toHaveProperty("publisherId");
			expect(tasks[0]).not.toHaveProperty("attachments");
		} finally {
			await client.query("ROLLBACK");
			client.release();
		}
	});

	it("soft-archives a planning task while retaining its row, workflow, event, and audit evidence", async () => {
		const client = await pool.connect();
		await client.query("BEGIN");
		try {
			const publisher = "0xcccccccccccccccccccccccccccccccccccccccc";
			const deps = postgresDeps(client);
			const created = await createTaskDraft(
				{
					...validPublishedDraftInput(),
					title: "可安全归档的规划阶段任务",
				},
				publisher,
				"pg-archive-create",
				deps,
			);
			const taskId = requiredString(created.body.taskId);
			await submitTaskDraft(taskId, publisher, "pg-archive-submit", deps);

			await expect(
				archiveOwnedTask(taskId, publisher, "pg-archive-command", deps),
			).resolves.toMatchObject({ body: { taskId, archived: true } });

			const repository = new PgTaskRepository(client);
			await expect(repository.findOwned(taskId, publisher)).resolves.toBeNull();
			const owned = await listPublisherTasks(
				publisher,
				"http://api.local/api/my-tasks?limit=100&offset=0",
				repository,
			);
			expect(owned.body.tasks).toEqual([]);

			// 软归档不仅要从列表隐藏，也必须关闭各个发布者直读入口；否则旧页面、
			// SSE 重连或直接调用状态接口仍能绕过“已删除”的产品语义读取保留数据。
			await expect(
				readOwnedFormalWorkflow(client, taskId, publisher),
			).rejects.toMatchObject({ code: "TASK_NOT_FOUND", statusCode: 404 });
			await expect(
				new PgTaskEventReader(client).canRead(taskId, publisher),
			).resolves.toBe(false);
			await expect(
				new PgExecutionRepository(client).readStatus(taskId, publisher),
			).rejects.toMatchObject({ code: "TASK_NOT_FOUND", statusCode: 404 });
			await expect(
				new PgExecutionRepository(client).listResults(taskId, publisher),
			).rejects.toMatchObject({ code: "TASK_NOT_FOUND", statusCode: 404 });

			const retained = await client.query<{ archived_at: Date | null }>(
				"SELECT archived_at FROM tasks WHERE id=$1",
				[taskId],
			);
			expect(retained.rows[0]?.archived_at).toBeInstanceOf(Date);
			await expect(
				client.query("SELECT 1 FROM task_workflow_runs WHERE task_id=$1", [
					taskId,
				]),
			).resolves.toMatchObject({ rowCount: 1 });
			const evidence = await client.query<{ event_type: string }>(
				"SELECT event_type FROM task_events WHERE task_id=$1 ORDER BY created_at",
				[taskId],
			);
			expect(evidence.rows.map((row) => row.event_type)).toEqual([
				"task.submitted",
				"task.archived",
			]);
			const audits = await client.query<{ action: string }>(
				"SELECT action FROM audit_logs WHERE target_type='task' AND target_id=$1 ORDER BY created_at",
				[taskId],
			);
			expect(audits.rows.map((row) => row.action)).toContain("task.archive");
		} finally {
			await client.query("ROLLBACK");
			client.release();
		}
	});

	it("serves the public market projection, separate stats, and database-guarded mode settings", async () => {
		const client = await pool.connect();
		await client.query("BEGIN");
		try {
			const deps = postgresDeps(client);
			const repository = new PgTaskRepository(client);
			// 本地验收库会保留可体验的市场任务；统计契约应验证本次事务带来的增量，
			// 而不是错误假设测试库在执行前一定为空。
			const statsBefore = requiredMarketStats(
				(await getMarketStats(repository)).body.stats,
			);
			const created = await createTaskDraft(
				{
					title: "公开市场的真实 PostgreSQL 任务",
					description:
						"验证公开市场列表、详情脱敏、模式配置约束与独立统计查询不会泄漏发布者和附件。",
					acceptanceCriteria:
						"列表和详情返回完全相同的公开投影，数据库拒绝无验收器的自动验收。",
					deliverableFormat: "集成测试证据",
					categoryId: CATEGORY_ID,
					tags: ["nextjs", "agent"],
					pricing: { type: "fixed", amountMinor: "15000000" },
					currency: "USDC",
					deadline: "2026-08-23T03:00:00.000Z",
					requiredCapability: "Next.js 与 SQL",
					attachments: [],
					visibility: "public",
				},
				"0x1111111111111111111111111111111111111111",
				"pg-market-create",
				deps,
			);
			const taskId = requiredString(created.body.taskId);
			await updateOwnedTaskModeSettings(
				taskId,
				{
					assignmentMode: {
						mode: "automatic",
						priceCapMinor: "14000000",
						rankingBasis: "ranking-v1",
						fallbackOnFail: "manual",
					},
				},
				"0x1111111111111111111111111111111111111111",
				"pg-mode-1",
				deps,
			);
			await submitTaskDraft(
				taskId,
				"0x1111111111111111111111111111111111111111",
				"pg-market-submit",
				deps,
			);
			// Feature 6 的链事件集成测试负责证明 awaiting_escrow→matching；本用例只准备市场可见状态。
			await client.query(
				"UPDATE tasks SET status='matching', status_version=status_version+1 WHERE id=$1",
				[taskId],
			);

			const market = await listTaskMarket(
				"http://api.local/api/market/tasks?status=matching",
				repository,
			);
			const publicTask = (
				market.body.tasks as readonly Record<string, unknown>[]
			).find((entry) => entry.id === taskId);
			expect(publicTask).toBeDefined();
			expect(publicTask).not.toHaveProperty("publisherId");
			expect(publicTask).not.toHaveProperty("attachments");
			await expect(
				getTaskDetail(taskId, null, repository),
			).resolves.toMatchObject({
				body: { task: publicTask, access: "public" },
			});
			const statsAfterResult = await getMarketStats(repository);
			expect(statsAfterResult.body.source).toBe("public_market");
			expect(requiredMarketStats(statsAfterResult.body.stats)).toMatchObject({
				total: statsBefore.total + 1,
				matching: statsBefore.matching + 1,
			});

			await client.query("SAVEPOINT invalid_acceptor");
			await expect(
				client.query(
					"UPDATE tasks SET acceptance_mode='automatic', acceptor_config='{}'::jsonb WHERE id=$1",
					[taskId],
				),
			).rejects.toMatchObject({ code: "23514" });
			await client.query("ROLLBACK TO SAVEPOINT invalid_acceptor");

			await client.query("UPDATE tasks SET status='executing' WHERE id=$1", [
				taskId,
			]);
			await expect(
				updateOwnedTaskModeSettings(
					taskId,
					{ visibility: "private" },
					"0x1111111111111111111111111111111111111111",
					"pg-mode-locked",
					deps,
				),
			).rejects.toMatchObject({
				code: "TASK_MODE_LOCKED",
				statusCode: 409,
			});
		} finally {
			await client.query("ROLLBACK");
			client.release();
		}
	});

	it("reads the seeded category tree and resolves tag synonyms from PostgreSQL", async () => {
		const repository = new PgTaskRepository(pool);
		const categories = await repository.listCategories();
		expect(categories).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: CATEGORY_ID,
					name: "产品与开发",
					parentId: null,
				}),
				expect.objectContaining({
					name: "视频制作",
					parentId: "40000000-0000-4000-8000-000000000003",
				}),
			]),
		);
		await expect(repository.suggestTags("nextjs", 10)).resolves.toContainEqual({
			canonicalName: "next.js",
			matchedAlias: "nextjs",
		});
	});

	it("extends planning deadline with atomic event and audit evidence", async () => {
		const client = await pool.connect();
		await client.query("BEGIN");
		try {
			const taskId = "86000000-0000-4000-8000-000000000001";
			await client.query(
				`INSERT INTO tasks (
           id,publisher_id,title,description,acceptance_criteria,deliverable_format,
           category_id,category_version,tag_names,pricing_type,budget_min_minor,budget_max_minor,
           currency,deadline,required_capability,attachments,visibility,status,status_version,
           assignment_mode_config,acceptance_mode,acceptor_config
         ) VALUES ($1,'publisher-criteria','匹配条件调整集成任务','验证托管前规划阶段可以显式延长截止时间并保留审计证据。',
           '更新、事件、审计和幂等快照必须原子提交。','测试证据',$2,1,ARRAY['agent'],
           'fixed',10000000,10000000,'USDC',$3,'TypeScript 与 PostgreSQL',
           '[]'::jsonb,'private','planning',7,'{"mode":"manual"}'::jsonb,'manual','{}'::jsonb)`,
				[taskId, CATEGORY_ID, new Date("2026-08-23T03:00:00.000Z")],
			);

			const result = await updateOwnedTaskMatchCriteria(
				taskId,
				{
					tags: ["NextJS", "Agent"],
					deadline: "2026-08-23T04:00:00.000Z",
				},
				"publisher-criteria",
				"pg-criteria-update",
				postgresDeps(client),
			);
			expect(result.body).toMatchObject({
				taskId,
				status: "planning",
				statusVersion: "8",
			});

			const evidence = await client.query<{
				tag_names: string[];
				deadline: Date;
				status_version: string;
				event_count: string;
				audit_count: string;
			}>(
				`SELECT task.tag_names,task.deadline,task.status_version::text,
                (SELECT count(*)::text FROM task_events event
                  WHERE event.task_id=task.id AND event.event_type='task.match_criteria_updated') AS event_count,
                (SELECT count(*)::text FROM audit_logs audit
                  WHERE audit.target_type='task' AND audit.target_id=task.id::text
                    AND audit.action='task.match-criteria') AS audit_count
           FROM tasks task WHERE task.id=$1`,
				[taskId],
			);
			expect(evidence.rows[0]).toMatchObject({
				tag_names: ["agent", "next.js"],
				status_version: "8",
				event_count: "1",
				audit_count: "1",
			});
			expect(evidence.rows[0]?.deadline.toISOString()).toBe(
				"2026-08-23T04:00:00.000Z",
			);
		} finally {
			await client.query("ROLLBACK");
			client.release();
		}
	});

	it("applies dispatch outbox facts through the authoritative state machine exactly once", async () => {
		const client = await pool.connect();
		await client.query("BEGIN");
		try {
			const taskId = "82000000-0000-4000-8000-000000000001";
			const agentId = "82000000-0000-4000-8000-000000000002";
			const distributionId = "82000000-0000-4000-8000-000000000003";
			const assignmentId = "82000000-0000-4000-8000-000000000004";
			const lockedEventId = "82000000-0000-4000-8000-000000000005";
			const acceptedEventId = "82000000-0000-4000-8000-000000000006";
			await client.query(
				`INSERT INTO tasks (
           id,publisher_id,title,description,acceptance_criteria,deliverable_format,
           category_id,category_version,tag_names,pricing_type,budget_min_minor,budget_max_minor,
           currency,deadline,required_capability,attachments,visibility,status,
           assignment_mode_config,acceptance_mode,acceptor_config
         ) VALUES ($1,'publisher-transition','派发状态迁移集成任务','验证跨服务 outbox 事实只推进一次任务状态。',
           '接单后进入执行，重复投递不递增版本。','测试报告',$2,1,ARRAY['agent'],'fixed',
           8000,8000,'USDC',$3,'PostgreSQL','[]'::jsonb,'public','matching',
           '{"mode":"manual"}'::jsonb,'manual','{}'::jsonb)`,
				[taskId, CATEGORY_ID, new Date("2026-08-24T00:00:00.000Z")],
			);
			await client.query(
				`INSERT INTO agents (
           id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,pricing_type,
           price_amount,price_currency,service_endpoint,email,status,estimated_duration_seconds,response_minutes
         ) VALUES ($1,'0xcccccccccccccccccccccccccccccccccccccccc','0xcccccccccccccccccccccccccccccccccccccccc','迁移测试 Agent',$2,
           'PostgreSQL',ARRAY['agent'],'fixed',7000000,'USDC','http://127.0.0.1:3999/agent',
           'transition@example.com','active',1800,1)`,
				[agentId, CATEGORY_ID],
			);
			await client.query(
				`INSERT INTO job_distribution_records (
           id,task_id,rule_version,input_fingerprint,input_snapshot,candidates,filter_reasons
         ) VALUES ($1,$2,'ranking-v1','transition-fixture','{}'::jsonb,$3::jsonb,'{}'::jsonb)`,
				[distributionId, taskId, JSON.stringify([{ agentId }])],
			);
			await client.query(
				`INSERT INTO task_assignments (
           id,task_id,agent_id,distribution_record_id,agreed_amount_minor,status,assigned_by,accept_by
         ) VALUES ($1,$2,$3,$4,7000000,'pending_ack','publisher-transition',now()+interval '5 minutes')`,
				[assignmentId, taskId, agentId, distributionId],
			);

			const repository = new PgDispatchTransitionRepository(client);
			const locked = await repository.apply(taskId, {
				eventId: lockedEventId,
				assignmentId,
				eventType: "assignment_locked",
			});
			expect(locked).toMatchObject({
				status: "awaiting_agent_acceptance",
				statusVersion: 1n,
				replayed: false,
			});

			await client.query(
				"UPDATE task_assignments SET status='accepted' WHERE id=$1",
				[assignmentId],
			);
			const accepted = await repository.apply(taskId, {
				eventId: acceptedEventId,
				assignmentId,
				eventType: "agent_accepted",
			});
			expect(accepted).toMatchObject({
				status: "executing",
				statusVersion: 2n,
				replayed: false,
			});

			const replay = await repository.apply(taskId, {
				eventId: lockedEventId,
				assignmentId,
				eventType: "assignment_locked",
			});
			expect(replay).toMatchObject({
				status: "awaiting_agent_acceptance",
				statusVersion: 1n,
				replayed: true,
			});
			const current = await client.query<{
				status: string;
				status_version: string;
			}>("SELECT status,status_version::text FROM tasks WHERE id=$1", [taskId]);
			expect(current.rows[0]).toEqual({
				status: "executing",
				status_version: "2",
			});
			const notifications = await client.query<{
				versions: string;
				event_types: string;
				deliveries: string;
				endpoint: string;
			}>(
				`SELECT
           (SELECT string_agg(status_version::text,',' ORDER BY status_version)
              FROM task_events WHERE task_id=$1) AS versions,
           (SELECT string_agg(event_type,',' ORDER BY status_version)
              FROM task_events WHERE task_id=$1) AS event_types,
           (SELECT count(*)::text FROM webhook_deliveries delivery
              JOIN task_events event ON event.id=delivery.task_event_id WHERE event.task_id=$1) AS deliveries,
           (SELECT min(endpoint) FROM webhook_deliveries delivery
              JOIN task_events event ON event.id=delivery.task_event_id WHERE event.task_id=$1) AS endpoint`,
				[taskId],
			);
			expect(notifications.rows[0]).toEqual({
				versions: "1,2",
				event_types: "task.assignment_locked,task.agent_accepted",
				deliveries: "2",
				endpoint: "http://127.0.0.1:3999/agent/webhook",
			});
		} finally {
			await client.query("ROLLBACK");
			client.release();
		}
	});

	it("returns a rejected or timed-out assignment to matching through the authoritative state machine", async () => {
		const client = await pool.connect();
		await client.query("BEGIN");
		try {
			const taskId = "87000000-0000-4000-8000-000000000001";
			const agentId = "87000000-0000-4000-8000-000000000002";
			const distributionId = "87000000-0000-4000-8000-000000000003";
			const assignmentId = "87000000-0000-4000-8000-000000000004";
			const eventId = "87000000-0000-4000-8000-000000000005";
			await client.query(
				`INSERT INTO tasks (
           id,publisher_id,title,description,acceptance_criteria,deliverable_format,
           category_id,category_version,tag_names,pricing_type,budget_min_minor,budget_max_minor,
           currency,deadline,required_capability,attachments,visibility,status,status_version,
           assignment_mode_config,acceptance_mode,acceptor_config
         ) VALUES ($1,'publisher-rejected','拒单恢复集成任务','验证拒单或接单超时后由权威任务状态机回到匹配。',
           '旧候选快照保持可选，不要求重新生成匹配记录。','测试证据',$2,1,ARRAY['agent'],
           'fixed',10000000,10000000,'USDC',$3,'PostgreSQL',
           '[]'::jsonb,'private','awaiting_agent_acceptance',3,'{"mode":"manual"}'::jsonb,'manual','{}'::jsonb)`,
				[taskId, CATEGORY_ID, new Date("2026-08-23T03:00:00.000Z")],
			);
			await client.query(
				`INSERT INTO agents (
           id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,pricing_type,
           price_amount,price_currency,service_endpoint,email,status,estimated_duration_seconds,response_minutes
         ) VALUES ($1,'0xdddddddddddddddddddddddddddddddddddddddd','0xdddddddddddddddddddddddddddddddddddddddd','拒单测试 Agent',$2,
           'PostgreSQL',ARRAY['agent'],'fixed',9000000,'USDC','http://127.0.0.1:3999/agent',
           'rejected@example.com','active',1800,1)`,
				[agentId, CATEGORY_ID],
			);
			await client.query(
				`INSERT INTO job_distribution_records (
           id,task_id,rule_version,input_fingerprint,input_snapshot,candidates,filter_reasons
         ) VALUES ($1,$2,'ranking-v1','rejected-fixture','{}'::jsonb,$3::jsonb,'{}'::jsonb)`,
				[
					distributionId,
					taskId,
					JSON.stringify([{ agentId, quoteMinor: "9000000" }]),
				],
			);
			await client.query(
				`INSERT INTO task_assignments (
           id,task_id,agent_id,distribution_record_id,agreed_amount_minor,status,assigned_by,accept_by,responded_at
         ) VALUES ($1,$2,$3,$4,9000000,'accept_failed','publisher-rejected',now(),now())`,
				[assignmentId, taskId, agentId, distributionId],
			);

			const result = await new PgDispatchTransitionRepository(client).apply(
				taskId,
				{
					eventId,
					assignmentId,
					eventType: "assignment_failed",
				},
			);
			expect(result).toMatchObject({
				taskId,
				status: "matching",
				statusVersion: 4n,
				replayed: false,
			});
			const stored = await client.query<{
				status: string;
				event_count: string;
			}>(
				`SELECT task.status,
                (SELECT count(*)::text FROM task_events event
                  WHERE event.task_id=task.id AND event.event_type='task.assignment_failed') AS event_count
           FROM tasks task WHERE task.id=$1`,
				[taskId],
			);
			expect(stored.rows[0]).toEqual({ status: "matching", event_count: "1" });
		} finally {
			await client.query("ROLLBACK");
			client.release();
		}
	});

	it("persists monotonic progress, versioned result batches, rework and immutable acceptance money", async () => {
		const client = await pool.connect();
		await client.query("BEGIN");
		try {
			const taskId = "84000000-0000-4000-8000-000000000001";
			const agentId = "84000000-0000-4000-8000-000000000002";
			const distributionId = "84000000-0000-4000-8000-000000000003";
			const assignmentId = "84000000-0000-4000-8000-000000000004";
			await client.query(
				`INSERT INTO tasks (
           id,publisher_id,title,description,acceptance_criteria,deliverable_format,
           category_id,category_version,tag_names,pricing_type,budget_min_minor,budget_max_minor,
           currency,deadline,required_capability,attachments,visibility,status,
           assignment_mode_config,acceptance_mode,acceptor_config
         ) VALUES ($1,'publisher-execution','执行交付集成任务','验证进度、结果版本、返工和验收金额快照。',
           '所有写入与事件位于同一事务。','Markdown',$2,1,ARRAY['agent'],'fixed',24000000,24000000,
           'USDC',$3,'TypeScript','[]'::jsonb,'private','matching','{"mode":"manual"}'::jsonb,'manual','{}'::jsonb)`,
				[taskId, CATEGORY_ID, new Date("2026-08-24T00:00:00.000Z")],
			);
			await client.query(
				`INSERT INTO agents (
           id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,pricing_type,
           price_amount,price_currency,service_endpoint,email,status,estimated_duration_seconds,response_minutes
         ) VALUES ($1,'0xdddddddddddddddddddddddddddddddddddddddd','0xabababababababababababababababababababab','交付测试 Agent',$2,'TypeScript',
           ARRAY['agent'],'fixed',24000000,'USDC','http://127.0.0.1:3999/agent','execution@example.com','active',1800,1)`,
				[agentId, CATEGORY_ID],
			);
			await client.query(
				`INSERT INTO job_distribution_records(id,task_id,rule_version,input_fingerprint,input_snapshot,candidates,filter_reasons)
         VALUES ($1,$2,'ranking-v1','execution-fixture','{}'::jsonb,$3::jsonb,'{}'::jsonb)`,
				[distributionId, taskId, JSON.stringify([{ agentId }])],
			);
			await client.query(
				`INSERT INTO task_assignments(
           id,task_id,agent_id,distribution_record_id,agreed_amount_minor,status,assigned_by,accept_by,responded_at
         ) VALUES ($1,$2,$3,$4,24000000,'accepted','publisher-execution',now()+interval '5 minutes',now())`,
				[assignmentId, taskId, agentId, distributionId],
			);
			// 验收会创建真实链上 release outbox；已确认托管是进入结算的硬前置。
			await client.query(
				`INSERT INTO escrow_intents(
           task_id,chain_id,contract_address,task_key,payer_wallet,amount_minor,status
         ) VALUES ($1,31337,$2,$3,$4,24000000,'confirmed')`,
				[
					taskId,
					`0x${"aa".repeat(20)}`,
					`0x${"bb".repeat(32)}`,
					`0x${"ee".repeat(20)}`,
				],
			);

			const repository = new PgExecutionRepository(client);
			const callbacks = createExecutionService(repository);
			const progressInput = {
				agentId,
				assignmentId,
				progress: 40,
				reportedAt: "2026-08-23T01:00:00.000Z",
			};
			await expect(
				callbacks.reportStatus(
					taskId,
					progressInput,
					"status:task:not-ready-001",
					"0".repeat(64),
				),
			).rejects.toMatchObject({
				code: "EXECUTION_NOT_READY",
				statusCode: 409,
				retryable: true,
			});
			await client.query("UPDATE tasks SET status='executing' WHERE id=$1", [
				taskId,
			]);
			const progress = await callbacks.reportStatus(
				taskId,
				progressInput,
				"status:task:request-001",
				"a".repeat(64),
			);
			expect(progress.body).toMatchObject({
				status: "executing",
				statusVersion: "1",
				progress: 40,
			});
			const replay = await callbacks.reportStatus(
				taskId,
				progressInput,
				"status:task:request-001",
				"a".repeat(64),
			);
			expect(replay).toEqual(progress);
			await expect(
				callbacks.reportStatus(
					taskId,
					{ ...progressInput, progress: 20 },
					"status:task:request-002",
					"b".repeat(64),
				),
			).rejects.toMatchObject({ code: "PROGRESS_REGRESSION" });

			const needsInput = await callbacks.reportStatus(
				taskId,
				{
					agentId,
					assignmentId,
					state: "needs_input",
					progress: 45,
					reportedAt: "2026-08-23T01:02:00.000Z",
					estimatedCompletionAt: "2026-08-23T02:00:00.000Z",
					message: "请确认导出文件是否还需要包含 JSON Schema。",
				},
				"status:task:needs-input-001",
				"e".repeat(64),
			);
			expect(needsInput.body).toMatchObject({
				statusVersion: "2",
				executionState: "needs_input",
				progress: 45,
				estimatedCompletionAt: "2026-08-23T02:00:00.000Z",
				attentionMessage: "请确认导出文件是否还需要包含 JSON Schema。",
			});
			await expect(
				callbacks.readStatus(taskId, "publisher-execution"),
			).resolves.toMatchObject({
				body: {
					executionState: "needs_input",
					progress: 45,
					attentionMessage: "请确认导出文件是否还需要包含 JSON Schema。",
				},
			});

			const firstBatch = await callbacks.submitResults(
				taskId,
				{
					agentId,
					assignmentId,
					results: [
						{
							kind: "inline",
							summary: "方案 A",
							mimeType: "text/markdown",
							generatedAt: "2026-08-23T01:10:00.000Z",
							content: "# A\n完整实现",
						},
						{
							kind: "inline",
							summary: "方案 B",
							mimeType: "text/plain",
							generatedAt: "2026-08-23T01:11:00.000Z",
							content: "备选实现",
						},
					],
				},
				"result-submit:task:request-001",
				"c".repeat(64),
			);
			expect(firstBatch.body).toMatchObject({
				status: "awaiting_review",
				statusVersion: "3",
				batchNo: 1,
			});
			const firstResults = firstBatch.body.results as readonly Record<
				string,
				unknown
			>[];
			const firstResultId = requiredString(firstResults[0]?.id);

			const publisher = createExecutionService(
				repository,
				new Idempotency(new PgIdempotencyStore(client), 60_000, () => NOW),
			);
			const rework = await publisher.rework(
				taskId,
				{
					resultId: firstResultId,
					reason: "请补充失败路径和恢复说明，确保验收条件可执行。",
				},
				"publisher-execution",
				"rework-task-request-001",
			);
			expect(rework.body).toMatchObject({
				status: "rework",
				statusVersion: "4",
				requestNo: 1,
			});

			const secondBatch = await callbacks.submitResults(
				taskId,
				{
					agentId,
					assignmentId,
					results: [
						{
							kind: "inline",
							summary: "修订方案",
							mimeType: "text/markdown",
							generatedAt: "2026-08-23T01:20:00.000Z",
							content: "# 修订\n包含恢复路径",
						},
					],
				},
				"result-submit:task:request-002",
				"d".repeat(64),
			);
			const secondResults = secondBatch.body.results as readonly Record<
				string,
				unknown
			>[];
			const acceptedResultId = requiredString(secondResults[0]?.id);
			const acceptancePreview = await publisher.previewAcceptance(
				taskId,
				{ resultId: acceptedResultId },
				"publisher-execution",
			);
			expect(acceptancePreview.body).toMatchObject({
				taskId,
				resultId: acceptedResultId,
				status: "awaiting_review",
				statusVersion: "5",
				settlement: {
					grossAmountMinor: "24000000",
					platformFeeMinor: "96000",
					agentAmountMinor: "23904000",
					feeRuleVersion: "fee-v3-usdc",
				},
			});
			const expectedSettlement = acceptancePreview.body.settlement as {
				grossAmountMinor: string;
				platformFeeMinor: string;
				agentAmountMinor: string;
				feeRuleVersion: string;
			};
			await expect(
				publisher.accept(
					taskId,
					{
						resultId: acceptedResultId,
						expectedStatusVersion: "4",
						expectedSettlement,
					},
					"publisher-execution",
					"accept-task-stale-preview-001",
				),
			).rejects.toMatchObject({
				code: "ACCEPTANCE_PREVIEW_STALE",
				statusCode: 409,
				retryable: true,
			});
			const acceptanceInput = {
				resultId: acceptedResultId,
				expectedStatusVersion: "5",
				expectedSettlement,
			};
			const accepted = await publisher.accept(
				taskId,
				acceptanceInput,
				"publisher-execution",
				"accept-task-request-001",
			);
			expect(accepted.body).toMatchObject({
				status: "pending_settlement",
				statusVersion: "6",
				settlement: {
					grossAmountMinor: "24000000",
					platformFeeMinor: "96000",
					agentAmountMinor: "23904000",
					feeRuleVersion: "fee-v3-usdc",
				},
			});
			await expect(
				publisher.accept(
					taskId,
					acceptanceInput,
					"publisher-execution",
					"accept-task-request-001",
				),
			).resolves.toEqual(accepted);

			const evidence = await client.query<{
				versions: string;
				latest_results: string;
				acceptances: string;
				deliveries: string;
				invalid_delivery_keys: string;
				settlement_jobs: string;
				settlement_payee: string;
				rework_reason: string;
			}>(
				`SELECT (SELECT string_agg(status_version::text,',' ORDER BY status_version) FROM task_events WHERE task_id=$1) AS versions,
                (SELECT count(*)::text FROM task_results WHERE task_id=$1 AND is_latest=TRUE) AS latest_results,
                (SELECT count(*)::text FROM task_acceptances WHERE task_id=$1) AS acceptances,
                (SELECT count(*)::text FROM webhook_deliveries delivery
                   JOIN task_events event ON event.id=delivery.task_event_id WHERE event.task_id=$1) AS deliveries,
                (SELECT count(*)::text FROM webhook_deliveries delivery
                   JOIN task_events event ON event.id=delivery.task_event_id
                  WHERE event.task_id=$1
                    AND array_length(string_to_array(delivery.idempotency_key, ':'), 1) <> 3) AS invalid_delivery_keys,
                (SELECT count(*)::text FROM escrow_execution_jobs WHERE task_id=$1 AND source='acceptance' AND status='pending') AS settlement_jobs,
                (SELECT payee FROM escrow_execution_jobs WHERE task_id=$1 AND source='acceptance' AND status='pending') AS settlement_payee,
                (SELECT payload->>'reason' FROM task_events WHERE task_id=$1 AND event_type='task.rework_requested') AS rework_reason`,
				[taskId],
			);
			expect(evidence.rows[0]).toEqual({
				versions: "1,2,3,4,5,6",
				latest_results: "1",
				acceptances: "1",
				deliveries: "6",
				invalid_delivery_keys: "0",
				settlement_jobs: "1",
				settlement_payee: "0xabababababababababababababababababababab",
				rework_reason: "请补充失败路径和恢复说明，确保验收条件可执行。",
			});

			// Feature 6 的链事件仓储会正式负责 6→7；这里先在同一事务构造已确认结算事实，
			// 隔离验证 feature 12 的评分权限、幂等、事件与快照持久化。
			await client.query(
				"UPDATE tasks SET status='settled',status_version=7 WHERE id=$1",
				[taskId],
			);
			await emitTaskEvent(client, {
				taskId,
				statusVersion: 7n,
				eventType: "task.settlement_confirmed",
				payload: { status: "settled", txHash: `0x${"12".repeat(32)}` },
				createdAt: NOW,
			});
			const scoring = createScoringService(
				new PgScoringRepository(client),
				new Idempotency(new PgIdempotencyStore(client), 60_000, () => NOW),
				() => NOW,
			);
			const ratingInput = { quality: 5, communication: 5 };
			const rated = await scoring.submitRating(
				taskId,
				ratingInput,
				"publisher-execution",
				"rating-task-request-001",
			);
			expect(rated.body).toMatchObject({ taskId, agentId, statusVersion: "8" });
			await expect(
				scoring.submitRating(
					taskId,
					ratingInput,
					"publisher-execution",
					"rating-task-request-001",
				),
			).resolves.toEqual(rated);
			await expect(
				scoring.submitRating(
					taskId,
					{ ...ratingInput, disputeRate: 0 },
					"publisher-execution",
					"rating-task-request-invalid",
				),
			).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
			const snapshots = await scoring.computeSnapshots(100);
			// 集成数据库可能已包含初始化的 9 个工作流 Agent。下面的任务专属断言只证明本测试
			// Agent 已进入快照；批次总量刻意不与其他合法的既有目录记录耦合。
			expect(snapshots.length).toBeGreaterThanOrEqual(1);
			await expect(scoring.readLatestScore(agentId)).resolves.toMatchObject({
				body: {
					agentId,
					ruleVersion: "score-v1",
					sampleSize: 1,
					lowSample: true,
				},
			});
			const ratingEvidence = await client.query<{
				ratings: string;
				snapshots: string;
				versions: string;
				input_evidence: Record<string, unknown>;
			}>(
				`SELECT (SELECT count(*)::text FROM task_ratings WHERE task_id=$1) AS ratings,
                (SELECT count(*)::text FROM agent_score_snapshots WHERE agent_id=$2) AS snapshots,
                (SELECT string_agg(status_version::text,',' ORDER BY status_version) FROM task_events WHERE task_id=$1) AS versions,
                (SELECT input_evidence FROM agent_score_snapshots WHERE agent_id=$2 ORDER BY computed_at DESC,id DESC LIMIT 1) AS input_evidence`,
				[taskId, agentId],
			);
			expect(ratingEvidence.rows[0]).toMatchObject({
				ratings: "1",
				snapshots: "1",
				versions: "1,2,3,4,5,6,7,8",
				input_evidence: {
					schemaVersion: "score-input-v1",
					ratingIds: [rated.body.ratingId],
					ratedTaskIds: [taskId],
					acceptedAssignmentIds: [assignmentId],
					respondedAssignmentIds: [assignmentId],
					completedTaskIds: [taskId],
					arbitrationDecisionIds: [],
				},
			});
		} finally {
			await client.query("ROLLBACK");
			client.release();
		}
	});

	it("persists a sanitized Agent failure exactly once without creating a settlement job", async () => {
		const client = await pool.connect();
		await client.query("BEGIN");
		try {
			const taskId = "84100000-0000-4000-8000-000000000001";
			const agentId = "84100000-0000-4000-8000-000000000002";
			const distributionId = "84100000-0000-4000-8000-000000000003";
			const assignmentId = "84100000-0000-4000-8000-000000000004";
			await client.query(
				`INSERT INTO tasks (
           id,publisher_id,title,description,acceptance_criteria,deliverable_format,
           category_id,category_version,tag_names,pricing_type,budget_min_minor,budget_max_minor,
           currency,deadline,required_capability,attachments,visibility,status,
           assignment_mode_config,acceptance_mode,acceptor_config
         ) VALUES ($1,'publisher-failure','失败回调集成任务','验证 Agent 执行失败后任务、审计与资金保持一致。',
           '失败信息脱敏且托管资金不自动释放。','JSON',$2,1,ARRAY['agent'],'fixed',10000000,10000000,
           'USDC',$3,'TypeScript','[]'::jsonb,'public','executing','{"mode":"manual"}'::jsonb,'manual','{}'::jsonb)`,
				[taskId, CATEGORY_ID, new Date("2026-08-24T00:00:00.000Z")],
			);
			await client.query(
				`INSERT INTO agents (
           id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,pricing_type,
           price_amount,price_currency,service_endpoint,email,status,estimated_duration_seconds,response_minutes
         ) VALUES ($1,'0xfafafafafafafafafafafafafafafafafafafafa','0xfafafafafafafafafafafafafafafafafafafafa','失败测试 Agent',$2,'TypeScript',
           ARRAY['agent'],'fixed',10000000,'USDC','http://127.0.0.1:3999/agent','failure@example.com','active',1800,1)`,
				[agentId, CATEGORY_ID],
			);
			await client.query(
				`INSERT INTO job_distribution_records(id,task_id,rule_version,input_fingerprint,input_snapshot,candidates,filter_reasons)
         VALUES ($1,$2,'ranking-v1','failure-path','{}'::jsonb,$3::jsonb,'{}'::jsonb)`,
				[distributionId, taskId, JSON.stringify([{ agentId }])],
			);
			await client.query(
				`INSERT INTO task_assignments(
           id,task_id,agent_id,distribution_record_id,agreed_amount_minor,status,assigned_by,accept_by,responded_at
         ) VALUES ($1,$2,$3,$4,10000000,'accepted','publisher-failure',now()+interval '5 minutes',now())`,
				[assignmentId, taskId, agentId, distributionId],
			);
			const statsRepository = new PgTaskRepository(client);
			const marketBeforeFailure = await statsRepository.readMarketStats();
			const publisherBeforeFailure =
				await statsRepository.readPublisherStats("publisher-failure");

			const callbacks = createExecutionService(
				new PgExecutionRepository(client),
			);
			const failure = {
				agentId,
				assignmentId,
				state: "failed" as const,
				failureCode: "MODEL_EXECUTION_FAILED" as const,
				reportedAt: "2026-08-23T01:30:00.000Z",
			};
			const first = await callbacks.reportStatus(
				taskId,
				failure,
				"status:failure:request-001",
				"f".repeat(64),
			);
			const replay = await callbacks.reportStatus(
				taskId,
				failure,
				"status:failure:request-001",
				"f".repeat(64),
			);
			expect(replay).toEqual(first);
			expect(first.body).toMatchObject({
				status: "execution_failed",
				statusVersion: "1",
				executionState: "failed",
				failureCode: "MODEL_EXECUTION_FAILED",
			});

			const evidence = await client.query<{
				task_status: string;
				event_count: string;
				failure_code: string;
				failed_at: Date;
				settlement_jobs: string;
				callback_count: string;
			}>(
				`SELECT task.status AS task_status,
                (SELECT count(*)::text FROM task_events WHERE task_id=task.id AND event_type='task.execution_failed') AS event_count,
                state.failure_code,state.failed_at,
                (SELECT count(*)::text FROM escrow_execution_jobs WHERE task_id=task.id) AS settlement_jobs,
                (SELECT count(*)::text FROM agent_callback_inbox WHERE task_id=task.id) AS callback_count
           FROM tasks task JOIN task_execution_state state ON state.task_id=task.id WHERE task.id=$1`,
				[taskId],
			);
			expect(evidence.rows[0]).toMatchObject({
				task_status: "execution_failed",
				event_count: "1",
				failure_code: "MODEL_EXECUTION_FAILED",
				settlement_jobs: "0",
				callback_count: "1",
			});
			expect(evidence.rows[0]?.failed_at.toISOString()).toBe(
				failure.reportedAt,
			);
			const marketAfterFailure = await statsRepository.readMarketStats();
			const publisherAfterFailure =
				await statsRepository.readPublisherStats("publisher-failure");
			expect(marketAfterFailure.execution_failed).toBe(
				(marketBeforeFailure.execution_failed ?? 0) + 1,
			);
			expect(marketAfterFailure.executing).toBe(
				(marketBeforeFailure.executing ?? 0) - 1,
			);
			expect(publisherAfterFailure.pending).toBe(
				(publisherBeforeFailure.pending ?? 0) + 1,
			);
			expect(publisherAfterFailure.executing).toBe(
				(publisherBeforeFailure.executing ?? 0) - 1,
			);
		} finally {
			await client.query("ROLLBACK");
			client.release();
		}
	});

	it("times out matching, awaiting-agent and executing tasks but never awaiting escrow", async () => {
		const client = await pool.connect();
		await client.query("BEGIN");
		try {
			const statuses = [
				"matching",
				"awaiting_agent_acceptance",
				"executing",
				"awaiting_escrow",
			] as const;
			const ids = statuses.map(
				(_, index) => `85000000-0000-4000-8000-00000000000${index + 1}`,
			);
			for (const [index, status] of statuses.entries()) {
				await client.query(
					`INSERT INTO tasks (
             id,publisher_id,title,description,acceptance_criteria,deliverable_format,
             category_id,category_version,tag_names,pricing_type,budget_min_minor,budget_max_minor,
             currency,deadline,required_capability,attachments,visibility,status,
             assignment_mode_config,acceptance_mode,acceptor_config
           ) VALUES ($1,'publisher-timeout',$2,'验证执行截止时间扫描不会误伤待托管任务。',
             '只有规定的三个状态进入超时。','测试',$3,1,ARRAY['agent'],'fixed',8000,8000,
             'USDC',$4,'TypeScript','[]'::jsonb,'private',$5,'{"mode":"manual"}'::jsonb,'manual','{}'::jsonb)`,
					[
						ids[index],
						`超时状态测试任务 ${index + 1}`,
						CATEGORY_ID,
						new Date("2026-08-22T23:00:00.000Z"),
						status,
					],
				);
			}
			const timedOut = await scanExecutionTimeouts(client, NOW, 100);
			expect(new Set(timedOut)).toEqual(new Set(ids.slice(0, 3)));
			const stored = await client.query<{ id: string; status: string }>(
				"SELECT id::text,status FROM tasks WHERE id=ANY($1::uuid[]) ORDER BY id",
				[ids],
			);
			expect(stored.rows.map((row) => row.status)).toEqual([
				"timed_out",
				"timed_out",
				"timed_out",
				"awaiting_escrow",
			]);
			const events = await client.query<{ count: string }>(
				"SELECT count(*)::text AS count FROM task_events WHERE task_id=ANY($1::uuid[])",
				[ids],
			);
			expect(events.rows[0]?.count).toBe("3");
		} finally {
			await client.query("ROLLBACK");
			client.release();
		}
	});

	it("queries a task dead letter without exposing its endpoint path or changing business state", async () => {
		const client = await pool.connect();
		await client.query("BEGIN");
		try {
			const deps = postgresDeps(client);
			const created = await createTaskDraft(
				{
					title: "Webhook 死信隔离测试任务",
					description:
						"验证通知基础设施连续投递失败并进入死信之后，不会回滚或改写已经提交的任务业务状态。",
					acceptanceCriteria:
						"运营查询能看到次数和错误码，但不能看到 Agent 端点路径。",
					deliverableFormat: "集成测试报告",
					categoryId: CATEGORY_ID,
					tags: ["agent"],
					pricing: { type: "fixed", amountMinor: "10000000" },
					currency: "USDC",
					deadline: "2026-08-24T00:00:00.000Z",
					requiredCapability: "Webhook",
					attachments: [],
					visibility: "private",
					assignmentMode: { mode: "manual" },
					acceptanceMode: { mode: "manual" },
				},
				"publisher-dead-letter",
				"pg-dead-letter-create",
				deps,
			);
			const taskId = requiredString(created.body.taskId);
			await submitTaskDraft(
				taskId,
				"publisher-dead-letter",
				"pg-dead-letter-submit",
				deps,
			);
			const event = await client.query<{ id: string }>(
				"SELECT id::text FROM task_events WHERE task_id=$1 AND event_type='task.submitted'",
				[taskId],
			);
			const eventId = requiredString(event.rows[0]?.id);
			const agentId = "87000000-0000-4000-8000-000000000002";
			await client.query(
				`INSERT INTO agents(
           id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,pricing_type,
           price_amount,price_currency,service_endpoint,email,status
         ) VALUES ($1,'0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','死信查询 Agent',$2,
           'Webhook',ARRAY['agent'],'fixed',7000000,'USDC','https://agent.example/private/tenant?token=hidden',
           'dead-letter@example.com','active')`,
				[agentId, CATEGORY_ID],
			);
			await client.query(
				`INSERT INTO webhook_deliveries(
           task_event_id,agent_id,endpoint,idempotency_key,status,attempt_no,last_error_code,next_attempt_at
         ) VALUES ($1,$2,'https://agent.example/private/tenant?token=hidden',$3,'dead_letter',5,'CONN_TIMEOUT',$4)`,
				[eventId, agentId, `webhook:${taskId}:dead-letter`, NOW],
			);

			const statusBefore = await client.query<{
				status: string;
				status_version: string;
			}>("SELECT status,status_version::text FROM tasks WHERE id=$1", [taskId]);
			const deliveries = await new PgTaskEventReader(client).deadLetters(
				taskId,
				20,
			);
			const pulledStatus = await createExecutionService(
				new PgExecutionRepository(client),
			).readStatus(taskId, "publisher-dead-letter");
			const statusAfter = await client.query<{
				status: string;
				status_version: string;
			}>("SELECT status,status_version::text FROM tasks WHERE id=$1", [taskId]);

			expect(deliveries).toHaveLength(1);
			expect(deliveries[0]).toMatchObject({
				taskId,
				taskEventId: eventId,
				agentId,
				endpoint: "https://agent.example/…",
				attemptNo: 5,
				lastErrorCode: "CONN_TIMEOUT",
			});
			expect(JSON.stringify(deliveries)).not.toContain("private/tenant");
			expect(JSON.stringify(deliveries)).not.toContain("hidden");
			expect(pulledStatus.body).toMatchObject({
				taskId,
				status: "planning",
				statusVersion: "1",
				progress: 0,
				executionState: "running",
				lastEventId: eventId,
			});
			expect(statusAfter.rows).toEqual(statusBefore.rows);
			expect(statusAfter.rows[0]).toMatchObject({
				status: "planning",
				status_version: "1",
			});
		} finally {
			await client.query("ROLLBACK");
			client.release();
		}
	});
});

function postgresDeps(client: PoolClient): TaskCommandDeps {
	return {
		repository: new PgTaskRepository(client),
		idempotency: new Idempotency(
			new PgIdempotencyStore(client),
			60_000,
			() => NOW,
		),
		auditLogWriter: new PgAuditLogWriter(client),
		eventWriter: new PgTaskEventWriter(client),
		workflowPlanner: {
			ensure: (taskId) => ensureFormalWorkflow(client, taskId),
		},
		now: () => NOW,
	};
}

function requiredDatabaseUrl(): string {
	if (DATABASE_URL === undefined) throw new Error("DATABASE_URL_REQUIRED");
	return DATABASE_URL;
}

function requiredString(value: unknown): string {
	if (typeof value !== "string" || value.length === 0)
		throw new Error("EXPECTED_NON_EMPTY_STRING");
	return value;
}

function requiredMarketStats(
	value: unknown,
): Readonly<{ total: number; matching: number }> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("EXPECTED_MARKET_STATS");
	}
	const stats = value as Record<string, unknown>;
	if (typeof stats.total !== "number" || typeof stats.matching !== "number") {
		throw new Error("EXPECTED_NUMERIC_MARKET_STATS");
	}
	return { total: stats.total, matching: stats.matching };
}
