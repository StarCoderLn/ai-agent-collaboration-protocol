package semanticmatching

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
)

type embedderFake struct {
	inputs [][]string
}

func (f *embedderFake) Embed(_ context.Context, inputs []string) ([][]float32, error) {
	f.inputs = append(f.inputs, append([]string(nil), inputs...))
	vectors := make([][]float32, len(inputs))
	for index := range vectors {
		vectors[index] = make([]float32, DefaultDimensions)
		vectors[index][index%DefaultDimensions] = 1
	}
	return vectors, nil
}

type storeFake struct {
	hashes  map[string]string
	upserts []StoredEmbedding
	sources []AgentSource
}

func (f *storeFake) ExistingSourceHashes(context.Context, []string, string, int) (map[string]string, error) {
	return f.hashes, nil
}
func (f *storeFake) Upsert(_ context.Context, embeddings []StoredEmbedding, _ string, _ int) error {
	f.upserts = append(f.upserts, embeddings...)
	return nil
}
func (f *storeFake) TopK(_ context.Context, _ []float32, sources []AgentSource, _ string, _ int, _ int) ([]Neighbor, time.Duration, error) {
	f.sources = append([]AgentSource(nil), sources...)
	return []Neighbor{{AgentID: sources[0].AgentID, Similarity: 0.75}}, 4 * time.Millisecond, nil
}

func TestRetrieveOnlyRegeneratesChangedAgentEmbeddings(t *testing.T) {
	agents := []domain.AgentCandidate{
		{ID: "b", Tags: []string{"写作"}, CapabilityDescription: "撰写技术文档"},
		{ID: "a", Tags: []string{"Go"}, CapabilityDescription: "构建后端服务"},
	}
	unchangedText := semanticText(agents[0].Tags, agents[0].CapabilityDescription)
	store := &storeFake{hashes: map[string]string{"b": digest(unchangedText)}}
	embedder := &embedderFake{}
	service := Service{Embedder: embedder, Store: store, Config: Config{TopK: 1}}

	result, err := service.Retrieve(context.Background(), domain.MatchTask{Tags: []string{"Go"}, Description: "实现 API"}, agents)
	if err != nil {
		t.Fatal(err)
	}
	if len(embedder.inputs) != 1 || len(embedder.inputs[0]) != 2 {
		t.Fatalf("expected task plus one changed agent input, got %+v", embedder.inputs)
	}
	if len(store.upserts) != 1 || store.upserts[0].AgentID != "a" {
		t.Fatalf("unchanged agent embedding was regenerated: %+v", store.upserts)
	}
	if len(store.sources) != 2 || store.sources[0].AgentID != "a" || len(result.Neighbors) != 1 {
		t.Fatalf("semantic query did not use canonical sources: sources=%+v result=%+v", store.sources, result)
	}
}

func TestRetrieveRejectsPartialTopKAfterConcurrentSourceChange(t *testing.T) {
	store := &storeFake{hashes: map[string]string{}}
	service := Service{Embedder: &embedderFake{}, Store: store, Config: Config{TopK: 2}}
	_, err := service.Retrieve(context.Background(), domain.MatchTask{Description: "合成任务"}, []domain.AgentCandidate{
		{ID: "a", CapabilityDescription: "合成能力 A"},
		{ID: "b", CapabilityDescription: "合成能力 B"},
	})
	var semanticError *Error
	if !errors.As(err, &semanticError) || semanticError.Kind != ErrorQuery {
		t.Fatalf("partial Top-k must become a recoverable query failure: %v", err)
	}
}
