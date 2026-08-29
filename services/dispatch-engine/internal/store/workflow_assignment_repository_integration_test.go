package store

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	workflowDispatchTaskID = "81200000-0000-4000-8000-000000000001"
	workflowRunID          = "81200000-0000-4000-8000-000000000002"
	workflowNodeAID        = "81200000-0000-4000-8000-000000000003"
	workflowNodeBID        = "81200000-0000-4000-8000-000000000004"
	workflowDispatchAgent  = "81200000-0000-4000-8000-000000000005"
)

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
	first, err := service.ConfirmCandidate(ctx, dispatch.LockCommand{
		TaskID: workflowDispatchTaskID, WorkflowNodeID: workflowNodeAID,
		AgentID: workflowDispatchAgent, ActorID: "publisher-workflow",
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
		`DELETE FROM workflow_node_transition_inbox WHERE task_id='81200000-0000-4000-8000-000000000001'`,
		`DELETE FROM workflow_node_transition_outbox WHERE task_id='81200000-0000-4000-8000-000000000001'`,
		`DELETE FROM dispatch_attempts WHERE assignment_id IN (SELECT id FROM task_assignments WHERE task_id='81200000-0000-4000-8000-000000000001')`,
		`DELETE FROM task_assignments WHERE task_id='81200000-0000-4000-8000-000000000001'`,
		`DELETE FROM job_distribution_records WHERE task_id='81200000-0000-4000-8000-000000000001'`,
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
