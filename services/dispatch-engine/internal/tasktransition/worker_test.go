package tasktransition

import (
	"context"
	"testing"
	"time"
)

type fakeRepository struct {
	events    []Event
	delivered []string
	failed    []string
	terminal  bool
	retryAt   time.Time
}

func (r *fakeRepository) ClaimDue(context.Context, time.Time, time.Duration, int) ([]Event, error) {
	return r.events, nil
}
func (r *fakeRepository) MarkDelivered(_ context.Context, id string, _ time.Time) error {
	r.delivered = append(r.delivered, id)
	return nil
}
func (r *fakeRepository) MarkFailure(_ context.Context, id, code string, retryAt time.Time, terminal bool) error {
	r.failed = append(r.failed, id+":"+code)
	r.retryAt, r.terminal = retryAt, terminal
	return nil
}

type fakeSender struct{ failures map[string]error }

func (s fakeSender) Send(_ context.Context, event Event) error { return s.failures[event.ID] }

func TestWorkerMarksSuccessAndClassifiesPermanentFailure(t *testing.T) {
	now := time.Date(2026, 8, 23, 1, 2, 3, 0, time.UTC)
	repository := &fakeRepository{events: []Event{{ID: "ok"}, {ID: "bad", AttemptNo: 2}}}
	worker := Worker{
		Repository: repository,
		Sender: fakeSender{failures: map[string]error{
			"bad": &DeliveryError{Code: "EVENT_ID_REUSED", Retryable: false},
		}},
		Now: func() time.Time { return now },
	}
	count, err := worker.RunOnce(context.Background(), 10)
	if count != 2 || err == nil {
		t.Fatalf("unexpected result: count=%d err=%v", count, err)
	}
	if len(repository.delivered) != 1 || repository.delivered[0] != "ok" {
		t.Fatalf("successful event was not delivered: %+v", repository.delivered)
	}
	if len(repository.failed) != 1 || repository.failed[0] != "bad:EVENT_ID_REUSED" || !repository.terminal {
		t.Fatalf("permanent failure was not dead-lettered: failed=%+v terminal=%v", repository.failed, repository.terminal)
	}
}
