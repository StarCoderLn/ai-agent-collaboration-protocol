package protocol

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"
)

// fakeIdempotencyStore 是 IdempotencyStore 的测试替身，用内存 map 模拟
// idempotency_records 表 `idempotency_key` 主键的唯一约束与
// pending → committed 的状态迁移，仅供单元测试使用，不代表生产实现
// （生产实现基于 T-004 已建表）。
type fakeIdempotencyStore struct {
	mu      sync.Mutex
	records map[string]*StoredRecord
	// reservedCallTypes 记录每个 key 在 Reserve 时收到的 callType 参数，供测试
	// 断言调用方（Idempotency.CheckAndReserve）确实把归一化后的沙箱标记透传给了
	// 存储层（design.md 模块 4：写入时透传该标记）。
	reservedCallTypes map[string]CallType
	reserveErr        error
	commitErr         error
}

func newFakeIdempotencyStore() *fakeIdempotencyStore {
	return &fakeIdempotencyStore{records: map[string]*StoredRecord{}, reservedCallTypes: map[string]CallType{}}
}

func (f *fakeIdempotencyStore) Reserve(_ context.Context, key, _ string, callType CallType, _ time.Time) (StoredRecord, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.reserveErr != nil {
		return StoredRecord{}, false, f.reserveErr
	}

	if existing, ok := f.records[key]; ok {
		return *existing, false, nil
	}

	f.reservedCallTypes[key] = callType
	f.records[key] = &StoredRecord{Committed: false}
	return StoredRecord{}, true, nil
}

func (f *fakeIdempotencyStore) CommitResponse(_ context.Context, key string, snapshot ResponseSnapshot) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.commitErr != nil {
		return f.commitErr
	}

	record, ok := f.records[key]
	if !ok {
		return ErrIdempotencyKeyMissing
	}
	record.Committed = true
	record.Snapshot = snapshot
	return nil
}

func newTestIdempotency(fixedNow time.Time) (*Idempotency, *fakeIdempotencyStore) {
	store := newFakeIdempotencyStore()
	r := &Idempotency{
		Store: store,
		Now:   func() time.Time { return fixedNow },
	}
	return r, store
}

func TestCheckAndReserve_NewKeyIsReserved(t *testing.T) {
	r, _ := newTestIdempotency(time.Unix(1_700_000_000, 0))

	existing, reserved, err := r.CheckAndReserve(context.Background(), "create-task:task-1:client-1", "create_task", CallTypeProduction)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !reserved {
		t.Fatal("expected new key to be reserved")
	}
	if existing != nil {
		t.Fatalf("expected no existing snapshot for new key, got %+v", existing)
	}
}

func TestCheckAndReserve_CommittedKeyReturnsExistingSnapshot(t *testing.T) {
	r, _ := newTestIdempotency(time.Unix(1_700_000_000, 0))
	key := "create-task:task-1:client-1"
	ctx := context.Background()

	if _, reserved, err := r.CheckAndReserve(ctx, key, "create_task", CallTypeProduction); err != nil || !reserved {
		t.Fatalf("expected first CheckAndReserve to reserve, got reserved=%v err=%v", reserved, err)
	}

	snapshot := ResponseSnapshot{StatusCode: 201, Body: json.RawMessage(`{"task_id":"task-1"}`)}
	if err := r.Commit(ctx, key, snapshot); err != nil {
		t.Fatalf("Commit failed: %v", err)
	}

	existing, reserved, err := r.CheckAndReserve(ctx, key, "create_task", CallTypeProduction)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if reserved {
		t.Fatal("expected already-committed key not to be reserved again")
	}
	if existing == nil {
		t.Fatal("expected existing snapshot to be returned")
	}
	if existing.StatusCode != 201 || string(existing.Body) != `{"task_id":"task-1"}` {
		t.Fatalf("unexpected existing snapshot: %+v", existing)
	}
}

func TestCheckAndReserve_PendingKeyIsNotReservedAndHasNoSnapshot(t *testing.T) {
	// 模拟并发请求：第一次 CheckAndReserve 占用 key 后，业务逻辑尚未 Commit，
	// 第二次并发请求命中同一个 key 时既不能重新执行业务逻辑，也不能把「还没有
	// 的响应」当作历史快照返回。
	r, _ := newTestIdempotency(time.Unix(1_700_000_000, 0))
	key := "create-task:task-1:client-1"
	ctx := context.Background()

	if _, reserved, err := r.CheckAndReserve(ctx, key, "create_task", CallTypeProduction); err != nil || !reserved {
		t.Fatalf("expected first CheckAndReserve to reserve, got reserved=%v err=%v", reserved, err)
	}

	existing, reserved, err := r.CheckAndReserve(ctx, key, "create_task", CallTypeProduction)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if reserved {
		t.Fatal("expected pending key not to be reserved again")
	}
	if existing != nil {
		t.Fatalf("expected no snapshot for still-pending key, got %+v", existing)
	}
}

func TestCommit_UnreservedKeyReturnsError(t *testing.T) {
	r, _ := newTestIdempotency(time.Unix(1_700_000_000, 0))

	err := r.Commit(context.Background(), "never-reserved", ResponseSnapshot{StatusCode: 200})
	if err == nil {
		t.Fatal("expected error when committing an unreserved key")
	}
}

func TestCheckAndReserve_EmptyKeyOrOperationTypeRejected(t *testing.T) {
	r, _ := newTestIdempotency(time.Unix(1_700_000_000, 0))
	ctx := context.Background()

	if _, _, err := r.CheckAndReserve(ctx, "", "create_task", CallTypeProduction); err == nil {
		t.Fatal("expected error for empty key")
	}
	if _, _, err := r.CheckAndReserve(ctx, "key", "", CallTypeProduction); err == nil {
		t.Fatal("expected error for empty operationType")
	}
}

func TestCheckAndReserve_StoreErrorPropagates(t *testing.T) {
	r, store := newTestIdempotency(time.Unix(1_700_000_000, 0))
	store.reserveErr = context.DeadlineExceeded

	_, _, err := r.CheckAndReserve(context.Background(), "key", "create_task", CallTypeProduction)
	if err == nil {
		t.Fatal("expected store error to propagate")
	}
}

func TestCheckAndReserve_CallTypeIsPassedThroughToStore(t *testing.T) {
	// design.md 模块 4：Reserve 插入新记录时必须把归一化后的 call_type 透传给
	// 存储层，否则沙箱调用无法在下游审计/统计中被正确排除（AC-006）。
	r, store := newTestIdempotency(time.Unix(1_700_000_000, 0))
	ctx := context.Background()

	if _, reserved, err := r.CheckAndReserve(ctx, "key-sandbox", "create_task", CallTypeSandbox); err != nil || !reserved {
		t.Fatalf("expected key to be reserved, got reserved=%v err=%v", reserved, err)
	}
	if got := store.reservedCallTypes["key-sandbox"]; got != CallTypeSandbox {
		t.Fatalf("expected store to receive call type %q, got %q", CallTypeSandbox, got)
	}

	// 未声明 call_type（空字符串）时必须按 CallTypeProduction 归一化后再透传
	// 给存储层，不得原样写入空字符串（design.md「默认值为 production」）。
	if _, reserved, err := r.CheckAndReserve(ctx, "key-default", "create_task", ""); err != nil || !reserved {
		t.Fatalf("expected key to be reserved, got reserved=%v err=%v", reserved, err)
	}
	if got := store.reservedCallTypes["key-default"]; got != CallTypeProduction {
		t.Fatalf("expected store to receive default call type %q, got %q", CallTypeProduction, got)
	}
}

func TestCheckAndReserve_InvalidCallTypeRejected(t *testing.T) {
	r, _ := newTestIdempotency(time.Unix(1_700_000_000, 0))

	if _, _, err := r.CheckAndReserve(context.Background(), "key", "create_task", CallType("bogus")); err == nil {
		t.Fatal("expected error for invalid call type")
	}
}

func TestCheckAndReserve_TTLDefaultsWhenUnset(t *testing.T) {
	r := &Idempotency{Store: newFakeIdempotencyStore()}
	if got := r.ttl(); got != defaultIdempotencyTTL {
		t.Fatalf("expected default TTL %v, got %v", defaultIdempotencyTTL, got)
	}
}
