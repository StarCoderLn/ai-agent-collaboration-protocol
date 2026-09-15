package matchingv2

import (
	"context"
	"errors"
	"testing"
	"time"
)

type workerRepositoryFake struct {
	claim     Claim
	claimed   bool
	completed []Score
	failed    string
}

func (f *workerRepositoryFake) Claim(context.Context, time.Time, time.Duration) (Claim, bool, error) {
	return f.claim, f.claimed, nil
}
func (f *workerRepositoryFake) Complete(_ context.Context, _ Claim, scores []Score, _ time.Time) error {
	f.completed = scores
	return nil
}
func (f *workerRepositoryFake) Fail(_ context.Context, _ Claim, code string, _ time.Time) error {
	f.failed = code
	return nil
}

type workerScorerFake struct{ err error }

func (f workerScorerFake) Score(context.Context, Claim) ([]Score, error) {
	return []Score{{AgentID: "agent", PCTR: 0.5, PCVR: 0.4, PCTCVR: 0.2, ShadowRank: 1}}, f.err
}
func (workerScorerFake) FailureCode(error) string { return "MATCHING_V2_MODEL_UNAVAILABLE" }

// TestWorkerPersistsSuccessAndContainsModelFailure 同时证明成功走 Complete、模型失败走 Fail，
// 且两条路径都被限制在影子仓储，不向正式匹配返回模型异常。
func TestWorkerPersistsSuccessAndContainsModelFailure(t *testing.T) {
	repository := &workerRepositoryFake{claim: Claim{JobID: "job"}, claimed: true}
	worker := Worker{Repository: repository, Scorer: workerScorerFake{}}
	processed, err := worker.RunOnce(context.Background())
	if err != nil || !processed || len(repository.completed) != 1 || repository.failed != "" {
		t.Fatalf("successful shadow score was not persisted: repository=%+v err=%v", repository, err)
	}

	repository.completed = nil
	worker.Scorer = workerScorerFake{err: errors.New("model down")}
	processed, err = worker.RunOnce(context.Background())
	if err != nil || !processed || repository.failed != "MATCHING_V2_MODEL_UNAVAILABLE" {
		t.Fatalf("model failure escaped formal matching path: repository=%+v err=%v", repository, err)
	}
}
