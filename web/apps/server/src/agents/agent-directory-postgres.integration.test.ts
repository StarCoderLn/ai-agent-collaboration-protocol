import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asQueryExecutor } from "../db/pool";
import { PgScoringRepository } from "../scoring/scoring-repository";
import { PgAgentDirectory } from "./agent-directory";

const DATABASE_URL = process.env.DATABASE_URL;
const integration = DATABASE_URL === undefined ? describe.skip : describe;
const OWNER = `0x${"84".repeat(20)}`;
const PAYOUT = `0x${"85".repeat(20)}`;
const ACTIVE_AGENT = "84000000-0000-4000-8000-000000000001";
const PENDING_AGENT = "84000000-0000-4000-8000-000000000002";
const SETTLED_TASKS = [
	"84000000-0000-4000-8000-000000000011",
	"84000000-0000-4000-8000-000000000012",
	"84000000-0000-4000-8000-000000000013",
] as const;
const DISTRIBUTIONS = [
	"84000000-0000-4000-8000-000000000021",
	"84000000-0000-4000-8000-000000000022",
	"84000000-0000-4000-8000-000000000023",
] as const;
const ASSIGNMENTS = [
	"84000000-0000-4000-8000-000000000031",
	"84000000-0000-4000-8000-000000000032",
	"84000000-0000-4000-8000-000000000033",
] as const;

integration("Agent directory PostgreSQL projections", () => {
	let pool: Pool;
	beforeAll(async () => {
		pool = new Pool({ connectionString: requiredDatabaseUrl() });
		await cleanup(pool);
		await seed(pool);
	});
	afterAll(async () => {
		await cleanup(pool);
		await pool.end();
	});

	it("publishes only active redacted profiles while owners receive private management fields", async () => {
		const directory = new PgAgentDirectory(asQueryExecutor(pool));
		const publicAgent = await directory.publicAgent(ACTIVE_AGENT);
		expect(publicAgent).toMatchObject({
			id: ACTIVE_AGENT,
			name: "公开健康 Agent",
			status: "active",
			isNew: true,
			// 新 Agent 的 3.5 仅是内部排序先验；没有真实评分时，公开目录必须保持为空。
			score: null,
			sampleSize: 0,
			provider: { label: "0x8484…8484" },
			health: { status: "healthy" },
		});
		expect(publicAgent).not.toHaveProperty("serviceEndpoint");
		expect(publicAgent).not.toHaveProperty("email");
		expect(publicAgent).not.toHaveProperty("providerWalletAddress");
		expect(publicAgent).not.toHaveProperty("payoutWalletAddress");
		const page = await directory.publicAgents({
			keyword: "公开",
			categoryId: null,
			limit: 9,
			offset: 0,
		});
		expect(page).toMatchObject({
			total: 1,
			agents: [expect.objectContaining({ id: ACTIVE_AGENT })],
		});
		await expect(directory.publicAgent(PENDING_AGENT)).resolves.toBeNull();

		const owned = await directory.ownedAgents(OWNER.toUpperCase());
		expect(owned).toHaveLength(2);
		expect(owned.find((agent) => agent.id === ACTIVE_AGENT)).toMatchObject({
			providerWalletAddress: OWNER,
			payoutWalletAddress: PAYOUT,
			serviceEndpoint: "http://127.0.0.1:9202/v1/workflow/execute",
			pauseReason: null,
			coldStart: { riskLimited: true, completedTaskThreshold: 3 },
			health: {
				status: "healthy",
				consecutiveFailureCount: 0,
				intervalSeconds: 300,
			},
		});
		const scoring = new PgScoringRepository(asQueryExecutor(pool));
		await expect(scoring.readLatestScore(ACTIVE_AGENT)).resolves.toEqual({
			statusCode: 200,
			body: {
				agentId: ACTIVE_AGENT,
				score: null,
				sampleSize: 0,
				lowSample: true,
				message: "尚无真实用户评分",
			},
		});

		// 首次成功必须指完整的“交付、验收、结算”事实，而不是接单次数或评分次数。
		// 评分样本保持为 0，证明新标识与冷启动风险门禁已经和贝叶斯先验解耦。
		await insertSettledHistory(pool, 0);
		await expect(directory.publicAgent(ACTIVE_AGENT)).resolves.toMatchObject({
			isNew: false,
			completedCount: 1,
			sampleSize: 0,
		});
		await expect(directory.ownedAgents(OWNER)).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: ACTIVE_AGENT,
					coldStart: { riskLimited: true, completedTaskThreshold: 3 },
				}),
			]),
		);

		await insertSettledHistory(pool, 1);
		await insertSettledHistory(pool, 2);
		await expect(directory.ownedAgents(OWNER)).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: ACTIVE_AGENT,
					isNew: false,
					completedCount: 3,
					coldStart: { riskLimited: false, completedTaskThreshold: 3 },
				}),
			]),
		);
	});
});

async function insertSettledHistory(pool: Pool, index: number): Promise<void> {
	const taskId = SETTLED_TASKS[index];
	const distributionId = DISTRIBUTIONS[index];
	const assignmentId = ASSIGNMENTS[index];
	if (
		taskId === undefined ||
		distributionId === undefined ||
		assignmentId === undefined
	) {
		throw new Error(`SETTLED_HISTORY_FIXTURE_OUT_OF_RANGE:${index}`);
	}
	await pool.query(
		`INSERT INTO tasks(
       id,publisher_id,title,description,acceptance_criteria,deliverable_format,category_id,
       category_version,tag_names,pricing_type,budget_min_minor,budget_max_minor,currency,
       deadline,required_capability,attachments,visibility,status
     ) VALUES (
       $1,'integration-publisher',$2,'证明 Agent 已完成一次真实资金闭环。','交付已验收并完成结算',
       '集成测试证据','40000000-0000-4000-8000-000000000001',1,ARRAY['agent'],
       'fixed',1200000,1200000,'USDC','2090-01-02T00:00:00Z','产品工作流','[]'::jsonb,
       'private','settled'
     )`,
		[taskId, `Agent 冷启动结算测试 ${index + 1}`],
	);
	await pool.query(
		`INSERT INTO job_distribution_records(
       id,task_id,rule_version,input_fingerprint,input_snapshot,candidates,filter_reasons,
       final_selection_agent_id
     ) VALUES ($1,$2,'ranking-v1',$3,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb,$4)`,
		[distributionId, taskId, `agent-cold-start-${index}`, ACTIVE_AGENT],
	);
	await pool.query(
		`INSERT INTO task_assignments(
       id,task_id,agent_id,distribution_record_id,agreed_amount_minor,status,version,
       assigned_by,assigned_at,accept_by,responded_at
     ) VALUES ($1,$2,$3,$4,1200000,'accepted',1,'integration-test',now(),
       now() + interval '5 minutes',now())`,
		[assignmentId, taskId, ACTIVE_AGENT, distributionId],
	);
}

async function seed(pool: Pool): Promise<void> {
	await pool.query(
		`INSERT INTO agents(
       id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,pricing_type,price_amount,
       price_currency,service_endpoint,email,status,estimated_duration_seconds,response_minutes
     ) VALUES
       ($1,$3,$4,'公开健康 Agent','40000000-0000-4000-8000-000000000001','可公开验证的产品工作流 Agent',
        ARRAY['agent','prd'],'fixed',1200000,'USDC','http://127.0.0.1:9202/v1/workflow/execute','active-directory@example.com','active',600,1),
       ($2,$3,$4,'等待准入 Agent','40000000-0000-4000-8000-000000000002','仅审核员和所有者可见',
        ARRAY['agent','research'],'fixed',1000000,'USDC','http://127.0.0.1:9203/v1/research',NULL,'pending_review',600,1)`,
		[ACTIVE_AGENT, PENDING_AGENT, OWNER, PAYOUT],
	);
	await pool.query("INSERT INTO agent_status_config(agent_id) VALUES ($1)", [
		ACTIVE_AGENT,
	]);
	await pool.query(
		`INSERT INTO agent_health_checks(agent_id,result_code,counted_toward_failure,checked_at)
     VALUES ($1,'HEALTH_OK',FALSE,'2090-01-01T00:00:00Z')`,
		[ACTIVE_AGENT],
	);
	// 冷启动快照故意保存 3.5 分但不含任何评分样本，用真实 PostgreSQL 投影证明该内部
	// 先验不会泄漏到目录和评分详情的公开响应。
	await pool.query(
		`INSERT INTO agent_score_snapshots(
       agent_id,rule_version,score,sample_size,dispute_rate,completed_scale,dimensions,input_evidence,computed_at
     ) VALUES (
       $1,'score-v1',3.5,0,0,0,
       '{"lowSample":true,"systemMetrics":{}}'::jsonb,
       '{"schemaVersion":"score-input-v1","ratingIds":[],"ratedTaskIds":[],"acceptedAssignmentIds":[],"respondedAssignmentIds":[],"completedTaskIds":[],"arbitrationDecisionIds":[]}'::jsonb,
       '2090-01-01T00:00:00Z'
     )`,
		[ACTIVE_AGENT],
	);
}

async function cleanup(pool: Pool): Promise<void> {
	await pool.query("DELETE FROM task_assignments WHERE id = ANY($1::uuid[])", [
		ASSIGNMENTS,
	]);
	await pool.query(
		"DELETE FROM job_distribution_records WHERE id = ANY($1::uuid[])",
		[DISTRIBUTIONS],
	);
	await pool.query("DELETE FROM tasks WHERE id = ANY($1::uuid[])", [
		SETTLED_TASKS,
	]);
	await pool.query(
		"DELETE FROM agent_score_snapshots WHERE agent_id IN ($1,$2)",
		[ACTIVE_AGENT, PENDING_AGENT],
	);
	await pool.query(
		"DELETE FROM agent_health_checks WHERE agent_id IN ($1,$2)",
		[ACTIVE_AGENT, PENDING_AGENT],
	);
	await pool.query(
		"DELETE FROM agent_health_probe_schedule WHERE agent_id IN ($1,$2)",
		[ACTIVE_AGENT, PENDING_AGENT],
	);
	await pool.query(
		"DELETE FROM agent_status_config WHERE agent_id IN ($1,$2)",
		[ACTIVE_AGENT, PENDING_AGENT],
	);
	await pool.query("DELETE FROM agents WHERE id IN ($1,$2)", [
		ACTIVE_AGENT,
		PENDING_AGENT,
	]);
}

function requiredDatabaseUrl(): string {
	if (DATABASE_URL === undefined) throw new Error("DATABASE_URL_REQUIRED");
	return DATABASE_URL;
}
