// Package semanticmatching 隐藏 V1 语义召回的模型调用、内容缓存和 pgvector 查询。
// 上层只提供已经通过硬约束的候选，因此模型或数据库异常不会改变资格规则。
package semanticmatching

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/matching"
)

const (
	DefaultModel      = "text-embedding-3-small"
	DefaultDimensions = 1536
	DefaultTopK       = 3
	StrategyVersion   = "semantic-v1"
)

type ErrorKind string

const (
	ErrorEmbedding ErrorKind = "embedding_unavailable"
	ErrorStorage   ErrorKind = "vector_storage_unavailable"
	ErrorQuery     ErrorKind = "vector_query_unavailable"
)

// Error 保留可审计的失败类别，同时避免把第三方响应正文或凭据写入匹配快照。
type Error struct {
	Kind ErrorKind
	Err  error
}

func (e *Error) Error() string { return string(e.Kind) }
func (e *Error) Unwrap() error { return e.Err }

// KindOf 将内部错误收敛为可持久化枚举；未知错误按查询异常处理，不把原文传到 API。
func KindOf(err error) ErrorKind {
	var semanticError *Error
	if errors.As(err, &semanticError) {
		return semanticError.Kind
	}
	return ErrorQuery
}

// Embedder 是模型供应商边界，调用方只依赖批量输入与顺序稳定的向量结果。
type Embedder interface {
	Embed(ctx context.Context, inputs []string) ([][]float32, error)
}

// AgentSource 把一次匹配快照中的 Agent 文本身份固定为内容哈希。
type AgentSource struct {
	AgentID    string
	Text       string
	SourceHash string
}

// StoredEmbedding 是写入缓存所需的最小数据，不携带 Agent 的其他业务字段。
type StoredEmbedding struct {
	AgentID    string
	SourceHash string
	Vector     []float32
}

// Neighbor 是 pgvector 返回的召回证据；Similarity 是归一到 [-1,1] 的余弦相似度。
type Neighbor struct {
	AgentID    string
	Similarity float64
}

// Store 隐藏 pgvector SQL、缓存更新和查询计时，便于领域匹配保持存储无关。
type Store interface {
	ExistingSourceHashes(ctx context.Context, agentIDs []string, model string, dimensions int) (map[string]string, error)
	Upsert(ctx context.Context, embeddings []StoredEmbedding, model string, dimensions int) error
	TopK(ctx context.Context, query []float32, sources []AgentSource, model string, dimensions, limit int) ([]Neighbor, time.Duration, error)
}

// Config 与内容哈希共同进入匹配指纹，模型或 Top-k 变化必须生成新的冻结快照。
type Config struct {
	Model      string
	Dimensions int
	TopK       int
}

// Service 把模型与向量存储组合成一个语义召回入口，不负责资格或最终排序。
type Service struct {
	Embedder Embedder
	Store    Store
	Config   Config
}

// Retrieve 先按内容哈希补齐 Agent 向量，再对任务执行一次 Top-k 查询。任务文本不缓存，
// Agent 文本只在 tags 或 capability_desc 改变时重新计费生成。
func (s *Service) Retrieve(ctx context.Context, task domain.MatchTask, agents []domain.AgentCandidate) (matching.SemanticResult, error) {
	config, err := s.normalizedConfig()
	if err != nil {
		return matching.SemanticResult{}, err
	}
	if len(agents) == 0 {
		return matching.SemanticResult{Neighbors: []matching.SemanticNeighbor{}}, nil
	}

	sources := make([]AgentSource, 0, len(agents))
	for _, agent := range agents {
		text := semanticText(agent.Tags, agent.CapabilityDescription)
		sources = append(sources, AgentSource{AgentID: agent.ID, Text: text, SourceHash: digest(text)})
	}
	sort.Slice(sources, func(i, j int) bool { return sources[i].AgentID < sources[j].AgentID })

	ids := make([]string, 0, len(sources))
	for _, source := range sources {
		ids = append(ids, source.AgentID)
	}
	existing, err := s.Store.ExistingSourceHashes(ctx, ids, config.Model, config.Dimensions)
	if err != nil {
		return matching.SemanticResult{}, &Error{Kind: ErrorStorage, Err: err}
	}
	missing := make([]AgentSource, 0)
	for _, source := range sources {
		if existing[source.AgentID] != source.SourceHash {
			missing = append(missing, source)
		}
	}

	inputs := make([]string, 1, 1+len(missing))
	inputs[0] = semanticText(task.Tags, task.Description)
	for _, source := range missing {
		inputs = append(inputs, source.Text)
	}
	vectors, err := s.Embedder.Embed(ctx, inputs)
	if err != nil {
		return matching.SemanticResult{}, &Error{Kind: ErrorEmbedding, Err: err}
	}
	if len(vectors) != len(inputs) {
		return matching.SemanticResult{}, &Error{Kind: ErrorEmbedding, Err: fmt.Errorf("embedding count mismatch: got %d want %d", len(vectors), len(inputs))}
	}
	for _, vector := range vectors {
		if len(vector) != config.Dimensions {
			return matching.SemanticResult{}, &Error{Kind: ErrorEmbedding, Err: fmt.Errorf("embedding dimensions mismatch: got %d want %d", len(vector), config.Dimensions)}
		}
	}
	if len(missing) > 0 {
		updates := make([]StoredEmbedding, 0, len(missing))
		for index, source := range missing {
			updates = append(updates, StoredEmbedding{AgentID: source.AgentID, SourceHash: source.SourceHash, Vector: vectors[index+1]})
		}
		if err = s.Store.Upsert(ctx, updates, config.Model, config.Dimensions); err != nil {
			return matching.SemanticResult{}, &Error{Kind: ErrorStorage, Err: err}
		}
	}

	limit := min(config.TopK, len(sources))
	neighbors, queryDuration, err := s.Store.TopK(ctx, vectors[0], sources, config.Model, config.Dimensions, limit)
	if err != nil {
		return matching.SemanticResult{}, &Error{Kind: ErrorQuery, Err: err}
	}
	if len(neighbors) != limit {
		// Upsert 与查询之间如果恰好发生并发档案更新，source_hash 连接会主动排除旧向量。
		// 此时不能拿不完整 Top-k 冒充成功，应整体回退 V0，由下次匹配基于新快照重试。
		return matching.SemanticResult{}, &Error{
			Kind: ErrorQuery,
			Err:  fmt.Errorf("semantic result count mismatch: got %d want %d", len(neighbors), limit),
		}
	}
	result := matching.SemanticResult{Neighbors: make([]matching.SemanticNeighbor, 0, len(neighbors)), QueryDuration: queryDuration}
	for _, neighbor := range neighbors {
		result.Neighbors = append(result.Neighbors, matching.SemanticNeighbor{AgentID: neighbor.AgentID, Similarity: neighbor.Similarity})
	}
	return result, nil
}

// Descriptor 返回会影响召回结果的稳定配置，供上层构建可复现指纹。
func (s *Service) Descriptor() matching.SemanticDescriptor {
	config, err := s.normalizedConfig()
	if err != nil {
		return matching.SemanticDescriptor{Version: StrategyVersion}
	}
	return matching.SemanticDescriptor{Version: StrategyVersion, Model: config.Model, Dimensions: config.Dimensions, TopK: config.TopK}
}

// FailureKind 只公开稳定类别；底层错误链仍保留给进程内诊断，不进入用户响应。
func (s *Service) FailureKind(err error) string { return string(KindOf(err)) }

func (s *Service) normalizedConfig() (Config, error) {
	if s == nil || s.Embedder == nil || s.Store == nil {
		return Config{}, errors.New("semantic matching requires embedder and store")
	}
	config := s.Config
	if config.Model == "" {
		config.Model = DefaultModel
	}
	if config.Dimensions == 0 {
		config.Dimensions = DefaultDimensions
	}
	if config.TopK == 0 {
		config.TopK = DefaultTopK
	}
	if config.Dimensions != DefaultDimensions {
		return Config{}, fmt.Errorf("semantic matching schema requires %d dimensions", DefaultDimensions)
	}
	if config.TopK < 1 || config.TopK > 100 {
		return Config{}, errors.New("semantic matching top-k must be between 1 and 100")
	}
	return config, nil
}

func semanticText(tags []string, description string) string {
	normalizedTags := append([]string(nil), tags...)
	for index := range normalizedTags {
		normalizedTags[index] = strings.TrimSpace(normalizedTags[index])
	}
	sort.Strings(normalizedTags)
	return "标签：" + strings.Join(normalizedTags, "、") + "\n描述：" + strings.TrimSpace(description)
}

func digest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
