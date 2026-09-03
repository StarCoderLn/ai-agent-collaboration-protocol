package store

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/matching"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	workflowDispatchTaskID = "81200000-0000-4000-8000-000000000001"
	workflowRunID          = "81200000-0000-4000-8000-000000000002"
	workflowNodeAID        = "81200000-0000-4000-8000-000000000003"
	workflowNodeBID        = "81200000-0000-4000-8000-000000000004"
	workflowDispatchAgent  = "81200000-0000-4000-8000-000000000005"
)

func TestEscrowSecuresWorkflowRetry(t *testing.T) {
	testCases := map[string]bool{
		"confirmed":          true,
		"partially_released": true,
		"prepared":           false,
		"released":           false,
		"refunded":           false,
		"failed":             false,
	}
	for status, expected := range testCases {
		if actual := escrowSecuresWorkflowRetry(status); actual != expected {
			t.Fatalf("escrow retry policy mismatch: status=%s actual=%t expected=%t", status, actual, expected)
		}
	}
}

func TestWorkflowNodeAllowsExecutionRetry(t *testing.T) {
	testCases := []struct {
		name                  string
		nodeStatus            string
		currentAssignmentID   string
		executionAssignmentID string
		expected              bool
	}{
		{name: "显式执行失败", nodeStatus: "execution_failed", currentAssignmentID: "current", executionAssignmentID: "current", expected: true},
		{name: "恢复初始化卡死", nodeStatus: "executing", currentAssignmentID: "current", executionAssignmentID: "previous", expected: true},
		{name: "当前批次正在执行", nodeStatus: "executing", currentAssignmentID: "current", executionAssignmentID: "current", expected: false},
		{name: "尚无执行证据", nodeStatus: "executing", currentAssignmentID: "current", executionAssignmentID: "", expected: false},
		{name: "匹配阶段", nodeStatus: "matching", currentAssignmentID: "current", executionAssignmentID: "previous", expected: false},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			actual := workflowNodeAllowsExecutionRetry(
				testCase.nodeStatus, testCase.currentAssignmentID, testCase.executionAssignmentID,
			)
			if actual != testCase.expected {
				t.Fatalf("workflow retry eligibility mismatch: actual=%t expected=%t", actual, testCase.expected)
			}
		})
	}
}

// TestWorkflowAssignmentRepositoryPostgresNodeIsolation 验证正式工作流最关键的数据库
// 不变量：每个节点可以独立占用候选，但候选、预算、幂等键和迁移事件不能跨节点串用。
func TestWorkflowAssignmentRepositoryPostgresNodeIsolation(t *testing.T) {
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
	cleanupWorkflowDispatchFixtures(t, ctx, pool)
	t.Cleanup(func() { cleanupWorkflowDispatchFixtures(t, ctx, pool) })
	seedWorkflowDispatchFixtures(t, ctx, pool)

	repository := &AssignmentRepository{Pool: pool}
	queue := &concurrentQueue{}
	service := dispatch.Service{Repository: repository, Queue: queue, Now: time.Now}
	// 托管确认后的恢复 worker 使用 system:selected，表示它派发的是发布者在托管前
	// 已冻结的选择。只允许这个精确身份，不能把任意 system:* 字符串当成可信调用方。
	_, err = service.ConfirmCandidate(ctx, dispatch.LockCommand{
		TaskID: workflowDispatchTaskID, WorkflowNodeID: workflowNodeAID,
		AgentID: workflowDispatchAgent, ActorID: "system:forged",
		IdempotencyKey: "dispatch:workflow-node-a:forged-system-actor",
	})
	if !errors.Is(err, dispatch.ErrCandidateNotFound) {
		t.Fatalf("untrusted system actor bypassed publisher authorization: err=%v", err)
	}
	first, err := service.ConfirmCandidate(ctx, dispatch.LockCommand{
		TaskID: workflowDispatchTaskID, WorkflowNodeID: workflowNodeAID,
		AgentID: workflowDispatchAgent, ActorID: "system:selected",
		IdempotencyKey: "dispatch:workflow-node-a:request-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Assignment.WorkflowNodeID != workflowNodeAID || first.Assignment.AgreedAmountMinor != 3_000_000 {
		t.Fatalf("node identity or frozen quote was lost: %+v", first.Assignment)
	}

	latest, err := repository.LatestForWorkflowNode(ctx, workflowDispatchTaskID, workflowNodeAID)
	if err != nil || latest.Assignment.ID != first.Assignment.ID || latest.Assignment.WorkflowNodeID != workflowNodeAID {
		t.Fatalf("latest workflow assignment mismatch: result=%+v err=%v", latest, err)
	}

	_, err = service.ConfirmCandidate(ctx, dispatch.LockCommand{
		TaskID: workflowDispatchTaskID, WorkflowNodeID: workflowNodeBID,
		AgentID: workflowDispatchAgent, ActorID: "publisher-workflow",
		IdempotencyKey: "dispatch:workflow-node-a:request-1",
	})
	if !errors.Is(err, dispatch.ErrIdempotencyKeyReused) {
		t.Fatalf("idempotency key crossed workflow nodes: err=%v", err)
	}

	second, err := service.ConfirmCandidate(ctx, dispatch.LockCommand{
		TaskID: workflowDispatchTaskID, WorkflowNodeID: workflowNodeBID,
		AgentID: workflowDispatchAgent, ActorID: "publisher-workflow",
		IdempotencyKey: "dispatch:workflow-node-b:request-1",
	})
	if err != nil || second.Assignment.ID == first.Assignment.ID {
		t.Fatalf("independent workflow node could not lock a candidate: result=%+v err=%v", second, err)
	}

	accepted, err := service.Acknowledge(ctx, first.Assignment.ID, workflowDispatchAgent, true)
	if err != nil || accepted.Status != domain.AssignmentAccepted || accepted.WorkflowNodeID != workflowNodeAID {
		t.Fatalf("workflow acknowledgement lost node identity: assignment=%+v err=%v", accepted, err)
	}

	var workflowTransitions, legacyTransitions int
	err = pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM workflow_node_transition_outbox WHERE task_id=$1),
		       (SELECT count(*) FROM task_transition_outbox WHERE task_id=$1)`,
		workflowDispatchTaskID,
	).Scan(&workflowTransitions, &legacyTransitions)
	if err != nil || workflowTransitions != 3 || legacyTransitions != 0 || queue.count() != 2 {
		t.Fatalf("workflow facts entered the wrong outbox: workflow=%d legacy=%d queue=%d err=%v",
			workflowTransitions, legacyTransitions, queue.count(), err)
	}
}

// TestWorkflowReworkWebhookRebuildsDispatchAfterRestart 锁定返工恢复的关键契约：Webhook
// 记录本身只保存返工事实，但领取投递时必须从数据库补齐完整 dispatch.v1，并用返工
// request ID 建立新的回调幂等域。Product Workflow Agent 即使已经重启，也能直接执行。
func TestWorkflowReworkWebhookRebuildsDispatchAfterRestart(t *testing.T) {
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
	cleanupWorkflowDispatchFixtures(t, ctx, pool)
	t.Cleanup(func() { cleanupWorkflowDispatchFixtures(t, ctx, pool) })
	seedWorkflowDispatchFixtures(t, ctx, pool)

	service := dispatch.Service{
		Repository: &AssignmentRepository{Pool: pool}, Queue: &concurrentQueue{}, Now: time.Now,
	}
	locked, err := service.ConfirmCandidate(ctx, dispatch.LockCommand{
		TaskID: workflowDispatchTaskID, WorkflowNodeID: workflowNodeAID,
		AgentID: workflowDispatchAgent, ActorID: "publisher-workflow",
		IdempotencyKey: "dispatch:workflow-rework:initial",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.Acknowledge(ctx, locked.Assignment.ID, workflowDispatchAgent, true); err != nil {
		t.Fatal(err)
	}
	const requestID = "81200000-0000-4000-8000-000000000099"
	var eventID int64
	err = pool.QueryRow(ctx, `
		INSERT INTO task_events(task_id,status_version,event_type,payload)
		VALUES ($1,2,'task.rework_requested',jsonb_build_object(
		  'workflowNodeId',$2::text,'requestId',$3::text,'requestNo',1,
		  'resultId','81200000-0000-4000-8000-000000000098',
		  'reason','请重新检查页面视觉一致性并补全交互状态。','status','rework'
		)) RETURNING id`, workflowDispatchTaskID, workflowNodeAID, requestID).Scan(&eventID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO webhook_deliveries(
		 task_event_id,agent_id,endpoint,idempotency_key,status,next_attempt_at
		) VALUES ($1,$2,'http://127.0.0.1:3999/agent/webhook',$3,'pending',now()+interval '1 hour')`,
		eventID, workflowDispatchAgent, "webhook:workflow-rework:1")
	if err != nil {
		t.Fatal(err)
	}

	deliveries, err := (&WebhookRepository{
		Pool: pool, CallbackBaseURL: "http://127.0.0.1:3200",
	}).ClaimDue(ctx, time.Now().UTC().Add(2*time.Hour), 30*time.Second, 10)
	if err != nil || len(deliveries) != 1 {
		t.Fatalf("claim rework webhook: deliveries=%+v err=%v", deliveries, err)
	}
	var envelope struct {
		RequestID string `json:"requestId"`
		Dispatch  struct {
			SchemaVersion string `json:"schemaVersion"`
			RequestID     string `json:"requestId"`
			AssignmentID  string `json:"assignmentId"`
			Workflow      struct {
				NodeID string `json:"nodeId"`
			} `json:"workflow"`
		} `json:"dispatch"`
	}
	if err = json.Unmarshal(deliveries[0].Payload, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.RequestID != requestID || envelope.Dispatch.SchemaVersion != "dispatch.v1" ||
		envelope.Dispatch.RequestID != requestID || envelope.Dispatch.AssignmentID != locked.Assignment.ID ||
		envelope.Dispatch.Workflow.NodeID != workflowNodeAID {
		t.Fatalf("rework dispatch was not rebuilt from durable state: %+v", envelope)
	}
}

// TestWorkflowExecutionRetryPostgresPreservesEscrowAndReplaysOnce 验证失败节点恢复的资金
// 与幂等边界：最终验收前 Escrow 必须保持 confirmed 且已释放额为零，旧 assignment 只
// 取消一次，节点状态由 outbox 消费者后续迁移，重复请求只能返回同一条恢复事件。
func TestWorkflowExecutionRetryPostgresPreservesEscrowAndReplaysOnce(t *testing.T) {
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
	cleanupWorkflowDispatchFixtures(t, ctx, pool)
	t.Cleanup(func() { cleanupWorkflowDispatchFixtures(t, ctx, pool) })
	seedWorkflowDispatchFixtures(t, ctx, pool)

	repository := &AssignmentRepository{Pool: pool}
	service := dispatch.Service{Repository: repository, Queue: &concurrentQueue{}, Now: time.Now}
	locked, err := service.ConfirmCandidate(ctx, dispatch.LockCommand{
		TaskID: workflowDispatchTaskID, WorkflowNodeID: workflowNodeAID,
		AgentID: workflowDispatchAgent, ActorID: "publisher-workflow",
		IdempotencyKey: "dispatch:workflow-retry:initial",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.Acknowledge(ctx, locked.Assignment.ID, workflowDispatchAgent, true); err != nil {
		t.Fatal(err)
	}
	// 真实失败回调会留下指向旧 assignment 的执行快照。节点恢复到 matching 后当前
	// 状态会变化，但这条快照仍是判断新派发是否属于失败恢复的权威尝试级证据。
	if _, err = pool.Exec(ctx, `
		INSERT INTO workflow_node_execution_state(
		 workflow_node_id,task_id,assignment_id,progress,execution_state,failure_code,last_reported_at
		) VALUES ($1,$2,$3,10,'failed','MODEL_OUTPUT_INVALID',now())`,
		workflowNodeAID, workflowDispatchTaskID, locked.Assignment.ID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx,
		`UPDATE task_workflow_nodes SET status='execution_failed' WHERE id=$1`, workflowNodeAID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx,
		`UPDATE task_workflow_runs SET status='failed' WHERE id=$1`, workflowRunID,
	); err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO escrow_intents(
		 task_id,chain_id,contract_address,task_key,payer_wallet,amount_minor,
		 released_amount_minor,status
		) VALUES ($1,31337,$2,$3,$4,10000000,0,'confirmed')`,
		workflowDispatchTaskID,
		"0x1111111111111111111111111111111111111111",
		"0x"+strings.Repeat("12", 32),
		"0xcccccccccccccccccccccccccccccccccccccccc",
	)
	if err != nil {
		t.Fatal(err)
	}

	first, err := service.RetryFailedWorkflowNodeExecution(
		ctx, workflowDispatchTaskID, workflowNodeAID, "publisher-workflow",
	)
	if err != nil || first.WorkflowNodeID != workflowNodeAID || first.Replayed {
		t.Fatalf("first workflow retry failed: result=%+v err=%v", first, err)
	}
	second, err := service.RetryFailedWorkflowNodeExecution(
		ctx, workflowDispatchTaskID, workflowNodeAID, "publisher-workflow",
	)
	if err != nil || !second.Replayed || second.TransitionEventID != first.TransitionEventID {
		t.Fatalf("workflow retry did not replay one event: first=%+v second=%+v err=%v", first, second, err)
	}

	var assignmentStatus, escrowStatus, nodeStatus string
	var eventCount int
	err = pool.QueryRow(ctx, `
		SELECT assignment.status,intent.status,node.status,
		       (SELECT count(*) FROM workflow_node_transition_outbox event
		         WHERE event.assignment_id=assignment.id AND event.event_type='assignment_failed')
		  FROM task_assignments assignment
		  JOIN escrow_intents intent ON intent.task_id=assignment.task_id
		  JOIN task_workflow_nodes node ON node.id=assignment.workflow_node_id
		 WHERE assignment.id=$1`, first.AssignmentID,
	).Scan(&assignmentStatus, &escrowStatus, &nodeStatus, &eventCount)
	if err != nil || assignmentStatus != "cancelled" || escrowStatus != "confirmed" ||
		nodeStatus != "execution_failed" || eventCount != 1 {
		t.Fatalf("workflow retry changed funds or duplicated recovery: assignment=%s escrow=%s node=%s events=%d err=%v",
			assignmentStatus, escrowStatus, nodeStatus, eventCount, err)
	}

	// 模拟 Business API 消费恢复事件后的权威状态迁移。匹配服务必须把被取消的旧
	// assignment 纳入新的派发身份；否则第一次派发的幂等记录会吞掉这次合法恢复。
	if _, err = pool.Exec(ctx,
		`UPDATE task_workflow_nodes SET status='matching' WHERE id=$1`, workflowNodeAID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx,
		`UPDATE task_workflow_runs SET status='running' WHERE id=$1`, workflowRunID,
	); err != nil {
		t.Fatal(err)
	}
	replacementQueue := &concurrentQueue{}
	coordinator := matching.InitialMatchCoordinator{
		Matcher: &matching.Service{Repository: &MatchingRepository{Pool: pool}, Now: time.Now},
		Dispatcher: &dispatch.Service{
			Repository: repository, Queue: replacementQueue, Now: time.Now,
		},
	}
	if _, err = coordinator.RunWorkflowNodeMatching(ctx, workflowDispatchTaskID, workflowNodeAID); err != nil {
		t.Fatal(err)
	}
	var assignmentCount int
	var replacementAssignmentID, replacementRequestID, replacementKey, distributionRecordID string
	err = pool.QueryRow(ctx, `
		SELECT (
		         SELECT count(*) FROM task_assignments counted
		          WHERE counted.workflow_node_id=$1
		       ),assignment.id::text,attempt.protocol_request_id,attempt.idempotency_key,
		       assignment.distribution_record_id::text
		  FROM task_assignments assignment
		  JOIN dispatch_attempts attempt ON attempt.assignment_id=assignment.id
		 WHERE assignment.workflow_node_id=$1
		 ORDER BY assignment.assigned_at DESC,assignment.id DESC
		 LIMIT 1`, workflowNodeAID,
	).Scan(&assignmentCount, &replacementAssignmentID, &replacementRequestID, &replacementKey, &distributionRecordID)
	wantKey := "dispatch:selected:" + workflowDispatchTaskID + ":" + workflowNodeAID +
		":" + distributionRecordID + ":replacement:" + first.AssignmentID
	if err != nil || assignmentCount != 2 || replacementKey != wantKey || replacementQueue.count() != 1 {
		t.Fatalf("workflow retry did not create exactly one replacement: count=%d key=%s queue=%d want=%s err=%v",
			assignmentCount, replacementKey, replacementQueue.count(), wantKey, err)
	}
	formalPayload, err := loadFormalDispatchPayload(
		ctx, pool, "http://127.0.0.1:3200", replacementAssignmentID,
		workflowDispatchTaskID, workflowDispatchAgent, workflowNodeAID, replacementRequestID, false,
	)
	if err != nil {
		t.Fatal(err)
	}
	var recoveryEnvelope struct {
		Workflow struct {
			RecoveryMode bool `json:"recoveryMode"`
		} `json:"workflow"`
	}
	if err = json.Unmarshal(formalPayload, &recoveryEnvelope); err != nil || !recoveryEnvelope.Workflow.RecoveryMode {
		t.Fatalf("replacement dispatch did not preserve failed-execution recovery mode: payload=%s err=%v",
			string(formalPayload), err)
	}
	replayed, err := service.ConfirmCandidate(ctx, dispatch.LockCommand{
		TaskID: workflowDispatchTaskID, WorkflowNodeID: workflowNodeAID,
		AgentID: workflowDispatchAgent, ActorID: "system:selected", IdempotencyKey: wantKey,
	})
	if err != nil || !replayed.Replayed || replacementQueue.count() != 1 {
		t.Fatalf("same replacement identity must replay without a second delivery: result=%+v queue=%d err=%v",
			replayed, replacementQueue.count(), err)
	}

	// 如果新 assignment 已接单，但初始化回调尚未把执行状态从旧 assignment 切换过来，
	// 说明这次恢复没有真正进入执行批次。此时应允许同一可审计入口再次恢复；普通已绑定
	// 当前 assignment 的 executing 节点仍必须拒绝，避免重复调用正在工作的 Agent。
	if _, err = service.Acknowledge(ctx, replacementAssignmentID, workflowDispatchAgent, true); err != nil {
		t.Fatal(err)
	}
	// 一旦新 assignment 上报自己的执行快照，恢复模式就必须结束。否则该节点未来的
	// 普通返工也会永久跳过分析与评审，把一次失败历史错误泄漏到所有后续执行。
	if _, err = pool.Exec(ctx, `
		UPDATE workflow_node_execution_state
		   SET assignment_id=$2,progress=10,execution_state='running',failure_code=NULL,updated_at=now()
		 WHERE workflow_node_id=$1`, workflowNodeAID, replacementAssignmentID,
	); err != nil {
		t.Fatal(err)
	}
	regularPayload, err := loadFormalDispatchPayload(
		ctx, pool, "http://127.0.0.1:3200", replacementAssignmentID,
		workflowDispatchTaskID, workflowDispatchAgent, workflowNodeAID, replacementRequestID, true,
	)
	if err != nil {
		t.Fatal(err)
	}
	var regularEnvelope struct {
		Workflow struct {
			RecoveryMode bool `json:"recoveryMode"`
		} `json:"workflow"`
	}
	if err = json.Unmarshal(regularPayload, &regularEnvelope); err != nil || regularEnvelope.Workflow.RecoveryMode {
		t.Fatalf("current execution snapshot did not end recovery mode: payload=%s err=%v",
			string(regularPayload), err)
	}
	// 恢复初始化卡死场景仍需让快照重新指向旧批次，以验证既有的再次恢复能力。
	if _, err = pool.Exec(ctx, `
		UPDATE workflow_node_execution_state
		   SET assignment_id=$2,progress=10,execution_state='failed',failure_code='MODEL_OUTPUT_INVALID',updated_at=now()
		 WHERE workflow_node_id=$1`, workflowNodeAID, first.AssignmentID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx,
		`UPDATE task_workflow_nodes SET status='executing' WHERE id=$1`, workflowNodeAID,
	); err != nil {
		t.Fatal(err)
	}
	stuckRetry, err := service.RetryFailedWorkflowNodeExecution(
		ctx, workflowDispatchTaskID, workflowNodeAID, "publisher-workflow",
	)
	if err != nil || stuckRetry.AssignmentID != replacementAssignmentID {
		t.Fatalf("stuck replacement execution was not recoverable: result=%+v err=%v", stuckRetry, err)
	}
}

func seedWorkflowDispatchFixtures(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	deadline := time.Now().UTC().Add(24 * time.Hour)
	_, err := pool.Exec(ctx, `
		INSERT INTO tasks (
		 id,publisher_id,title,description,acceptance_criteria,deliverable_format,
		 category_id,category_version,tag_names,pricing_type,budget_min_minor,
		 budget_max_minor,currency,deadline,required_capability,attachments,
		 visibility,status,assignment_mode_config,acceptance_mode,acceptor_config
		) VALUES (
		 $1,'publisher-workflow','正式多 Agent 派发测试','验证两个工作节点各自持有独立分配事实。',
		 '每个节点必须独立确认且事件不能进入旧 outbox。','工作流制品',$2,1,ARRAY['agent'],
		 'fixed',10000000,10000000,'USDC',$3,'正式节点派发','[]'::jsonb,
		 'public','matching','{"mode":"manual"}'::jsonb,'manual','{}'::jsonb
		)`, workflowDispatchTaskID, integrationCategory, deadline)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO agents (
		 id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,pricing_type,
		 price_amount,price_currency,service_endpoint,email,status,estimated_duration_seconds,response_minutes
		) VALUES ($1,'0xcccccccccccccccccccccccccccccccccccccccc','0xcccccccccccccccccccccccccccccccccccccccc','正式工作流 Agent',$2,
		 '执行节点工作',ARRAY['agent'],'fixed',3000000,'USDC','http://127.0.0.1:3999/agent',
		 'workflow@example.com','active',1800,1)`, workflowDispatchAgent, integrationCategory)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO task_workflow_runs (
		 id,task_id,status,total_budget_minor,refundable_amount_minor
		) VALUES ($1,$2,'running',10000000,10000000)`, workflowRunID, workflowDispatchTaskID)
	if err != nil {
		t.Fatal(err)
	}
	for index, nodeID := range []string{workflowNodeAID, workflowNodeBID} {
		_, err = pool.Exec(ctx, `
			INSERT INTO task_workflow_nodes (
			 id,workflow_run_id,task_id,node_key,kind,title,description,category_id,tags,
			 required_capability,input_contract,output_contract,budget_cap_minor,position_index,status
			) VALUES ($1,$2,$3,$4,'coding',$5,'执行一个可独立验收的工作节点。',$6,ARRAY['agent'],
			 '编码实现','TaskContract','CodeArtifact',4000000,$7,'matching')`,
			nodeID, workflowRunID, workflowDispatchTaskID, "node-"+string(rune('a'+index)),
			"工作节点 "+string(rune('A'+index)), integrationCategory, index)
		if err != nil {
			t.Fatal(err)
		}
		_, err = pool.Exec(ctx, `
			INSERT INTO job_distribution_records (
			 task_id,workflow_node_id,rule_version,input_fingerprint,input_snapshot,candidates,filter_reasons
			) VALUES ($1,$2,'ranking-v1',$3,'{"AssignmentMode":"manual"}'::jsonb,
			 jsonb_build_array(jsonb_build_object('agentId',$4::text,'quoteMinor','3000000')),
			 '{}'::jsonb)`, workflowDispatchTaskID, nodeID, "workflow-node-"+string(rune('a'+index)), workflowDispatchAgent)
		if err != nil {
			t.Fatal(err)
		}
	}
}

func cleanupWorkflowDispatchFixtures(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	statements := []string{
		`DELETE FROM webhook_deliveries WHERE task_event_id IN (SELECT id FROM task_events WHERE task_id='81200000-0000-4000-8000-000000000001')`,
		`DELETE FROM task_events WHERE task_id='81200000-0000-4000-8000-000000000001'`,
		`DELETE FROM workflow_node_transition_inbox WHERE task_id='81200000-0000-4000-8000-000000000001'`,
		`DELETE FROM workflow_node_transition_outbox WHERE task_id='81200000-0000-4000-8000-000000000001'`,
		`DELETE FROM workflow_node_execution_state WHERE task_id='81200000-0000-4000-8000-000000000001'`,
		`DELETE FROM dispatch_attempts WHERE assignment_id IN (SELECT id FROM task_assignments WHERE task_id='81200000-0000-4000-8000-000000000001')`,
		`DELETE FROM task_assignments WHERE task_id='81200000-0000-4000-8000-000000000001'`,
		`DELETE FROM job_distribution_records WHERE task_id='81200000-0000-4000-8000-000000000001'`,
		`DELETE FROM escrow_intents WHERE task_id='81200000-0000-4000-8000-000000000001'`,
		`DELETE FROM task_workflow_edges WHERE workflow_run_id='81200000-0000-4000-8000-000000000002'`,
		`DELETE FROM task_workflow_nodes WHERE task_id='81200000-0000-4000-8000-000000000001'`,
		`DELETE FROM task_workflow_runs WHERE task_id='81200000-0000-4000-8000-000000000001'`,
		`DELETE FROM agents WHERE id='81200000-0000-4000-8000-000000000005'`,
		`DELETE FROM tasks WHERE id='81200000-0000-4000-8000-000000000001'`,
	}
	for _, statement := range statements {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatalf("cleanup workflow dispatch fixture: %v", err)
		}
	}
}
