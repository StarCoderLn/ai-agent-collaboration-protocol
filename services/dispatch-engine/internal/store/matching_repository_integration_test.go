package store

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/matching"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	integrationTaskID   = "80000000-0000-4000-8000-000000000001"
	integrationAgentID  = "80000000-0000-4000-8000-000000000002"
	overBudgetAgentID   = "80000000-0000-4000-8000-000000000003"
	integrationRunID    = "80000000-0000-4000-8000-000000000004"
	integrationNodeID   = "80000000-0000-4000-8000-000000000005"
	integrationCategory = "40000000-0000-4000-8000-000000000001"
)

func TestMatchingRepositoryPostgresVerticalSlice(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	// Cleanup 按 LIFO 执行：先注册关连接，再注册删 fixture，确保删除时连接仍可用。
	t.Cleanup(pool.Close)
	cleanupMatchingFixtures(t, ctx, pool)
	t.Cleanup(func() { cleanupMatchingFixtures(t, ctx, pool) })

	deadline := time.Now().UTC().Add(2 * time.Hour)
	// 共享验收库可能同时运行正式 initial-match worker。任务与一条时间戳为 epoch 的
	// 守卫记录必须在同一事务可见，避免 worker 在 Agent fixture 尚未写完时抢先生成快照。
	// 守卫记录不参与断言，只让 NOT EXISTS 调度条件稳定为 false。
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO tasks (
		 id, publisher_id, title, description, acceptance_criteria, deliverable_format,
		 category_id, category_version, tag_names, pricing_type, budget_min_minor,
		 budget_max_minor, currency, deadline, required_capability, attachments,
		 visibility, status, assignment_mode_config, acceptance_mode, acceptor_config
		) VALUES (
		 $1,'publisher','真实 Go 匹配集成任务','验证 PostgreSQL 输入快照、规则排序和候选证据持久化。',
		 '只有满足分类、预算、状态和时限的 Agent 才能进入候选。','Go 测试',
		 $2,1,ARRAY['agent','next.js'],'fixed',8000000,8000000,'USDC',$3,'Go 与 PostgreSQL','[]'::jsonb,
		 'public','matching','{"mode":"manual"}'::jsonb,'manual','{}'::jsonb
		)`, integrationTaskID, integrationCategory, deadline)
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO job_distribution_records (
		 task_id,rule_version,input_fingerprint,input_snapshot,candidates,filter_reasons,created_at
		) VALUES ($1,'ranking-v1','integration-worker-guard',
		 '{"AssignmentMode":"manual"}'::jsonb,'[]'::jsonb,'{}'::jsonb,to_timestamp(0))`, integrationTaskID)
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	insertAgent := func(id, name string, price int64) {
		t.Helper()
		_, insertErr := pool.Exec(ctx, `
			INSERT INTO agents (
			 id, provider_wallet_address, payout_wallet_address, name, category_id, capability_desc, tags,
			 pricing_type, price_amount, price_currency, service_endpoint, email, status,
			 estimated_duration_seconds, response_minutes
			) VALUES ($1,'0x1111111111111111111111111111111111111111','0x1111111111111111111111111111111111111111',$2,$3,'Go API',ARRAY['agent','next.js'],
			 'fixed',$4,'USDC','http://127.0.0.1:3999/agent','agent@example.com','active',3600,2)`,
			id, name, integrationCategory, price)
		if insertErr != nil {
			t.Fatal(insertErr)
		}
	}
	insertAgent(integrationAgentID, "符合约束的 Agent", 7000000)
	insertAgent(overBudgetAgentID, "超出预算的 Agent", 9000000)
	// 共享验收库的历史结算价格会改变冷启动分位数。fixture 显式使用完整历史上界，
	// 让本测试只验证预算是软偏好，不被库中无关历史任务随机改写前置条件。
	if _, err = pool.Exec(ctx, `
		INSERT INTO agent_status_config(agent_id,probation_budget_cap_percentile)
		VALUES($1,1),($2,1)`, integrationAgentID, overBudgetAgentID); err != nil {
		t.Fatal(err)
	}

	repository := &MatchingRepository{Pool: pool}
	service := matching.Service{Repository: repository, Now: time.Now}
	first, err := service.RunMatching(ctx, integrationTaskID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.RunMatching(ctx, integrationTaskID)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == "" || second.ID != first.ID {
		t.Fatalf("same input must replay one persisted record: first=%+v second=%+v", first, second)
	}
	// 预算现在是推荐偏好而不是候选资格：略高于偏好的 Agent 仍应展示，让用户比较后
	// 决定是否调整上限；真正的冻结金额只在所有节点完成选择后计算。
	if len(first.Candidates) != 2 || first.Candidates[0].AgentID != integrationAgentID ||
		first.Candidates[1].AgentID != overBudgetAgentID {
		t.Fatalf("unexpected candidates: %+v", first.Candidates)
	}
	if _, filtered := first.FilterReasons[overBudgetAgentID]; filtered {
		t.Fatalf("budget preference must not hide a valid candidate: %+v", first.FilterReasons)
	}
	latest, err := service.LatestCandidates(ctx, integrationTaskID)
	if err != nil || latest.ID != first.ID || len(latest.InputSnapshot) == 0 {
		t.Fatalf("latest record is not queryable: record=%+v err=%v", latest, err)
	}

	// 模拟业务 API 在 matching 状态下调整安全匹配条件。输入发生变化后必须新增记录，
	// 而不是覆盖首次快照；这正是发布者从“无候选”调整条件后的可追溯恢复路径。
	if _, err = pool.Exec(ctx, `
		UPDATE tasks SET tag_names=ARRAY['next.js'], status_version=status_version+1
		 WHERE id=$1 AND status='matching'`, integrationTaskID); err != nil {
		t.Fatal(err)
	}
	rematched, err := service.RunMatching(ctx, integrationTaskID)
	if err != nil {
		t.Fatal(err)
	}
	if rematched.ID == first.ID || rematched.InputFingerprint == first.InputFingerprint {
		t.Fatalf("changed criteria must create a new frozen record: first=%+v rematched=%+v", first, rematched)
	}
	var recordCount int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM job_distribution_records WHERE task_id=$1`, integrationTaskID).Scan(&recordCount); err != nil {
		t.Fatal(err)
	}
	if recordCount != 3 {
		t.Fatalf("historical matching record was overwritten: count=%d", recordCount)
	}
	latest, err = service.LatestCandidates(ctx, integrationTaskID)
	if err != nil || latest.ID != rematched.ID {
		t.Fatalf("latest record did not advance after criteria update: latest=%+v err=%v", latest, err)
	}
}

func TestInitialMatchCoordinatorPostgresAutomaticallyLocksFrozenTopCandidate(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	cleanupMatchingFixtures(t, ctx, pool)
	t.Cleanup(func() { cleanupMatchingFixtures(t, ctx, pool) })

	deadline := time.Now().UTC().Add(2 * time.Hour)
	_, err = pool.Exec(ctx, `
		INSERT INTO tasks (
		 id, publisher_id, title, description, acceptance_criteria, deliverable_format,
		 category_id, category_version, tag_names, pricing_type, budget_min_minor,
		 budget_max_minor, currency, deadline, required_capability, attachments,
		 visibility, status, assignment_mode_config, acceptance_mode, acceptor_config
		) VALUES (
		 $1,'publisher','自动分配集成任务','验证冻结候选第一名通过正式事务被系统锁定。',
		 '自动模式只能选择已展示的排序第一名。','Go 测试',$2,1,ARRAY['agent'],
		 'fixed',8000000,8000000,'USDC',$3,'Go 自动分配','[]'::jsonb,'public','matching',
		 '{"mode":"automatic","priceCapMinor":"8000000","rankingBasis":"active-ranking-rule","fallbackOnFail":"manual"}'::jsonb,
		 'manual','{}'::jsonb
		)`, integrationTaskID, integrationCategory, deadline)
	if err != nil {
		t.Fatal(err)
	}
	for _, agent := range []struct {
		id, name string
		price    int64
	}{
		{integrationAgentID, "排序第一的 Agent", 6500000},
		{overBudgetAgentID, "排序第二的 Agent", 7500000},
	} {
		_, err = pool.Exec(ctx, `
			INSERT INTO agents (
			 id, provider_wallet_address, payout_wallet_address, name, category_id, capability_desc, tags,
			 pricing_type, price_amount, price_currency, service_endpoint, email, status,
			 estimated_duration_seconds, response_minutes
			) VALUES ($1,'0x1111111111111111111111111111111111111111','0x1111111111111111111111111111111111111111',$2,$3,'Go API',ARRAY['agent'],
			 'fixed',$4,'USDC','http://127.0.0.1:3999/agent','agent@example.com','active',1800,1)`,
			agent.id, agent.name, integrationCategory, agent.price)
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err = pool.Exec(ctx, `
		INSERT INTO agent_status_config(agent_id,probation_budget_cap_percentile)
		VALUES($1,1),($2,1)`, integrationAgentID, overBudgetAgentID); err != nil {
		t.Fatal(err)
	}

	matchingRepository := &MatchingRepository{Pool: pool}
	assignmentRepository := &AssignmentRepository{Pool: pool}
	queue := &concurrentQueue{}
	coordinator := matching.InitialMatchCoordinator{
		Matcher: &matching.Service{Repository: matchingRepository, Now: time.Now},
		Dispatcher: &dispatch.Service{
			Repository: assignmentRepository, Queue: queue, Now: time.Now,
		},
	}
	worker := matching.InitialMatchWorker{Source: matchingRepository, Runner: &coordinator, Limit: 10}
	batch, err := worker.RunOnce(ctx)
	if err != nil || batch.Claimed != 1 || batch.Generated != 1 {
		t.Fatalf("initial worker did not process automatic task: batch=%+v err=%v", batch, err)
	}
	first, err := matchingRepository.Latest(ctx, integrationTaskID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := coordinator.RunMatching(ctx, integrationTaskID)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == "" || second.ID != first.ID || first.AssignmentMode != matching.AssignmentAutomatic {
		t.Fatalf("automatic mode was not frozen/replayed: first=%+v second=%+v", first, second)
	}
	if len(first.Candidates) != 2 || first.Candidates[0].AgentID != integrationAgentID {
		t.Fatalf("unexpected frozen ranking: %+v", first.Candidates)
	}
	var assignmentCount int
	var assignedAgent, assignedBy, finalSelection string
	err = pool.QueryRow(ctx, `
		SELECT count(*), min(agent_id::text), min(assigned_by),
		       min(record.final_selection_agent_id::text)
		  FROM task_assignments assignment
		  JOIN job_distribution_records record ON record.id=assignment.distribution_record_id
		 WHERE assignment.task_id=$1`, integrationTaskID,
	).Scan(&assignmentCount, &assignedAgent, &assignedBy, &finalSelection)
	if err != nil || assignmentCount != 1 || assignedAgent != integrationAgentID ||
		assignedBy != "system:auto" || finalSelection != integrationAgentID || queue.count() != 1 {
		t.Fatalf("automatic assignment evidence mismatch: count=%d agent=%s actor=%s final=%s queue=%d err=%v",
			assignmentCount, assignedAgent, assignedBy, finalSelection, queue.count(), err)
	}
}

func TestPendingInitialWorkflowNodesRetriesAutomaticNodeWithFrozenCandidates(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	cleanupMatchingFixtures(t, ctx, pool)
	t.Cleanup(func() { cleanupMatchingFixtures(t, ctx, pool) })

	deadline := time.Now().UTC().Add(2 * time.Hour)
	_, err = pool.Exec(ctx, `
		INSERT INTO tasks (
		 id,publisher_id,title,description,acceptance_criteria,deliverable_format,
		 category_id,category_version,tag_names,pricing_type,budget_min_minor,
		 budget_max_minor,currency,deadline,required_capability,attachments,
		 visibility,status,assignment_mode_config,acceptance_mode,acceptor_config
		) VALUES (
		 $1,'publisher','自动工作流恢复测试','验证已有冻结候选但派发尚未成功时会重新进入 worker。',
		 '自动分配必须能够从瞬时失败中恢复。','Go 测试',$2,1,ARRAY['agent'],
		 'fixed',8000000,8000000,'USDC',$3,'自动分配','[]'::jsonb,'private','executing',
		 '{"mode":"automatic","priceCapMinor":"8000000","rankingBasis":"active-ranking-rule","fallbackOnFail":"manual"}'::jsonb,
		 'manual','{}'::jsonb
		)`, integrationTaskID, integrationCategory, deadline)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO task_workflow_runs(
		 id,task_id,status,currency,total_budget_minor,released_amount_minor,refundable_amount_minor
		) VALUES ($1,$2,'running','USDC',8000000,0,8000000)`, integrationRunID, integrationTaskID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO task_workflow_nodes(
		 id,workflow_run_id,task_id,node_key,kind,title,description,category_id,tags,
		 required_capability,input_contract,output_contract,budget_cap_minor,position_index,status
		) VALUES ($1,$2,$3,'design','design','界面设计','生成正式设计制品',$4,ARRAY['agent'],
		 '界面设计','RequirementsArtifact','DesignArtifact',8000000,1,'matching')`,
		integrationNodeID, integrationRunID, integrationTaskID, integrationCategory)
	if err != nil {
		t.Fatal(err)
	}
	var distributionRecordID string
	err = pool.QueryRow(ctx, `
		INSERT INTO job_distribution_records(
		 task_id,workflow_node_id,rule_version,input_fingerprint,input_snapshot,candidates,filter_reasons
		) VALUES ($1,$2,'ranking-v1','frozen-before-dispatch','{}'::jsonb,
		 '[{"agentId":"80000000-0000-4000-8000-000000000002","quoteMinor":"7000000"}]'::jsonb,
		 '{}'::jsonb) RETURNING id::text`, integrationTaskID, integrationNodeID).Scan(&distributionRecordID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO agents(
		 id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,
		 pricing_type,price_amount,price_currency,service_endpoint,email,status,
		 estimated_duration_seconds,response_minutes
		) VALUES ($1,'0x1111111111111111111111111111111111111111',
		 '0x1111111111111111111111111111111111111111','超时恢复 Agent',$2,'自动分配',
		 ARRAY['agent'],'fixed',7000000,'USDC','http://127.0.0.1:3999/agent',
		 'timeout-recovery@example.com','active',1800,1)`, integrationAgentID, integrationCategory)
	if err != nil {
		t.Fatal(err)
	}
	const failedAssignmentID = "80000000-0000-4000-8000-000000000006"
	_, err = pool.Exec(ctx, `
		INSERT INTO task_assignments(
		 id,task_id,workflow_node_id,agent_id,distribution_record_id,agreed_amount_minor,
		 status,assigned_by,accept_by,responded_at
		) VALUES ($1,$2,$3,$4,$5,7000000,'accept_failed','system:auto',now()-interval '1 minute',now())`,
		failedAssignmentID, integrationTaskID, integrationNodeID, integrationAgentID, distributionRecordID)
	if err != nil {
		t.Fatal(err)
	}

	targets, err := (&MatchingRepository{Pool: pool}).PendingInitialWorkflowNodes(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	want := matching.WorkflowMatchTarget{TaskID: integrationTaskID, WorkflowNodeID: integrationNodeID}
	found := false
	for _, target := range targets {
		if target == want {
			found = true
			break
		}
	}
	// 本地开发库可能同时存在用户正在恢复的真实节点；测试只验证自己的固定 UUID
	// 能被扫描到，不能把“数据库里没有其他待处理业务”当成被测契约的一部分。
	if !found {
		t.Fatalf("automatic node with frozen candidates must remain retryable: got=%+v want=%+v", targets, want)
	}
	input, err := (&MatchingRepository{Pool: pool}).LoadWorkflowNodeInput(
		ctx, integrationTaskID, integrationNodeID,
	)
	if err != nil {
		t.Fatal(err)
	}
	// 接单拒绝和接单超时都会落为 accept_failed。下一次派发必须把这条终态分配纳入
	// 幂等身份，否则会重放第一次已经失败的派发记录，节点将永久卡在 matching。
	if input.PreviousAssignmentID != failedAssignmentID {
		t.Fatalf("accept_failed assignment must create replacement identity: got=%q want=%q",
			input.PreviousAssignmentID, failedAssignmentID)
	}
}

func cleanupMatchingFixtures(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	// 明确列出测试 UUID，避免清理命令影响用户或其他用例创建的数据。
	statements := []string{
		`DELETE FROM task_transition_outbox WHERE task_id='80000000-0000-4000-8000-000000000001'`,
		`DELETE FROM dispatch_attempts WHERE assignment_id IN (SELECT id FROM task_assignments WHERE task_id='80000000-0000-4000-8000-000000000001')`,
		`DELETE FROM task_assignments WHERE task_id='80000000-0000-4000-8000-000000000001'`,
		`DELETE FROM job_distribution_records WHERE task_id='80000000-0000-4000-8000-000000000001'`,
		`DELETE FROM task_workflow_edges WHERE workflow_run_id='80000000-0000-4000-8000-000000000004'`,
		`DELETE FROM task_workflow_nodes WHERE task_id='80000000-0000-4000-8000-000000000001'`,
		`DELETE FROM task_workflow_runs WHERE task_id='80000000-0000-4000-8000-000000000001'`,
		`DELETE FROM agent_status_config WHERE agent_id IN ('80000000-0000-4000-8000-000000000002','80000000-0000-4000-8000-000000000003')`,
		`DELETE FROM agents WHERE id IN ('80000000-0000-4000-8000-000000000002','80000000-0000-4000-8000-000000000003')`,
		`DELETE FROM tasks WHERE id='80000000-0000-4000-8000-000000000001'`,
	}
	for _, statement := range statements {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatalf("cleanup matching fixture: %v", err)
		}
	}
}
