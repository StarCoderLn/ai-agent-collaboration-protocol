package store

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/delivery"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/matching"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	dispatchTaskID   = "81000000-0000-4000-8000-000000000001"
	dispatchAgentAID = "81000000-0000-4000-8000-000000000002"
	dispatchAgentBID = "81000000-0000-4000-8000-000000000003"
	dispatchCategory = "81000000-0000-4000-8000-000000000004"
)

type concurrentQueue struct {
	mu       sync.Mutex
	messages []dispatch.DispatchMessage
}

type integrationDecryptor struct{}

func (integrationDecryptor) DecryptCredential(_ context.Context, encrypted string) (string, error) {
	return "decrypted:" + encrypted, nil
}

func (q *concurrentQueue) Send(_ context.Context, message dispatch.DispatchMessage) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.messages = append(q.messages, message)
	return nil
}

func (q *concurrentQueue) count() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.messages)
}

func TestAssignmentRepositoryPostgresConcurrencyIdempotencyAndRecovery(t *testing.T) {
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
	cleanupDispatchFixtures(t, ctx, pool)
	t.Cleanup(func() { cleanupDispatchFixtures(t, ctx, pool) })
	seedDispatchFixtures(t, ctx, pool)

	matcher := matching.Service{Repository: &MatchingRepository{Pool: pool}, Now: time.Now}
	record, err := matcher.RunMatching(ctx, dispatchTaskID)
	if err != nil || len(record.Candidates) != 2 {
		t.Fatalf("prepare candidates: record=%+v err=%v", record, err)
	}
	// 成交必须使用用户看到的冻结候选报价。匹配后 Agent 即使改价，也不能静默改变
	// 已展示候选的 agreed_amount_minor。
	if _, err = pool.Exec(ctx, `UPDATE agents SET price_amount=7500000 WHERE id IN ($1,$2)`, dispatchAgentAID, dispatchAgentBID); err != nil {
		t.Fatal(err)
	}
	repository := &AssignmentRepository{Pool: pool}
	queue := &concurrentQueue{}
	service := dispatch.Service{Repository: repository, Queue: queue, Now: time.Now}

	type outcome struct {
		result dispatch.LockResult
		err    error
	}
	outcomes := make(chan outcome, 2)
	var wait sync.WaitGroup
	for index, agentID := range []string{dispatchAgentAID, dispatchAgentBID} {
		wait.Add(1)
		go func(sequence int, candidateID string) {
			defer wait.Done()
			result, confirmErr := service.ConfirmCandidate(ctx, dispatch.LockCommand{
				TaskID: dispatchTaskID, AgentID: candidateID, ActorID: "publisher-dispatch",
				IdempotencyKey: "dispatch:task:" + string(rune('a'+sequence)),
			})
			outcomes <- outcome{result: result, err: confirmErr}
		}(index, agentID)
	}
	wait.Wait()
	close(outcomes)
	var winner dispatch.LockResult
	successes, conflicts := 0, 0
	for current := range outcomes {
		if current.err == nil {
			successes++
			winner = current.result
		} else if errors.Is(current.err, dispatch.ErrAssignmentAlreadyLocked) {
			conflicts++
		} else {
			t.Fatalf("unexpected concurrent error: %v", current.err)
		}
	}
	if successes != 1 || conflicts != 1 || queue.count() != 1 {
		t.Fatalf("expected one durable lock/send: successes=%d conflicts=%d queue=%d", successes, conflicts, queue.count())
	}
	if winner.Assignment.AgreedAmountMinor != 7000000 {
		t.Fatalf("assignment ignored frozen candidate quote: agreed=%d current-agent-price=7500000", winner.Assignment.AgreedAmountMinor)
	}
	deliveryRepository := &AgentDeliveryRepository{
		Pool: pool, Decryptor: integrationDecryptor{}, CallbackBaseURL: "http://dispatch.local",
	}
	target, err := deliveryRepository.LoadTarget(ctx, dispatch.DispatchMessage{
		AssignmentID: winner.Assignment.ID, TaskID: dispatchTaskID, AgentID: winner.Assignment.AgentID,
		AttemptID: winner.Attempt.ID, IdempotencyKey: winner.Attempt.IdempotencyKey,
		ProtocolRequestID: winner.Attempt.ProtocolRequestID,
	})
	if err != nil || target.Secret == "" || target.Endpoint == "" {
		t.Fatalf("dispatch target was not loaded: err=%v", err)
	}
	var payload struct {
		Task struct {
			BudgetMinMinor string `json:"budgetMinMinor"`
		} `json:"task"`
		Callbacks struct {
			Ack string `json:"ack"`
		} `json:"callbacks"`
	}
	if err = json.Unmarshal(target.Body, &payload); err != nil || payload.Task.BudgetMinMinor != "8000000" || payload.Callbacks.Ack == "" {
		t.Fatalf("dispatch payload lost exact money/callback data: err=%v", err)
	}

	// HTTP 投递失败使用 CASE 表达式，其 NULL 分支无法让 PostgreSQL 推断参数类型。这里运行
	// 真实仓储，确保缺少 timestamptz 类型转换时测试会失败，避免尝试一直卡在 `sent`，直到
	// 更晚的确认超时把原始错误掩盖。
	deliveryRetryAt := time.Now().UTC().Add(2 * time.Second)
	deadLetter, err := deliveryRepository.RecordFailure(ctx, winner.Attempt.ID, "AGENT_HTTP_503", deliveryRetryAt, false)
	if err != nil || deadLetter {
		t.Fatalf("retryable Agent delivery failure was not persisted: deadLetter=%v err=%v", deadLetter, err)
	}
	var failureStatus, failureCode string
	var failureAttemptNo int
	var persistedRetryAt time.Time
	err = pool.QueryRow(ctx, `
		SELECT status,attempt_no,error_code,next_attempt_at
		  FROM dispatch_attempts WHERE id=$1`, winner.Attempt.ID,
	).Scan(&failureStatus, &failureAttemptNo, &failureCode, &persistedRetryAt)
	if err != nil || failureStatus != "failed" || failureAttemptNo != winner.Attempt.AttemptNo+1 ||
		failureCode != "AGENT_HTTP_503" || !persistedRetryAt.Equal(deliveryRetryAt) {
		t.Fatalf("retryable delivery evidence mismatch: status=%s attempt=%d code=%s retryAt=%s err=%v",
			failureStatus, failureAttemptNo, failureCode, persistedRetryAt, err)
	}
	_, err = pool.Exec(ctx, `
		UPDATE dispatch_attempts
		   SET status='sent',attempt_no=$2,error_code=NULL,next_attempt_at=NULL
		 WHERE id=$1`, winner.Attempt.ID, winner.Attempt.AttemptNo)
	if err != nil {
		t.Fatal(err)
	}
	deadLetter, err = deliveryRepository.RecordFailure(ctx, winner.Attempt.ID, "AGENT_HTTP_400", deliveryRetryAt, true)
	if err != nil || !deadLetter {
		t.Fatalf("permanent Agent delivery failure was not dead-lettered: deadLetter=%v err=%v", deadLetter, err)
	}
	var terminalRetryAt *time.Time
	err = pool.QueryRow(ctx, `
		SELECT status,error_code,next_attempt_at
		  FROM dispatch_attempts WHERE id=$1`, winner.Attempt.ID,
	).Scan(&failureStatus, &failureCode, &terminalRetryAt)
	if err != nil || failureStatus != "dead_letter" || failureCode != "AGENT_HTTP_400" || terminalRetryAt != nil {
		t.Fatalf("permanent delivery evidence mismatch: status=%s code=%s retryAt=%v err=%v",
			failureStatus, failureCode, terminalRetryAt, err)
	}
	_, err = pool.Exec(ctx, `
		UPDATE dispatch_attempts
		   SET status='sent',attempt_no=$2,error_code=NULL,next_attempt_at=NULL
		 WHERE id=$1`, winner.Attempt.ID, winner.Attempt.AttemptNo)
	if err != nil {
		t.Fatal(err)
	}

	replay, err := service.ConfirmCandidate(ctx, dispatch.LockCommand{
		TaskID: dispatchTaskID, AgentID: winner.Assignment.AgentID, ActorID: "publisher-dispatch",
		IdempotencyKey: winner.Attempt.IdempotencyKey,
	})
	if err != nil || !replay.Replayed || replay.Assignment.ID != winner.Assignment.ID || queue.count() != 1 {
		t.Fatalf("idempotent replay failed: result=%+v queue=%d err=%v", replay, queue.count(), err)
	}

	// assignment_locked 送达业务状态机后，任务会处于 awaiting_agent_acceptance。
	// 拒单事实尚未被业务服务消费前，不得提前选择替代候选。
	if _, err = pool.Exec(ctx, `UPDATE tasks SET status='awaiting_agent_acceptance',status_version=status_version+1 WHERE id=$1`, dispatchTaskID); err != nil {
		t.Fatal(err)
	}
	rejected, err := service.Acknowledge(ctx, winner.Assignment.ID, winner.Assignment.AgentID, false)
	if err != nil || rejected.Status != domain.AssignmentAcceptFailed {
		t.Fatalf("reject assignment: assignment=%+v err=%v", rejected, err)
	}
	replacementID := dispatchAgentAID
	if winner.Assignment.AgentID == dispatchAgentAID {
		replacementID = dispatchAgentBID
	}
	_, err = service.ConfirmCandidate(ctx, dispatch.LockCommand{
		TaskID: dispatchTaskID, AgentID: replacementID, ActorID: "publisher-dispatch",
		IdempotencyKey: "dispatch:replacement:too-early",
	})
	if !errors.Is(err, dispatch.ErrCandidateNotFound) {
		t.Fatalf("replacement was allowed before task returned to matching: err=%v", err)
	}
	// 模拟 Marketplace API 原子消费 assignment_failed outbox 后的权威状态；此时原候选
	// 快照仍有效，发布者无需重跑匹配即可选另一个候选。
	if _, err = pool.Exec(ctx, `UPDATE tasks SET status='matching',status_version=status_version+1 WHERE id=$1`, dispatchTaskID); err != nil {
		t.Fatal(err)
	}
	replacement, err := service.ConfirmCandidate(ctx, dispatch.LockCommand{
		TaskID: dispatchTaskID, AgentID: replacementID, ActorID: "publisher-dispatch",
		IdempotencyKey: "dispatch:replacement:1",
	})
	if err != nil || replacement.Assignment.ID == winner.Assignment.ID {
		t.Fatalf("rejected candidate was not replaceable: result=%+v err=%v", replacement, err)
	}
	if _, err = pool.Exec(ctx, `UPDATE tasks SET status='awaiting_agent_acceptance',status_version=status_version+1 WHERE id=$1`, dispatchTaskID); err != nil {
		t.Fatal(err)
	}
	expired, err := repository.ExpireDue(ctx, replacement.Assignment.AcceptBy.Add(time.Second), 10)
	if err != nil || len(expired) != 1 || expired[0].ID != replacement.Assignment.ID {
		t.Fatalf("accept timeout not persisted: expired=%+v err=%v", expired, err)
	}
	var taskStatus string
	if err = pool.QueryRow(ctx, `SELECT status FROM tasks WHERE id=$1`, dispatchTaskID).Scan(&taskStatus); err != nil || taskStatus != "awaiting_agent_acceptance" {
		t.Fatalf("Go expiry bypassed the TypeScript task state machine: status=%s err=%v", taskStatus, err)
	}

	var assignments, attempts, transitions int
	err = pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM task_assignments WHERE task_id=$1),
		       (SELECT count(*) FROM dispatch_attempts attempt JOIN task_assignments assignment ON assignment.id=attempt.assignment_id WHERE assignment.task_id=$1),
		       (SELECT count(*) FROM task_transition_outbox WHERE task_id=$1)`, dispatchTaskID).Scan(&assignments, &attempts, &transitions)
	if err != nil || assignments != 2 || attempts != 2 || transitions != 4 {
		t.Fatalf("durable evidence mismatch: assignments=%d attempts=%d transitions=%d err=%v", assignments, attempts, transitions, err)
	}

	// 同一任务的状态事实必须严格按创建顺序投递；已领取事件在 lease 内也不能被第二个
	// worker 再次取得。失败后到达 next_attempt_at 才允许恢复。
	transitionRepository := &TaskTransitionRepository{Pool: pool}
	// 共享验收库可能同时运行正式 outbox worker。把 fixture 的现实到期时间推迟一小时，
	// 再用测试逻辑时钟推进两小时；正式 worker 永远看不到到期事件，断言也无需降级。
	realNow := time.Now().UTC()
	if _, err = pool.Exec(ctx, `
		UPDATE task_transition_outbox
		   SET status='pending',attempt_no=0,next_attempt_at=$2,locked_until=NULL,
		       last_error_code=NULL,delivered_at=NULL
		 WHERE task_id=$1`, dispatchTaskID, realNow.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	claimAt := realNow.Add(2 * time.Hour)
	claimed, err := transitionRepository.ClaimDue(ctx, claimAt, 30*time.Second, 10)
	if err != nil || len(claimed) != 1 || claimed[0].EventType != "assignment_locked" {
		t.Fatalf("first transition claim mismatch: events=%+v err=%v", claimed, err)
	}
	claimedDuringLease, err := transitionRepository.ClaimDue(ctx, claimAt.Add(time.Second), 30*time.Second, 10)
	if err != nil || len(claimedDuringLease) != 0 {
		t.Fatalf("leased transition was claimed twice: events=%+v err=%v", claimedDuringLease, err)
	}
	retryAt := claimAt.Add(5 * time.Second)
	if err = transitionRepository.MarkFailure(ctx, claimed[0].ID, "TRANSITION_NOT_READY", retryAt, false); err != nil {
		t.Fatal(err)
	}
	claimedBeforeRetry, err := transitionRepository.ClaimDue(ctx, retryAt.Add(-time.Millisecond), 30*time.Second, 10)
	if err != nil || len(claimedBeforeRetry) != 0 {
		t.Fatalf("transition retried before due time: events=%+v err=%v", claimedBeforeRetry, err)
	}
	claimed, err = transitionRepository.ClaimDue(ctx, retryAt, 30*time.Second, 10)
	if err != nil || len(claimed) != 1 {
		t.Fatalf("due transition was not reclaimed: events=%+v err=%v", claimed, err)
	}
	if err = transitionRepository.MarkDelivered(ctx, claimed[0].ID, retryAt); err != nil {
		t.Fatal(err)
	}
	next, err := transitionRepository.ClaimDue(ctx, retryAt, 30*time.Second, 10)
	if err != nil || len(next) != 1 || next[0].EventType != "assignment_failed" {
		t.Fatalf("later task event skipped ordering gate: events=%+v err=%v", next, err)
	}
}

func TestAgentDeliveryRepositoryPersistsAndRecoversQuickHTTPResult(t *testing.T) {
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
	cleanupDispatchFixtures(t, ctx, pool)
	t.Cleanup(func() { cleanupDispatchFixtures(t, ctx, pool) })
	seedDispatchFixtures(t, ctx, pool)

	// 快速 HTTP Agent 可以是公开端点：持久化模式是 http_json，凭证行缺失时仓储
	// 必须返回空 secret，而不是把公开 Agent 误判为配置损坏。
	if _, err = pool.Exec(ctx, `UPDATE agents SET integration_mode='http_json' WHERE id=$1`, dispatchAgentAID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `DELETE FROM agent_credentials WHERE agent_id=$1`, dispatchAgentAID); err != nil {
		t.Fatal(err)
	}
	matcher := matching.Service{Repository: &MatchingRepository{Pool: pool}, Now: time.Now}
	record, err := matcher.RunMatching(ctx, dispatchTaskID)
	if err != nil || len(record.Candidates) != 2 {
		t.Fatalf("prepare quick candidate: record=%+v err=%v", record, err)
	}
	dispatcher := dispatch.Service{
		Repository: &AssignmentRepository{Pool: pool}, Queue: &concurrentQueue{}, Now: time.Now,
	}
	locked, err := dispatcher.ConfirmCandidate(ctx, dispatch.LockCommand{
		TaskID: dispatchTaskID, AgentID: dispatchAgentAID, ActorID: "publisher-dispatch",
		IdempotencyKey: "dispatch:quick-result",
	})
	if err != nil {
		t.Fatal(err)
	}
	repository := &AgentDeliveryRepository{
		Pool: pool, Decryptor: integrationDecryptor{}, CallbackBaseURL: "http://dispatch.local",
	}
	message := dispatch.DispatchMessage{
		AssignmentID: locked.Assignment.ID, TaskID: dispatchTaskID, AgentID: dispatchAgentAID,
		AttemptID: locked.Attempt.ID, ProtocolRequestID: locked.Attempt.ProtocolRequestID,
	}
	target, err := repository.LoadTarget(ctx, message)
	if err != nil || target.IntegrationMode != "http_json" || target.Secret != "" || len(target.Body) == 0 {
		t.Fatalf("quick HTTP target mismatch: target=%+v err=%v", target, err)
	}

	quickResult := []byte(`{"agentId":"81000000-0000-4000-8000-000000000002","assignmentId":"` + locked.Assignment.ID + `","results":[{"kind":"inline","summary":"result","mimeType":"text/plain","generatedAt":"2026-09-03T00:00:00Z","content":"done"}]}`)
	if err = repository.StoreQuickResult(ctx, locked.Attempt.ID, quickResult); err != nil {
		t.Fatal(err)
	}
	// 模拟“结果已保存、接单已确认，但 Marketplace API 结果转交尚未成功”的崩溃窗口。
	// LoadTarget 必须绕过 assignment/attempt 终态并取回快照，而且不再重建派发正文。
	if _, err = pool.Exec(ctx, `UPDATE task_assignments SET status='accepted' WHERE id=$1`, locked.Assignment.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE dispatch_attempts SET status='accepted' WHERE id=$1`, locked.Attempt.ID); err != nil {
		t.Fatal(err)
	}
	recovered, err := repository.LoadTarget(ctx, message)
	var expectedResult, recoveredResult any
	expectedJSONErr := json.Unmarshal(quickResult, &expectedResult)
	recoveredJSONErr := json.Unmarshal(recovered.StoredQuickResult, &recoveredResult)
	if err != nil || expectedJSONErr != nil || recoveredJSONErr != nil ||
		!reflect.DeepEqual(recoveredResult, expectedResult) || len(recovered.Body) != 0 {
		t.Fatalf("persisted quick result was not recoverable: target=%+v err=%v", recovered, err)
	}
	if err = repository.MarkQuickResultDelivered(ctx, locked.Attempt.ID, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if _, err = repository.LoadTarget(ctx, message); !errors.Is(err, delivery.ErrDeliveryAlreadyFinal) {
		t.Fatalf("delivered quick result must become final: %v", err)
	}
}

func seedDispatchFixtures(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	deadline := time.Now().UTC().Add(2 * time.Hour)
	// 专用分类让集成测试不受开发数据库里其它 active Agent 数量影响；仅使用独特标签
	// 仍不够，因为匹配规则会保留同分类但标签未命中的低分候选。
	_, err := pool.Exec(ctx, `
		INSERT INTO categories(id,name,slug,version)
		VALUES ($1,'派发集成测试','dispatch-integration-fixture',1)`, dispatchCategory)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO tasks (
		 id, publisher_id, title, description, acceptance_criteria, deliverable_format,
		 category_id, category_version, tag_names, pricing_type, budget_min_minor,
		 budget_max_minor, currency, deadline, required_capability, attachments,
		 visibility, status, assignment_mode_config, acceptance_mode, acceptor_config
		) VALUES (
		 $1,'publisher-dispatch','并发候选确认集成任务','验证多个候选同时确认时只有一个数据库锁成功。',
		 '拒单和超时后都可以选择另一个候选。','Go 测试',$2,1,ARRAY['dispatch-integration-fixture'],
		 'fixed',8000000,8000000,'USDC',$3,'Go 并发与 PostgreSQL','[]'::jsonb,
		 'public','matching','{"mode":"manual"}'::jsonb,'manual','{}'::jsonb
		)`, dispatchTaskID, dispatchCategory, deadline)
	if err != nil {
		t.Fatal(err)
	}
	for _, values := range []struct{ id, name, wallet string }{
		{dispatchAgentAID, "候选 A", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
		{dispatchAgentBID, "候选 B", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
	} {
		_, err = pool.Exec(ctx, `
			INSERT INTO agents (
			 id, provider_wallet_address, payout_wallet_address, name, category_id, capability_desc, tags,
			 pricing_type, price_amount, price_currency, service_endpoint, email, status,
			 estimated_duration_seconds, response_minutes
			) VALUES ($1,$2,$2,$3,$4,'Go API',ARRAY['dispatch-integration-fixture'],'fixed',7000000,'USDC',
			 'http://127.0.0.1:3999/agent','dispatch@example.com','active',1800,1)`,
			values.id, values.wallet, values.name, dispatchCategory)
		if err != nil {
			t.Fatal(err)
		}
		_, err = pool.Exec(ctx, `
			INSERT INTO agent_credentials(agent_id, encrypted_secret)
			VALUES ($1,$2)`, values.id, "ciphertext-"+values.id)
		if err != nil {
			t.Fatal(err)
		}
	}
}

func cleanupDispatchFixtures(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	statements := []string{
		`DELETE FROM task_transition_outbox WHERE task_id='81000000-0000-4000-8000-000000000001'`,
		`DELETE FROM dispatch_attempts WHERE assignment_id IN (SELECT id FROM task_assignments WHERE task_id='81000000-0000-4000-8000-000000000001')`,
		`DELETE FROM task_assignments WHERE task_id='81000000-0000-4000-8000-000000000001'`,
		`DELETE FROM job_distribution_records WHERE task_id='81000000-0000-4000-8000-000000000001'`,
		`DELETE FROM agents WHERE id IN ('81000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000003')`,
		`DELETE FROM tasks WHERE id='81000000-0000-4000-8000-000000000001'`,
		`DELETE FROM categories WHERE id='81000000-0000-4000-8000-000000000004'`,
	}
	for _, statement := range statements {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatalf("cleanup dispatch fixture: %v", err)
		}
	}
}
