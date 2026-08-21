package protocol

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeIdempotencyPruner struct {
	calledWith time.Time
	callCount  int
	deleted    int
	err        error
}

func (f *fakeIdempotencyPruner) DeleteExpiredIdempotencyRecords(_ context.Context, before time.Time) (int, error) {
	f.calledWith = before
	f.callCount++
	return f.deleted, f.err
}

type fakeNoncePruner struct {
	calledWith time.Time
	callCount  int
	deleted    int
	err        error
}

func (f *fakeNoncePruner) DeleteExpiredNonces(_ context.Context, before time.Time) (int, error) {
	f.calledWith = before
	f.callCount++
	return f.deleted, f.err
}

func TestCleanupExpiredIdempotencyRecords_UsesCurrentTimeAsCutoff(t *testing.T) {
	fixedNow := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	pruner := &fakeIdempotencyPruner{deleted: 3}
	c := &Cleanup{
		Idempotency: pruner,
		Now:         func() time.Time { return fixedNow },
	}

	deleted, err := c.CleanupExpiredIdempotencyRecords(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if deleted != 3 {
		t.Fatalf("deleted = %d, want 3", deleted)
	}
	if !pruner.calledWith.Equal(fixedNow) {
		t.Fatalf("cutoff = %v, want %v (must delete records expired as of now, not some other reference time)", pruner.calledWith, fixedNow)
	}
}

func TestCleanupExpiredIdempotencyRecords_PropagatesStoreError(t *testing.T) {
	wantErr := errors.New("db unavailable")
	pruner := &fakeIdempotencyPruner{err: wantErr}
	c := &Cleanup{Idempotency: pruner, Now: func() time.Time { return time.Now() }}

	_, err := c.CleanupExpiredIdempotencyRecords(context.Background())
	if !errors.Is(err, wantErr) {
		t.Fatalf("err = %v, want %v", err, wantErr)
	}
}

func TestCleanupExpiredNonces_DefaultRetentionIs24Hours(t *testing.T) {
	fixedNow := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	pruner := &fakeNoncePruner{deleted: 5}
	c := &Cleanup{
		Nonces: pruner,
		Now:    func() time.Time { return fixedNow },
	}

	deleted, err := c.CleanupExpiredNonces(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if deleted != 5 {
		t.Fatalf("deleted = %d, want 5", deleted)
	}
	wantCutoff := fixedNow.Add(-24 * time.Hour)
	if !pruner.calledWith.Equal(wantCutoff) {
		t.Fatalf("cutoff = %v, want %v (default retention must be 24h, decoupled from the ±5min signature time window)", pruner.calledWith, wantCutoff)
	}
}

func TestCleanupExpiredNonces_CustomRetentionOverridesDefault(t *testing.T) {
	fixedNow := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	pruner := &fakeNoncePruner{}
	c := &Cleanup{
		Nonces:         pruner,
		NonceRetention: 2 * time.Hour,
		Now:            func() time.Time { return fixedNow },
	}

	if _, err := c.CleanupExpiredNonces(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	wantCutoff := fixedNow.Add(-2 * time.Hour)
	if !pruner.calledWith.Equal(wantCutoff) {
		t.Fatalf("cutoff = %v, want %v", pruner.calledWith, wantCutoff)
	}
}

func TestCleanupExpiredNonces_PropagatesStoreError(t *testing.T) {
	wantErr := errors.New("db unavailable")
	pruner := &fakeNoncePruner{err: wantErr}
	c := &Cleanup{Nonces: pruner, Now: func() time.Time { return time.Now() }}

	_, err := c.CleanupExpiredNonces(context.Background())
	if !errors.Is(err, wantErr) {
		t.Fatalf("err = %v, want %v", err, wantErr)
	}
}

// TestCleanup_RepeatedCallsAreIdempotent 验证「重复执行不报错、且第二次调用
// 在没有新过期数据时删除数量为 0」——这是 AC-007 对清理任务本身要求的幂等性。
// 真正的幂等保证来自底层 DELETE 语句本身（批量删除天然幂等，见 cleanup.go
// 文档），这里用一个会"消耗"自己数据的 fake 模拟真实存储的行为，验证
// Cleanup 不会在数据已清空后的第二次调用上出错或产生非预期行为。
func TestCleanup_RepeatedCallsAreIdempotent(t *testing.T) {
	remaining := 2
	pruner := &fakeIdempotencyPrunerStateful{remaining: &remaining}
	c := &Cleanup{Idempotency: pruner, Now: func() time.Time { return time.Now() }}

	first, err := c.CleanupExpiredIdempotencyRecords(context.Background())
	if err != nil {
		t.Fatalf("first call: unexpected error: %v", err)
	}
	if first != 2 {
		t.Fatalf("first call deleted = %d, want 2", first)
	}

	second, err := c.CleanupExpiredIdempotencyRecords(context.Background())
	if err != nil {
		t.Fatalf("second call: unexpected error: %v", err)
	}
	if second != 0 {
		t.Fatalf("second call deleted = %d, want 0 (nothing left to expire, must not error or re-delete)", second)
	}
}

type fakeIdempotencyPrunerStateful struct {
	remaining *int
}

func (f *fakeIdempotencyPrunerStateful) DeleteExpiredIdempotencyRecords(_ context.Context, _ time.Time) (int, error) {
	deleted := *f.remaining
	*f.remaining = 0
	return deleted, nil
}
