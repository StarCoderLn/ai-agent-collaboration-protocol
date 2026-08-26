// Package matching 编排领域匹配管道与持久化。领域纯函数不知道 PostgreSQL，仓储也不
// 决定排序规则；这个模块只负责建立可复现快照、幂等指纹和 JobDistributionRecord。
package matching

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
)

var (
	ErrTaskNotMatchable = errors.New("TASK_NOT_MATCHABLE")
	ErrRecordNotFound   = errors.New("DISTRIBUTION_RECORD_NOT_FOUND")
)

type AssignmentMode string

const (
	AssignmentManual    AssignmentMode = "manual"
	AssignmentAutomatic AssignmentMode = "automatic"
)

type MatchInput struct {
	Task          domain.MatchTask
	TaskUpdatedAt time.Time
	Agents        []domain.AgentCandidate
	Rules         domain.RankingRules
	// AssignmentMode 与候选输入一起进入指纹和快照。自动分配只能依据这份被冻结的
	// 匹配事实，不能在生成候选后重新读取可能已经变化的任务设置。
	AssignmentMode AssignmentMode
}

type CandidateView struct {
	AgentID     string   `json:"agentId"`
	Name        string   `json:"name,omitempty"`
	MatchedTags []string `json:"matchedTags"`
	// 金额通过十进制字符串跨服务传输，避免浏览器把 BIGINT 解码为不安全的 float64。
	QuoteMinor              string  `json:"quoteMinor"`
	EstimatedDurationSecond int64   `json:"estimatedDurationSeconds"`
	Score                   float64 `json:"score"`
	Completed               int     `json:"completed"`
	ResponseMinutes         int     `json:"responseMinutes"`
	IsNew                   bool    `json:"isNew"`
	RankScore               string  `json:"rankScore"`
}

type Record struct {
	ID               string                              `json:"id"`
	TaskID           string                              `json:"taskId"`
	RuleVersion      string                              `json:"ruleVersion"`
	InputFingerprint string                              `json:"inputFingerprint"`
	InputSnapshot    json.RawMessage                     `json:"inputSnapshot"`
	Candidates       []CandidateView                     `json:"candidates"`
	FilterReasons    map[string]domain.EligibilityReason `json:"filterReasons"`
	AssignmentMode   AssignmentMode                      `json:"assignmentMode"`
	FinalSelectionID string                              `json:"finalSelectionAgentId,omitempty"`
	CreatedAt        time.Time                           `json:"createdAt"`
}

type Repository interface {
	LoadInput(ctx context.Context, taskID string) (MatchInput, error)
	FindByFingerprint(ctx context.Context, taskID, fingerprint string) (Record, error)
	Save(ctx context.Context, record Record) (Record, error)
	Latest(ctx context.Context, taskID string) (Record, error)
}

type Service struct {
	Repository Repository
	Now        func() time.Time
}

// RunMatching 以完整输入快照生成指纹；相同指纹直接返回历史记录，不重复写记录。
func (s *Service) RunMatching(ctx context.Context, taskID string) (Record, error) {
	if taskID == "" || s.Repository == nil {
		return Record{}, errors.New("matching service requires task id and repository")
	}
	input, err := s.Repository.LoadInput(ctx, taskID)
	if err != nil {
		return Record{}, err
	}
	canonicalizeInput(&input)
	snapshot, fingerprint, err := snapshotInput(input)
	if err != nil {
		return Record{}, err
	}
	if existing, findErr := s.Repository.FindByFingerprint(ctx, taskID, fingerprint); findErr == nil {
		return existing, nil
	} else if !errors.Is(findErr, ErrRecordNotFound) {
		return Record{}, findErr
	}
	evaluatedAt := time.Now()
	if s.Now != nil {
		evaluatedAt = s.Now()
	}
	distribution, err := domain.MatchCandidates(input.Task, input.Agents, evaluatedAt, input.Rules)
	if err != nil {
		return Record{}, err
	}
	record := Record{
		TaskID:           taskID,
		RuleVersion:      distribution.RuleVersion,
		InputFingerprint: fingerprint,
		InputSnapshot:    snapshotWithEvaluationTime(snapshot, evaluatedAt),
		Candidates:       candidateViews(distribution.Candidates),
		FilterReasons:    distribution.FilterReasons,
		AssignmentMode:   input.AssignmentMode,
	}
	return s.Repository.Save(ctx, record)
}

func (s *Service) LatestCandidates(ctx context.Context, taskID string) (Record, error) {
	if taskID == "" || s.Repository == nil {
		return Record{}, errors.New("matching service requires task id and repository")
	}
	return s.Repository.Latest(ctx, taskID)
}

func candidateViews(candidates []domain.RankedCandidate) []CandidateView {
	views := make([]CandidateView, 0, len(candidates))
	for _, candidate := range candidates {
		views = append(views, CandidateView{
			AgentID:                 candidate.Agent.ID,
			Name:                    candidate.Agent.Name,
			MatchedTags:             append([]string(nil), candidate.MatchedTags...),
			QuoteMinor:              strconv.FormatInt(candidate.Agent.PriceMinor, 10),
			EstimatedDurationSecond: int64(candidate.Agent.EstimatedDuration / time.Second),
			Score:                   candidate.Agent.Score,
			Completed:               candidate.Agent.Completed,
			ResponseMinutes:         candidate.Agent.ResponseMinutes,
			IsNew:                   candidate.Agent.RatingSampleSize < candidate.Agent.PriorWeight,
			RankScore:               strconv.FormatInt(candidate.RankScore, 10),
		})
	}
	return views
}

// 指纹要求 slice 顺序稳定；仓储即使改变 SQL 查询计划，也不能改变“相同输入”的定义。
func canonicalizeInput(input *MatchInput) {
	sort.Strings(input.Task.Tags)
	sort.Slice(input.Agents, func(i, j int) bool { return input.Agents[i].ID < input.Agents[j].ID })
	for index := range input.Agents {
		sort.Strings(input.Agents[index].Tags)
	}
}

func snapshotInput(input MatchInput) (json.RawMessage, string, error) {
	snapshot, err := json.Marshal(input)
	if err != nil {
		return nil, "", err
	}
	digest := sha256.Sum256(snapshot)
	return snapshot, hex.EncodeToString(digest[:]), nil
}

func snapshotWithEvaluationTime(snapshot json.RawMessage, evaluatedAt time.Time) json.RawMessage {
	var decoded map[string]any
	if err := json.Unmarshal(snapshot, &decoded); err != nil {
		return snapshot
	}
	decoded["evaluatedAt"] = evaluatedAt.UTC().Format(time.RFC3339Nano)
	encoded, err := json.Marshal(decoded)
	if err != nil {
		return snapshot
	}
	return encoded
}
