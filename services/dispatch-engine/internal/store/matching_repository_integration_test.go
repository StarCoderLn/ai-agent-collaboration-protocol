package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/matching"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/matchingfeedback"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/matchingv2"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/semanticmatching"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/temporaltraining"
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
		) VALUES ($1,$2,'awaiting_review','USDC',8000000,0,8000000)`, integrationRunID, integrationTaskID)
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
	if _, err = pool.Exec(ctx, `
		UPDATE job_distribution_records SET final_selection_agent_id=$2 WHERE id=$1`,
		distributionRecordID, integrationAgentID); err != nil {
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
	// run 处于 awaiting_review 模拟并行兄弟节点已经交付。调度必须继续扫描本节点，
	// 不能因为聚合状态优先展示“待验收”就饿死仍在 matching 的并行分支。
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

	// 扫描到节点还不够：锁定事务也必须接受 awaiting_review 聚合状态，否则 worker
	// 会每秒领取同一节点，却永远以 CANDIDATE_NOT_FOUND 失败，形成无进展的忙循环。
	replacementQueue := &concurrentQueue{}
	coordinator := matching.InitialMatchCoordinator{
		Matcher: &matching.Service{Repository: &MatchingRepository{Pool: pool}, Now: time.Now},
		Dispatcher: &dispatch.Service{
			Repository: &AssignmentRepository{Pool: pool}, Queue: replacementQueue, Now: time.Now,
		},
	}
	if _, err = coordinator.RunWorkflowNodeMatching(ctx, integrationTaskID, integrationNodeID); err != nil {
		t.Fatal(err)
	}
	var replacementCount int
	err = pool.QueryRow(ctx, `
		SELECT count(*) FROM task_assignments
		 WHERE workflow_node_id=$1 AND status='pending_ack'`, integrationNodeID).Scan(&replacementCount)
	if err != nil || replacementCount != 1 || replacementQueue.count() != 1 {
		t.Fatalf("awaiting_review sibling blocked replacement dispatch: replacements=%d queue=%d err=%v",
			replacementCount, replacementQueue.count(), err)
	}
}

func TestMatchingFeedbackRepositoryPersistsOneImmutableExposureFact(t *testing.T) {
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
		INSERT INTO tasks(
		 id,publisher_id,title,description,acceptance_criteria,deliverable_format,category_id,
		 category_version,tag_names,pricing_type,budget_min_minor,budget_max_minor,currency,
		 deadline,required_capability,attachments,visibility,status,assignment_mode_config,
		 acceptance_mode,acceptor_config
		) VALUES($1,'publisher','曝光事实测试','只允许冻结候选形成训练曝光。','候选进入可视区域一秒。',
		 'Go 测试',$2,1,ARRAY['agent'],'fixed',7000000,7000000,'USDC',$3,'匹配反馈','[]'::jsonb,
		 'private','planning','{"mode":"manual"}'::jsonb,'manual','{}'::jsonb)`, integrationTaskID, integrationCategory, deadline)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO task_workflow_runs(
		 id,task_id,status,currency,total_budget_minor,released_amount_minor,refundable_amount_minor
		) VALUES($1,$2,'planning','USDC',7000000,0,7000000)`, integrationRunID, integrationTaskID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO task_workflow_nodes(
		 id,workflow_run_id,task_id,node_key,kind,title,description,category_id,tags,
		 required_capability,input_contract,output_contract,budget_cap_minor,position_index,status
		) VALUES($1,$2,$3,'research','research','资料研究','生成研究材料',$4,ARRAY['agent'],
		 '资料研究','TaskContract','ResearchArtifact',7000000,1,'selecting')`, integrationNodeID, integrationRunID, integrationTaskID, integrationCategory)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO agents(
		 id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,
		 pricing_type,price_amount,price_currency,service_endpoint,email,status,estimated_duration_seconds,response_minutes
		) VALUES($1,'0x1111111111111111111111111111111111111111','0x1111111111111111111111111111111111111111',
		 '曝光 Agent',$2,'资料研究',ARRAY['agent'],'fixed',7000000,'USDC','http://127.0.0.1:3999/agent',
		 'exposure@example.com','active',1800,1)`, integrationAgentID, integrationCategory)
	if err != nil {
		t.Fatal(err)
	}
	var recordID string
	err = pool.QueryRow(ctx, `
		INSERT INTO job_distribution_records(
		 task_id,workflow_node_id,rule_version,input_fingerprint,input_snapshot,candidates,filter_reasons
		) VALUES($1,$2,'ranking-v1','exposure-integration','{}'::jsonb,
		 '[{"agentId":"80000000-0000-4000-8000-000000000002"}]'::jsonb,'{}'::jsonb)
		RETURNING id::text`, integrationTaskID, integrationNodeID).Scan(&recordID)
	if err != nil {
		t.Fatal(err)
	}
	repository := &MatchingFeedbackRepository{Pool: pool}
	exposure := matchingfeedback.Exposure{
		EventKey: "matching-exposure-integration-1", ViewSessionID: "80000000-0000-4000-8000-000000000007",
		DistributionRecordID: recordID, TaskID: integrationTaskID, WorkflowNodeID: integrationNodeID,
		AgentID: integrationAgentID, ActorID: "publisher", Position: 1, VisibleMillis: 1000,
		OccurredAt: time.Now().UTC().Truncate(time.Millisecond),
	}
	if err = repository.RecordExposure(ctx, exposure); err != nil {
		t.Fatal(err)
	}
	if err = repository.RecordExposure(ctx, exposure); err != nil {
		t.Fatalf("same event must replay idempotently: %v", err)
	}
	exposure.Position = 2
	if err = repository.RecordExposure(ctx, exposure); !errors.Is(err, matchingfeedback.ErrExposureDenied) {
		t.Fatalf("same event key changed its immutable payload: %v", err)
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM matching_candidate_exposures WHERE event_key=$1`, exposure.EventKey).Scan(&count); err != nil || count != 1 {
		t.Fatalf("exposure was duplicated: count=%d err=%v", count, err)
	}
}

func TestMatchingV2RepositoryClaimsAndAtomicallyPersistsShadowScores(t *testing.T) {
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
		INSERT INTO tasks(
		 id,publisher_id,title,description,acceptance_criteria,deliverable_format,category_id,
		 category_version,tag_names,pricing_type,budget_min_minor,budget_max_minor,currency,
		 deadline,required_capability,attachments,visibility,status,assignment_mode_config,
		 acceptance_mode,acceptor_config
		) VALUES($1,'publisher','影子任务测试','验证正式候选与 V2 影子分数隔离。','影子失败不得影响正式候选。',
		 'Go 测试',$2,1,ARRAY['agent'],'fixed',7000000,7000000,'USDC',$3,'匹配 V2','[]'::jsonb,
		 'private','matching','{"mode":"manual"}'::jsonb,'manual','{}'::jsonb)`, integrationTaskID, integrationCategory, deadline)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO agents(
		 id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,
		 pricing_type,price_amount,price_currency,service_endpoint,email,status,estimated_duration_seconds,response_minutes
		) VALUES($1,'0x1111111111111111111111111111111111111111','0x1111111111111111111111111111111111111111',
		 '影子 Agent',$2,'后端服务',ARRAY['agent'],'fixed',7000000,'USDC','http://127.0.0.1:3999/agent',
		 'shadow@example.com','active',1800,1)`, integrationAgentID, integrationCategory)
	if err != nil {
		t.Fatal(err)
	}
	request := json.RawMessage(`{"featureSchemaVersion":"matching-v2.features.v1","candidates":[{"schemaVersion":"matching-v2.dataset.v1","dataOrigin":"real","taskId":"80000000-0000-4000-8000-000000000001","agentId":"80000000-0000-4000-8000-000000000002","taskCategory":"40000000-0000-4000-8000-000000000001","agentCategory":"40000000-0000-4000-8000-000000000001","occurredAt":"2026-09-14T00:00:00Z","semanticSimilarity":0.9,"tagCoverage":1,"priceRatio":1,"qualityScore":4.5,"confidence":0,"responseMinutes":1,"currentLoad":0,"onTimeRate":0,"reworkRate":0,"disputeRate":0,"admissionScore":80,"position":1,"isNew":1}]}`)
	record, err := (&MatchingRepository{Pool: pool}).Save(ctx, matching.Record{
		TaskID: integrationTaskID, RuleVersion: "ranking-v1", InputFingerprint: "matching-v2-shadow-integration",
		InputSnapshot: json.RawMessage(`{"AssignmentMode":"manual"}`),
		Candidates:    []matching.CandidateView{{AgentID: integrationAgentID, QuoteMinor: "7000000", MatchedTags: []string{}, UnmatchedTags: []string{}, RecommendationBadges: []string{}, DeliveryCases: []domain.AgentDeliveryCase{}}},
		FilterReasons: map[string]domain.EligibilityReason{}, MatchingMode: "semantic_v1",
		SemanticModel: "text-embedding-3-small", ShadowRequest: request,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO matching_v2_training_runs(
		 id,workflow_id,request_fingerprint,status,data_origin,window_start,window_end,
		 feature_schema_version,started_at,completed_at
		) VALUES('80000000-0000-4000-8000-000000000008','shadow-integration-workflow',repeat('a',64),
		 'succeeded','synthetic',now()-interval '1 day',now(),'matching-v2.features.v1',now(),now())`)
	if err != nil {
		t.Fatal(err)
	}
	const modelVersion = "matching-v2-20260914000000-12345678"
	_, err = pool.Exec(ctx, `
		INSERT INTO matching_v2_model_versions(
		 version,training_run_id,state,feature_schema_version,artifact_uri,artifact_sha256,
		 training_data_origin,sample_count,metrics
		) VALUES($1,'80000000-0000-4000-8000-000000000008','candidate','matching-v2.features.v1',
		 '/tmp/model.onnx',repeat('b',64),'synthetic',300,'{}'::jsonb)`, modelVersion)
	if err != nil {
		t.Fatal(err)
	}
	trainingRepository := &MatchingTrainingRepository{Pool: pool}
	if err = trainingRepository.PromoteShadowModel(ctx, modelVersion, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	repository := &MatchingV2Repository{Pool: pool}
	var databaseNow time.Time
	var pendingJobs int
	var modelState string
	if err = pool.QueryRow(ctx, `SELECT now(),(SELECT count(*) FROM matching_v2_shadow_jobs WHERE distribution_record_id=$1),(SELECT state FROM matching_v2_model_versions WHERE version=$2)`, record.ID, modelVersion).Scan(&databaseNow, &pendingJobs, &modelState); err != nil {
		t.Fatal(err)
	}
	if pendingJobs != 1 || modelState != "shadow" {
		t.Fatalf("shadow prerequisites were not persisted: jobs=%d model=%s", pendingJobs, modelState)
	}
	claim, claimed, err := repository.Claim(ctx, databaseNow.Add(time.Millisecond), time.Minute)
	if err != nil || !claimed || claim.DistributionRecordID != record.ID || claim.ModelVersion != modelVersion {
		t.Fatalf("shadow task was not claimed with deployed model: claim=%+v claimed=%t err=%v", claim, claimed, err)
	}
	err = repository.Complete(ctx, claim, []matchingv2.Score{{
		AgentID: integrationAgentID, PCTR: 0.5, PCVR: 0.4, PCTCVR: 0.2, ShadowRank: 1,
	}}, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	var status string
	var scoreCount int
	err = pool.QueryRow(ctx, `
		SELECT job.status,count(score.agent_id)
		  FROM matching_v2_shadow_jobs job
		  LEFT JOIN matching_v2_shadow_scores score ON score.distribution_record_id=job.distribution_record_id
		 WHERE job.distribution_record_id=$1 GROUP BY job.status`, record.ID).Scan(&status, &scoreCount)
	if err != nil || status != "scored" || scoreCount != 1 {
		t.Fatalf("shadow completion was not atomic: status=%s scores=%d err=%v", status, scoreCount, err)
	}
	skipped, err := trainingRepository.PrepareDataset(ctx, temporaltraining.PrepareInput{
		WorkflowID: "matching-v2-small-integration", WindowStart: databaseNow.Add(-2 * time.Hour), WindowEnd: databaseNow.Add(-time.Hour),
	}, t.TempDir()+"/small.jsonl")
	if err != nil || skipped.SkipReason != "MATCHING_TRAINING_SAMPLE_TOO_SMALL" || skipped.SampleCount != 0 {
		t.Fatalf("small dataset must be an audited skip: prepared=%+v err=%v", skipped, err)
	}
	// 300 次真实浏览器会话用于越过训练数据门槛。选中 Agent 明确拒单，因此 accepted
	// 和 success 均为 false；这是一条完整终态，而不是把仍在执行的样本标成失败。
	if _, err = pool.Exec(ctx, `UPDATE job_distribution_records SET final_selection_agent_id=$2 WHERE id=$1`, record.ID, integrationAgentID); err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO task_assignments(
		 id,task_id,agent_id,distribution_record_id,agreed_amount_minor,status,assigned_by,
		 assigned_at,accept_by,responded_at
		) VALUES('80000000-0000-4000-8000-000000000009',$1,$2,$3,7000000,'accept_failed',
		 'publisher',now()-interval '2 minutes',now()-interval '1 minute',now()-interval '1 minute')`, integrationTaskID, integrationAgentID, record.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO matching_candidate_exposures(
		 event_key,view_session_id,distribution_record_id,task_id,agent_id,actor_id,position,
		 visible_millis,data_origin,occurred_at
		)
		SELECT 'matching-export-'||lpad(value::text,4,'0'),gen_random_uuid(),$1,$2,$3,
		       'publisher',1,1000,'real',$4::timestamptz-interval '5 minutes'
		  FROM generate_series(1,300) value`, record.ID, integrationTaskID, integrationAgentID, databaseNow)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := trainingRepository.PrepareDataset(ctx, temporaltraining.PrepareInput{
		WorkflowID: "matching-v2-export-integration", WindowStart: databaseNow.Add(-time.Hour), WindowEnd: databaseNow.Add(time.Hour),
	}, t.TempDir()+"/real.jsonl")
	if err != nil || prepared.SampleCount != 300 || prepared.DataOrigin != "real" {
		t.Fatalf("real funnel export mismatch: prepared=%+v err=%v", prepared, err)
	}
	encoded, err := os.ReadFile(prepared.DatasetPath)
	if err != nil {
		t.Fatal(err)
	}
	var exported map[string]any
	if err = json.Unmarshal(bytes.Split(encoded, []byte{'\n'})[0], &exported); err != nil || exported["selected"] != true || exported["accepted"] != false || exported["success"] != false {
		t.Fatalf("terminal rejection labels are invalid: example=%+v err=%v", exported, err)
	}
}

// TestMatchingV1ToV2WorkerLiveModels 是可选的真实组合验收：正式 MatchingService 先调用
// OpenAI Embedding 和 pgvector 建立 V1 私有召回池，再由 Worker 调用正在运行的 PyTorch
// HTTP 服务并原子保存 V2 分数。默认测试不依赖公网或常驻模型进程；只有调用方显式
// 提供两类模型配置时才执行这条边界检查。
func TestMatchingV1ToV2WorkerLiveModels(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	modelURL := os.Getenv("MATCHING_V2_LIVE_MODEL_URL")
	modelVersion := os.Getenv("MATCHING_V2_LIVE_MODEL_VERSION")
	openAIKey := os.Getenv("OPENAI_API_KEY")
	if databaseURL == "" || modelURL == "" || modelVersion == "" || openAIKey == "" {
		t.Skip("DATABASE_URL and live V1/V2 models are not configured")
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
		INSERT INTO tasks(
		 id,publisher_id,title,description,acceptance_criteria,deliverable_format,category_id,
		 category_version,tag_names,pricing_type,budget_min_minor,budget_max_minor,currency,
		 deadline,required_capability,attachments,visibility,status,assignment_mode_config,
		 acceptance_mode,acceptor_config
		) VALUES($1,'publisher','真实 V2 模型组合验收','验证影子 Worker 调用模型并保存完整排序。',
		 '影子结果不改变正式候选。','Go 测试',$2,1,ARRAY['agent'],'fixed',7000000,7000000,
		 'USDC',$3,'匹配 V2','[]'::jsonb,'private','matching','{"mode":"manual"}'::jsonb,
		 'manual','{}'::jsonb)`, integrationTaskID, integrationCategory, deadline)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO agents(
		 id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,
		 pricing_type,price_amount,price_currency,service_endpoint,email,status,
		 estimated_duration_seconds,response_minutes
		) VALUES
		 ($1,'0x1111111111111111111111111111111111111111',
		  '0x1111111111111111111111111111111111111111','API 集成专家',$3,
		  '设计 Go 与 TypeScript 后端接口并实现 Agent 调度服务',ARRAY['agent','api','go'],
		  'fixed',6500000,'USDC','http://127.0.0.1:3999/agent',
		  'live-shadow-api@example.com','active',1800,1),
		 ($2,'0x2222222222222222222222222222222222222222',
		  '0x2222222222222222222222222222222222222222','全栈交付专家',$3,
		  '完成 Next.js 前端、Go API 与数据库集成',ARRAY['agent','next.js','postgresql'],
		  'fixed',7000000,'USDC','http://127.0.0.1:3998/agent',
		  'live-shadow-fullstack@example.com','active',2400,3)`,
		integrationAgentID, overBudgetAgentID, integrationCategory)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `
		INSERT INTO agent_status_config(agent_id,probation_budget_cap_percentile)
		VALUES($1,1),($2,1)`, integrationAgentID, overBudgetAgentID); err != nil {
		t.Fatal(err)
	}
	repository := &MatchingRepository{Pool: pool}
	service := &matching.Service{
		Repository: repository,
		Semantic: &semanticmatching.Service{
			Embedder: &semanticmatching.OpenAIEmbedder{
				Client: &http.Client{Timeout: 15 * time.Second}, BaseURL: "https://api.openai.com/v1",
				APIKey: openAIKey, Model: semanticmatching.DefaultModel, Dimensions: semanticmatching.DefaultDimensions,
			},
			Store:  &semanticmatching.PostgresStore{Pool: pool},
			Config: semanticmatching.Config{Model: semanticmatching.DefaultModel, Dimensions: semanticmatching.DefaultDimensions, TopK: 30},
		},
	}
	record, err := service.RunMatching(ctx, integrationTaskID)
	if err != nil {
		t.Fatal(err)
	}
	if record.MatchingMode != "semantic_v1" || len(record.Candidates) != 2 {
		t.Fatalf("V1 did not persist its formal result: mode=%s candidates=%d", record.MatchingMode, len(record.Candidates))
	}
	scorer := &matchingv2.HTTPScorer{BaseURL: modelURL, Client: &http.Client{Timeout: 10 * time.Second}}
	if err = scorer.CheckHealth(ctx, modelVersion); err != nil {
		t.Fatal(err)
	}
	trainingRepository := &MatchingTrainingRepository{Pool: pool}
	if err = trainingRepository.PromoteShadowModel(ctx, modelVersion, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	worker := &matchingv2.Worker{
		Repository: &MatchingV2Repository{Pool: pool}, Scorer: scorer, Lease: time.Minute,
	}
	processed, err := worker.RunOnce(ctx)
	if err != nil || !processed {
		t.Fatalf("live shadow worker did not process the task: processed=%t err=%v", processed, err)
	}
	var status, persistedVersion string
	var scoreCount int
	err = pool.QueryRow(ctx, `
		SELECT job.status,job.model_version,count(score.agent_id)
		  FROM matching_v2_shadow_jobs job
		  LEFT JOIN matching_v2_shadow_scores score
		    ON score.distribution_record_id=job.distribution_record_id
		 WHERE job.distribution_record_id=$1
		 GROUP BY job.status,job.model_version`, record.ID).Scan(&status, &persistedVersion, &scoreCount)
	if err != nil || status != "scored" || persistedVersion != modelVersion || scoreCount != 2 {
		t.Fatalf("live model scores were not persisted: status=%s version=%s scores=%d err=%v", status, persistedVersion, scoreCount, err)
	}
}

func cleanupMatchingFixtures(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	// 明确列出测试 UUID，避免清理命令影响用户或其他用例创建的数据。
	statements := []string{
		`DELETE FROM matching_candidate_exposures WHERE task_id='80000000-0000-4000-8000-000000000001'`,
		`DELETE FROM matching_v2_shadow_scores WHERE distribution_record_id IN (SELECT id FROM job_distribution_records WHERE task_id='80000000-0000-4000-8000-000000000001')`,
		`DELETE FROM matching_v2_shadow_jobs WHERE distribution_record_id IN (SELECT id FROM job_distribution_records WHERE task_id='80000000-0000-4000-8000-000000000001')`,
		`DELETE FROM matching_v2_model_versions WHERE training_run_id='80000000-0000-4000-8000-000000000008'`,
		`DELETE FROM matching_v2_training_runs WHERE id='80000000-0000-4000-8000-000000000008'`,
		`DELETE FROM matching_v2_training_runs WHERE workflow_id='matching-v2-export-integration'`,
		`DELETE FROM matching_v2_training_runs WHERE workflow_id='matching-v2-small-integration'`,
		`DELETE FROM task_transition_outbox WHERE task_id='80000000-0000-4000-8000-000000000001'`,
		`DELETE FROM workflow_node_transition_inbox WHERE task_id='80000000-0000-4000-8000-000000000001'`,
		`DELETE FROM workflow_node_transition_outbox WHERE task_id='80000000-0000-4000-8000-000000000001'`,
		`DELETE FROM webhook_deliveries WHERE task_event_id IN (SELECT id FROM task_events WHERE task_id='80000000-0000-4000-8000-000000000001')`,
		`DELETE FROM task_events WHERE task_id='80000000-0000-4000-8000-000000000001'`,
		`DELETE FROM dispatch_attempts WHERE assignment_id IN (SELECT id FROM task_assignments WHERE task_id='80000000-0000-4000-8000-000000000001')`,
		`DELETE FROM task_assignments WHERE task_id='80000000-0000-4000-8000-000000000001'`,
		`DELETE FROM job_distribution_records WHERE task_id='80000000-0000-4000-8000-000000000001'`,
		`DELETE FROM workflow_node_events WHERE task_id='80000000-0000-4000-8000-000000000001'`,
		`DELETE FROM task_workflow_edges WHERE workflow_run_id='80000000-0000-4000-8000-000000000004'`,
		`DELETE FROM task_workflow_nodes WHERE task_id='80000000-0000-4000-8000-000000000001'`,
		`DELETE FROM task_workflow_runs WHERE task_id='80000000-0000-4000-8000-000000000001'`,
		`DELETE FROM agent_score_refresh_requests WHERE agent_id IN ('80000000-0000-4000-8000-000000000002','80000000-0000-4000-8000-000000000003')`,
		`DELETE FROM agent_score_snapshots WHERE agent_id IN ('80000000-0000-4000-8000-000000000002','80000000-0000-4000-8000-000000000003')`,
		`DELETE FROM agent_status_config WHERE agent_id IN ('80000000-0000-4000-8000-000000000002','80000000-0000-4000-8000-000000000003')`,
		`DELETE FROM agent_matching_embeddings WHERE agent_id IN ('80000000-0000-4000-8000-000000000002','80000000-0000-4000-8000-000000000003')`,
		`DELETE FROM agents WHERE id IN ('80000000-0000-4000-8000-000000000002','80000000-0000-4000-8000-000000000003')`,
		`DELETE FROM tasks WHERE id='80000000-0000-4000-8000-000000000001'`,
	}
	for _, statement := range statements {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatalf("cleanup matching fixture: %v", err)
		}
	}
}
