package webhook

import (
	"context"
	"errors"
	"testing"
	"time"
)

type repositoryStub struct {
	deliveries []Delivery
	delivered  []string
	failures   []failureRecord
	deadLetter bool
}

type failureRecord struct {
	id, token, code string
	retryable       bool
}

func (r *repositoryStub) ClaimDue(_ context.Context, _ time.Time, _ time.Duration, _ int) ([]Delivery, error) {
	return r.deliveries, nil
}
func (r *repositoryStub) MarkDelivered(_ context.Context, id, token string, _ time.Time) error {
	r.delivered = append(r.delivered, id+":"+token)
	return nil
}
func (r *repositoryStub) MarkFailure(_ context.Context, id, token, code string, retryable bool, _ time.Time) (bool, error) {
	r.failures = append(r.failures, failureRecord{id: id, token: token, code: code, retryable: retryable})
	return r.deadLetter, nil
}

type decryptorStub struct{ err error }

func (d decryptorStub) DecryptCredential(_ context.Context, _ string) (string, error) {
	if d.err != nil {
		return "", d.err
	}
	return "0123456789abcdef", nil
}

type senderStub struct{ err error }

func (s senderStub) Send(_ context.Context, _ Delivery, _ string) error { return s.err }

func TestWorkerMarksDeliveredWithLeaseToken(t *testing.T) {
	repository := &repositoryStub{deliveries: []Delivery{{ID: "delivery-1", LockToken: "lease-1"}}}
	worker := &Worker{Repository: repository, Decryptor: decryptorStub{}, Sender: senderStub{}}
	result, err := worker.RunOnce(context.Background(), 10)
	if err != nil {
		t.Fatalf("RunOnce returned error: %v", err)
	}
	if result != (RunResult{Claimed: 1, Delivered: 1}) {
		t.Fatalf("unexpected result: %+v", result)
	}
	if len(repository.delivered) != 1 || repository.delivered[0] != "delivery-1:lease-1" {
		t.Fatalf("delivery completion did not preserve lease token: %#v", repository.delivered)
	}
}

func TestWorkerClassifiesTerminalFailureAndCountsDeadLetter(t *testing.T) {
	repository := &repositoryStub{
		deliveries: []Delivery{{ID: "delivery-2", LockToken: "lease-2"}},
		deadLetter: true,
	}
	worker := &Worker{
		Repository: repository,
		Decryptor:  decryptorStub{},
		Sender: senderStub{err: &DeliveryError{
			Code: "AGENT_WEBHOOK_ENDPOINT_INVALID", Retryable: false,
		}},
	}
	result, err := worker.RunOnce(context.Background(), 10)
	if err == nil {
		t.Fatal("RunOnce should surface the delivery failure for observability")
	}
	if result != (RunResult{Claimed: 1, DeadLetters: 1}) {
		t.Fatalf("unexpected result: %+v", result)
	}
	if len(repository.failures) != 1 || repository.failures[0].retryable ||
		repository.failures[0].code != "AGENT_WEBHOOK_ENDPOINT_INVALID" {
		t.Fatalf("failure classification was not preserved: %#v", repository.failures)
	}
}

func TestWorkerTreatsCredentialFailureAsRetryableWithoutCallingSender(t *testing.T) {
	repository := &repositoryStub{deliveries: []Delivery{{ID: "delivery-3", LockToken: "lease-3"}}}
	worker := &Worker{
		Repository: repository,
		Decryptor:  decryptorStub{err: errors.New("kms unavailable")},
		Sender:     senderStub{},
	}
	_, err := worker.RunOnce(context.Background(), 10)
	if err == nil {
		t.Fatal("RunOnce should expose the credential failure")
	}
	if len(repository.failures) != 1 || !repository.failures[0].retryable ||
		repository.failures[0].code != "AGENT_CREDENTIAL_UNAVAILABLE" {
		t.Fatalf("credential failure should be retryable: %#v", repository.failures)
	}
}
