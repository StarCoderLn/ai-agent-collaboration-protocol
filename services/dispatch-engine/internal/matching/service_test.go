package matching

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
)

type memoryRepository struct {
	input   MatchInput
	records []Record
}

type semanticRetrieverFake struct {
	result SemanticResult
	err    error
	calls  int
	seen   []domain.AgentCandidate
}

func (f *semanticRetrieverFake) Descriptor() SemanticDescriptor {
	return SemanticDescriptor{Version: "semantic-v1", Model: "text-embedding-3-small", Dimensions: 1536, TopK: 1}
}
func (f *semanticRetrieverFake) Retrieve(_ context.Context, _ domain.MatchTask, agents []domain.AgentCandidate) (SemanticResult, error) {
	f.calls++
	f.seen = append([]domain.AgentCandidate(nil), agents...)
	return f.result, f.err
}
func (f *semanticRetrieverFake) FailureKind(error) string { return "embedding_unavailable" }

func (r *memoryRepository) LoadInput(context.Context, string) (MatchInput, error) {
	return r.input, nil
}
func (r *memoryRepository) FindByFingerprint(_ context.Context, taskID, fingerprint string) (Record, error) {
	for _, record := range r.records {
		if record.TaskID == taskID && record.InputFingerprint == fingerprint {
			return record, nil
		}
	}
	return Record{}, ErrRecordNotFound
}
func (r *memoryRepository) Save(_ context.Context, record Record) (Record, error) {
	record.ID = "record-" + time.Now().Format("150405.000000000")
	record.CreatedAt = time.Now()
	r.records = append(r.records, record)
	return record, nil
}
func (r *memoryRepository) Latest(_ context.Context, taskID string) (Record, error) {
	for index := len(r.records) - 1; index >= 0; index-- {
		if r.records[index].TaskID == taskID {
			return r.records[index], nil
		}
	}
	return Record{}, ErrRecordNotFound
}

func TestRunMatchingPersistsCompleteCandidateEvidenceAndReplaysSameFingerprint(t *testing.T) {
	now := time.Date(2026, 8, 23, 0, 0, 0, 0, time.UTC)
	repository := &memoryRepository{input: MatchInput{
		Task:          domain.MatchTask{ID: "task-1", CategoryID: "code", Tags: []string{"API", "Go"}, BudgetMinor: 10_000, Deadline: now.Add(time.Hour)},
		TaskUpdatedAt: now,
		Agents: []domain.AgentCandidate{{
			ID: "agent-1", Name: "Go 工程师", CategoryID: "code", Tags: []string{"Go", "API"},
			State: domain.AgentState{Status: domain.AgentActive}, PriceMinor: 8_000, Score: 4.8,
			Completed: 42, EstimatedDuration: 30 * time.Minute, ResponseMinutes: 2,
			RatingSampleSize: 30, PriorWeight: 20,
			ProbationCompletedTaskThreshold: 3, ProbationBudgetCapMinor: 5_000,
		}},
		Rules: domain.RankingRules{Version: "ranking-v1", TagMatchWeight: 30, QualityWeight: 30, PriceWeight: 15, ResponseSpeedWeight: 10, LoadWeight: 5, CompletedWeight: 10},
	}}
	service := Service{Repository: repository, Now: func() time.Time { return now }}

	first, err := service.RunMatching(context.Background(), "task-1")
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.RunMatching(context.Background(), "task-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(repository.records) != 1 || first.ID != second.ID {
		t.Fatalf("same snapshot must replay one record: records=%d first=%+v second=%+v", len(repository.records), first, second)
	}
	if len(first.Candidates) != 1 {
		t.Fatalf("expected one candidate, got %+v", first.Candidates)
	}
	candidate := first.Candidates[0]
	if candidate.AgentID != "agent-1" || candidate.Name != "Go 工程师" || candidate.QuoteMinor != "8000" ||
		candidate.EstimatedDurationSecond != 1_800 || candidate.Score != 4.8 || candidate.Completed != 42 ||
		candidate.RankScore == "" || candidate.IsNew || candidate.DeliveryCases == nil {
		t.Fatalf("candidate evidence incomplete: %+v", candidate)
	}
	if len(first.InputSnapshot) == 0 || first.RuleVersion != "ranking-v1" || first.InputFingerprint == "" {
		t.Fatalf("record lacks replay evidence: %+v", first)
	}
}

func TestCandidateViewsKeepsEmptyTagEvidenceAsJSONArrays(t *testing.T) {
	views := candidateViews([]domain.RankedCandidate{{
		Agent: domain.AgentCandidate{ID: "agent-without-tag-evidence"},
	}}, nil)
	if len(views) != 1 {
		t.Fatalf("expected one candidate view, got %d", len(views))
	}
	// 空标签是合法的“没有匹配证据”，API 必须以 [] 表达；nil 会被 JSON 编码为
	// null，导致严格的浏览器契约拒绝整份工作流响应。
	if views[0].MatchedTags == nil || views[0].UnmatchedTags == nil {
		t.Fatalf("empty tag evidence must remain arrays: %+v", views[0])
	}
}

func TestSemanticMatchingRunsAfterHardConstraintsAndReplaysSuccessfulSnapshot(t *testing.T) {
	now := time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC)
	repository := &memoryRepository{input: MatchInput{
		Task: domain.MatchTask{ID: "task", CategoryID: "code", Tags: []string{"go"}, Description: "实现并发服务", Currency: "USDC", Deadline: now.Add(time.Hour)},
		Agents: []domain.AgentCandidate{
			{ID: "eligible-a", CategoryID: "code", Tags: []string{"go"}, CapabilityDescription: "Go 服务", State: domain.AgentState{Status: domain.AgentActive}, Currency: "USDC", EstimatedDuration: time.Minute},
			{ID: "eligible-b", CategoryID: "code", Tags: []string{"rust"}, CapabilityDescription: "系统开发", State: domain.AgentState{Status: domain.AgentActive}, Currency: "USDC", EstimatedDuration: time.Minute},
			{ID: "inactive", CategoryID: "code", State: domain.AgentState{Status: domain.AgentPaused}, Currency: "USDC", EstimatedDuration: time.Minute},
		},
		Rules: domain.RankingRules{Version: "ranking-v1", TagMatchWeight: 1},
	}}
	retriever := &semanticRetrieverFake{result: SemanticResult{
		Neighbors: []SemanticNeighbor{{AgentID: "eligible-b", Similarity: 0.82}}, QueryDuration: 12 * time.Millisecond,
	}}
	service := Service{Repository: repository, Semantic: retriever, Now: func() time.Time { return now }}

	first, err := service.RunMatching(context.Background(), "task")
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.RunMatching(context.Background(), "task")
	if err != nil {
		t.Fatal(err)
	}
	if retriever.calls != 1 || len(retriever.seen) != 2 {
		t.Fatalf("semantic retrieval must receive only eligible agents once: calls=%d seen=%+v", retriever.calls, retriever.seen)
	}
	if len(first.Candidates) != 1 || first.Candidates[0].AgentID != "eligible-b" || first.Candidates[0].SemanticSimilarity == nil {
		t.Fatalf("unexpected semantic candidates: %+v", first.Candidates)
	}
	if first.ID != second.ID || first.MatchingMode != "semantic_v1" || first.SemanticQueryMS != 12 {
		t.Fatalf("successful semantic snapshot was not replayed: first=%+v second=%+v", first, second)
	}
	if first.FilterReasons["inactive"] != domain.InactiveAgent {
		t.Fatalf("hard constraint evidence was lost: %+v", first.FilterReasons)
	}
}

func TestSemanticFailureFallsBackWithoutPermanentlyBlockingRecovery(t *testing.T) {
	now := time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC)
	repository := &memoryRepository{input: MatchInput{
		Task:   domain.MatchTask{ID: "task", CategoryID: "code", Description: "Go 服务", Currency: "USDC", Deadline: now.Add(time.Hour)},
		Agents: []domain.AgentCandidate{{ID: "agent", CategoryID: "code", CapabilityDescription: "后端工程", State: domain.AgentState{Status: domain.AgentActive}, Currency: "USDC", EstimatedDuration: time.Minute}},
		Rules:  domain.RankingRules{Version: "ranking-v1", QualityWeight: 1},
	}}
	retriever := &semanticRetrieverFake{err: errors.New("temporary outage")}
	service := Service{Repository: repository, Semantic: retriever, Now: func() time.Time { return now }}

	fallback, err := service.RunMatching(context.Background(), "task")
	if err != nil {
		t.Fatal(err)
	}
	if fallback.MatchingMode != "rules_v0_fallback" || fallback.FallbackReason != "embedding_unavailable" || len(fallback.Candidates) != 1 {
		t.Fatalf("V0 fallback evidence is incomplete: %+v", fallback)
	}
	retriever.err = nil
	retriever.result = SemanticResult{Neighbors: []SemanticNeighbor{{AgentID: "agent", Similarity: 0.9}}}
	recovered, err := service.RunMatching(context.Background(), "task")
	if err != nil {
		t.Fatal(err)
	}
	if retriever.calls != 2 || recovered.MatchingMode != "semantic_v1" || recovered.ID == fallback.ID {
		t.Fatalf("historical fallback permanently blocked V1 recovery: calls=%d fallback=%+v recovered=%+v", retriever.calls, fallback, recovered)
	}
}

func TestRunMatchingDoesNotHideRepositoryFailures(t *testing.T) {
	service := Service{Repository: failingRepository{}}
	if _, err := service.RunMatching(context.Background(), "task"); !errors.Is(err, errRepositoryDown) {
		t.Fatalf("expected repository error, got %v", err)
	}
}

var errRepositoryDown = errors.New("repository down")

type failingRepository struct{}

func (failingRepository) LoadInput(context.Context, string) (MatchInput, error) {
	return MatchInput{}, errRepositoryDown
}
func (failingRepository) FindByFingerprint(context.Context, string, string) (Record, error) {
	return Record{}, errRepositoryDown
}
func (failingRepository) Save(context.Context, Record) (Record, error) {
	return Record{}, errRepositoryDown
}
func (failingRepository) Latest(context.Context, string) (Record, error) {
	return Record{}, errRepositoryDown
}
