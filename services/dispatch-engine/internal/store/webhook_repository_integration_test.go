package store

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestWebhookRepositoryLeaseRetryAndDeadLetter(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL is required for PostgreSQL integration test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	const (
		taskID     = "86000000-0000-4000-8000-000000000001"
		agentID    = "86000000-0000-4000-8000-000000000002"
		deliveryID = "86000000-0000-4000-8000-000000000003"
	)
	cleanup := func() {
		_, _ = pool.Exec(ctx, "DELETE FROM audit_logs WHERE target_type='webhook_delivery' AND target_id=$1", deliveryID)
		_, _ = pool.Exec(ctx, "DELETE FROM webhook_deliveries WHERE id=$1", deliveryID)
		_, _ = pool.Exec(ctx, "DELETE FROM task_events WHERE task_id=$1", taskID)
		_, _ = pool.Exec(ctx, "DELETE FROM agent_credentials WHERE agent_id=$1", agentID)
		_, _ = pool.Exec(ctx, "DELETE FROM agents WHERE id=$1", agentID)
		_, _ = pool.Exec(ctx, "DELETE FROM tasks WHERE id=$1", taskID)
		_, _ = pool.Exec(ctx, `UPDATE notification_config
			SET max_webhook_attempts=5,base_retry_seconds=1,max_retry_seconds=300 WHERE id=TRUE`)
	}
	cleanup()
	defer cleanup()

	transaction, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	_, err = transaction.Exec(ctx, `
		INSERT INTO tasks(
		  id,publisher_id,title,description,category_id,category_version,acceptance_criteria,
		  deliverable_format,pricing_type,tag_names,visibility,budget_min_minor,budget_max_minor,
		  currency,deadline,required_capability,attachments,status,assignment_mode_config,
		  acceptance_mode,acceptor_config,status_version
		) VALUES (
		  $1,'publisher-webhook','Webhook 租约集成任务','验证租约、重试和死信告警。',
		  '40000000-0000-4000-8000-000000000001',1,'重复投递不会覆盖新租约。','测试报告',
		  'fixed',ARRAY['agent'],'private',8000000,8000000,'USDC',now()+interval '1 day','Go/PostgreSQL',
		  '[]'::jsonb,'executing','{"mode":"manual"}'::jsonb,'manual','{}'::jsonb,1
		)`, taskID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = transaction.Exec(ctx, `
		INSERT INTO agents(
		  id,provider_wallet_address,name,category_id,capability_desc,tags,pricing_type,
		  price_amount,price_currency,service_endpoint,email,status
		) VALUES (
		  $1,'0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','Webhook 测试 Agent',
		  '40000000-0000-4000-8000-000000000001','Go',ARRAY['agent'],'fixed',7000000,
		  'USDC','https://agent.example/v1','webhook@example.com','active'
		)`, agentID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = transaction.Exec(ctx, "INSERT INTO agent_credentials(agent_id,encrypted_secret) VALUES ($1,$2)", agentID, "local-dev:"+agentID)
	if err != nil {
		t.Fatal(err)
	}
	var eventID int64
	err = transaction.QueryRow(ctx, `
		INSERT INTO task_events(task_id,status_version,event_type,payload)
		VALUES ($1,1,'task.execution_progress','{"progress":40}'::jsonb) RETURNING id`, taskID).Scan(&eventID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = transaction.Exec(ctx, `
		INSERT INTO webhook_deliveries(
		  id,task_event_id,agent_id,endpoint,idempotency_key,status,next_attempt_at
		) VALUES ($1,$2,$3,'https://agent.example/v1/webhook','webhook:integration','pending',$4)`,
		deliveryID, eventID, agentID, time.Date(2026, 8, 23, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	_, err = transaction.Exec(ctx, "UPDATE notification_config SET max_webhook_attempts=2 WHERE id=TRUE")
	if err != nil {
		t.Fatal(err)
	}
	if err = transaction.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	repository := &WebhookRepository{Pool: pool}
	now := time.Date(2026, 8, 23, 1, 0, 0, 0, time.UTC)
	var initialTaskStatus string
	if err = pool.QueryRow(ctx, "SELECT status FROM tasks WHERE id=$1", taskID).Scan(&initialTaskStatus); err != nil {
		t.Fatal(err)
	}
	first, err := repository.ClaimDue(ctx, now, 30*time.Second, 10)
	if err != nil || len(first) != 1 {
		t.Fatalf("first claim mismatch: deliveries=%+v err=%v", first, err)
	}
	if first[0].LockToken == "" || first[0].EncryptedCredential != "local-dev:"+agentID {
		t.Fatalf("claim omitted lease or encrypted credential: %+v", first[0])
	}
	if err = repository.MarkDelivered(ctx, deliveryID, "86000000-0000-4000-8000-000000000099", now); !errors.Is(err, ErrWebhookLeaseLost) {
		t.Fatalf("stale worker should lose lease, got %v", err)
	}
	dead, err := repository.MarkFailure(ctx, deliveryID, first[0].LockToken, "CONN_TIMEOUT", true, now)
	if err != nil || dead {
		t.Fatalf("first retry should remain pending: dead=%v err=%v", dead, err)
	}

	second, err := repository.ClaimDue(ctx, now.Add(2*time.Second), 30*time.Second, 10)
	if err != nil || len(second) != 1 || second[0].LockToken == first[0].LockToken {
		t.Fatalf("retry claim should receive a new lease token: deliveries=%+v err=%v", second, err)
	}
	dead, err = repository.MarkFailure(ctx, deliveryID, second[0].LockToken, "CONN_TIMEOUT", true, now.Add(2*time.Second))
	if err != nil || !dead {
		t.Fatalf("second failure should create dead letter: dead=%v err=%v", dead, err)
	}
	var status string
	var attemptNo, alerts int
	err = pool.QueryRow(ctx, `
		SELECT delivery.status,delivery.attempt_no,
		       (SELECT count(*)::int FROM audit_logs
		         WHERE target_type='webhook_delivery' AND target_id=delivery.id::text)
		  FROM webhook_deliveries delivery WHERE delivery.id=$1`, deliveryID).Scan(&status, &attemptNo, &alerts)
	if err != nil || status != "dead_letter" || attemptNo != 2 || alerts != 1 {
		t.Fatalf("dead-letter evidence mismatch: status=%s attempts=%d alerts=%d err=%v", status, attemptNo, alerts, err)
	}
	var finalTaskStatus string
	if err = pool.QueryRow(ctx, "SELECT status FROM tasks WHERE id=$1", taskID).Scan(&finalTaskStatus); err != nil {
		t.Fatal(err)
	}
	if finalTaskStatus != initialTaskStatus || finalTaskStatus != "executing" {
		t.Fatalf("webhook failure changed business state: before=%s after=%s", initialTaskStatus, finalTaskStatus)
	}
}
