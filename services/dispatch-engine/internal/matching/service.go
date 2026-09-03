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
	Task           domain.MatchTask
	WorkflowNodeID string
	TaskUpdatedAt  time.Time
	Agents         []domain.AgentCandidate
	Rules          domain.RankingRules
	// AssignmentMode 与候选输入一起进入指纹和快照。自动分配只能依据这份被冻结的
	// 匹配事实，不能在生成候选后重新读取可能已经变化的任务设置。
	AssignmentMode AssignmentMode
	// DispatchReady 是节点当前阶段的瞬时门禁，不进入输入指纹。selecting 与 matching
	// 使用同一份候选事实；托管确认只改变是否可派发，不应凭空生成另一版候选。
	DispatchReady bool `json:"-"`
	// PreviousAssignmentID 只在最新分配已经取消时存在，用来标识当前派发是对哪一次
	// 执行的替换。该运行态事实不能进入候选指纹，否则一次恢复会制造新的候选版本。
	PreviousAssignmentID string `json:"-"`
}

type CandidateView struct {
	AgentID     string   `json:"agentId"`
	Name        string   `json:"name,omitempty"`
	MatchedTags []string `json:"matchedTags"`
	// UnmatchedTags 只表示 Agent 的声明标签尚未覆盖该能力，不等于 Agent 一定做不到；
	// 前端据此诚实展示证据缺口，不能把缺少标签伪装成已验证能力。
	UnmatchedTags []string `json:"unmatchedTags"`
	// 金额通过十进制字符串跨服务传输，避免浏览器把 BIGINT 解码为不安全的 float64。
	QuoteMinor              string  `json:"quoteMinor"`
	EstimatedDurationSecond int64   `json:"estimatedDurationSeconds"`
	Score                   float64 `json:"score"`
	Completed               int     `json:"completed"`
	ResponseMinutes         int     `json:"responseMinutes"`
	IsNew                   bool    `json:"isNew"`
	RankScore               string  `json:"rankScore"`
	// 推荐徽标与证据全部来自冻结输入，不由浏览器根据展示顺序临时猜测。
	RecommendationBadges []string                   `json:"recommendationBadges"`
	TaskFitScore         int                        `json:"taskFitScore"`
	Confidence           string                     `json:"confidence"`
	SampleSize           int                        `json:"sampleSize"`
	SimilarCompleted     int                        `json:"similarCompleted"`
	OnTimeRate           float64                    `json:"onTimeRate"`
	ReworkRate           float64                    `json:"reworkRate"`
	DisputeRate          float64                    `json:"disputeRate"`
	CurrentLoad          int                        `json:"currentLoad"`
	ScoreDimensions      json.RawMessage            `json:"scoreDimensions"`
	DeliveryCases        []domain.AgentDeliveryCase `json:"deliveryCases"`
}

type Record struct {
	ID               string                              `json:"id"`
	TaskID           string                              `json:"taskId"`
	WorkflowNodeID   string                              `json:"workflowNodeId,omitempty"`
	RuleVersion      string                              `json:"ruleVersion"`
	InputFingerprint string                              `json:"inputFingerprint"`
	InputSnapshot    json.RawMessage                     `json:"inputSnapshot"`
	Candidates       []CandidateView                     `json:"candidates"`
	FilterReasons    map[string]domain.EligibilityReason `json:"filterReasons"`
	AssignmentMode   AssignmentMode                      `json:"assignmentMode"`
	FinalSelectionID string                              `json:"finalSelectionAgentId,omitempty"`
	CreatedAt        time.Time                           `json:"createdAt"`
	DispatchReady    bool                                `json:"-"`
	// PreviousAssignmentID 标识本轮派发正在替换的已取消分配。它只参与构造新的
	// 派发幂等身份，不属于候选快照，也不能通过外部 API 伪造或持久化回候选记录。
	PreviousAssignmentID string `json:"-"`
}

type Repository interface {
	LoadInput(ctx context.Context, taskID string) (MatchInput, error)
	FindByFingerprint(ctx context.Context, taskID, fingerprint string) (Record, error)
	Save(ctx context.Context, record Record) (Record, error)
	Latest(ctx context.Context, taskID string) (Record, error)
}

// WorkflowNodeRepository 在旧任务级接口旁增加节点维度。旧实现无需伪造空节点；只有
// 正式多 Agent 仓储实现本接口，Service 在节点入口显式检查能力是否存在。
type WorkflowNodeRepository interface {
	LoadWorkflowNodeInput(ctx context.Context, taskID, workflowNodeID string) (MatchInput, error)
	FindWorkflowNodeByFingerprint(ctx context.Context, taskID, workflowNodeID, fingerprint string) (Record, error)
	SaveWorkflowNode(ctx context.Context, record Record) (Record, error)
	LatestWorkflowNode(ctx context.Context, taskID, workflowNodeID string) (Record, error)
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
	return s.runMatching(
		ctx,
		taskID,
		"",
		s.Repository.LoadInput,
		s.Repository.FindByFingerprint,
		s.Repository.Save,
		nil,
	)
}

// RunWorkflowNodeMatching 使用节点自身的分类、标签、价格偏好和依赖截止时间匹配。
// 价格偏好为 0 表示用户尚未设置上限，不会过滤候选，也不会冒充冻结报价。
// 候选仍复用同一排序领域函数，但快照和唯一键都带 node id，互不覆盖相邻节点。
func (s *Service) RunWorkflowNodeMatching(ctx context.Context, taskID, workflowNodeID string) (Record, error) {
	if taskID == "" || workflowNodeID == "" || s.Repository == nil {
		return Record{}, errors.New("workflow matching requires task, node and repository")
	}
	repository, ok := s.Repository.(WorkflowNodeRepository)
	if !ok {
		return Record{}, errors.New("matching repository does not support workflow nodes")
	}
	return s.runMatching(
		ctx,
		taskID,
		workflowNodeID,
		func(ctx context.Context, taskID string) (MatchInput, error) {
			return repository.LoadWorkflowNodeInput(ctx, taskID, workflowNodeID)
		},
		func(ctx context.Context, taskID, fingerprint string) (Record, error) {
			return repository.FindWorkflowNodeByFingerprint(ctx, taskID, workflowNodeID, fingerprint)
		},
		repository.SaveWorkflowNode,
		func(ctx context.Context, taskID string) (Record, error) {
			return repository.LatestWorkflowNode(ctx, taskID, workflowNodeID)
		},
	)
}

func (s *Service) runMatching(
	ctx context.Context,
	taskID string,
	workflowNodeID string,
	load func(context.Context, string) (MatchInput, error),
	find func(context.Context, string, string) (Record, error),
	save func(context.Context, Record) (Record, error),
	latest func(context.Context, string) (Record, error),
) (Record, error) {
	input, err := load(ctx, taskID)
	if err != nil {
		return Record{}, err
	}
	// 托管确认后必须派发用户已经冻结的候选，不能因为节点 updated_at 或预算帽变更
	// 重新排名。此时直接读取最新选择快照；没有选择才继续走普通匹配/自动分配路径。
	if input.DispatchReady && latest != nil {
		if selected, latestErr := latest(ctx, taskID); latestErr == nil && selected.FinalSelectionID != "" {
			selected.DispatchReady = true
			selected.PreviousAssignmentID = input.PreviousAssignmentID
			return selected, nil
		} else if latestErr != nil && !errors.Is(latestErr, ErrRecordNotFound) {
			return Record{}, latestErr
		}
	}
	canonicalizeInput(&input)
	snapshot, fingerprint, err := snapshotInput(input)
	if err != nil {
		return Record{}, err
	}
	if existing, findErr := find(ctx, taskID, fingerprint); findErr == nil {
		existing.DispatchReady = input.DispatchReady
		existing.PreviousAssignmentID = input.PreviousAssignmentID
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
		TaskID:               taskID,
		WorkflowNodeID:       workflowNodeID,
		RuleVersion:          distribution.RuleVersion,
		InputFingerprint:     fingerprint,
		InputSnapshot:        snapshotWithEvaluationTime(snapshot, evaluatedAt),
		Candidates:           candidateViews(distribution.Candidates, input.Task.Tags),
		FilterReasons:        distribution.FilterReasons,
		AssignmentMode:       input.AssignmentMode,
		DispatchReady:        input.DispatchReady,
		PreviousAssignmentID: input.PreviousAssignmentID,
	}
	return save(ctx, record)
}

func (s *Service) LatestCandidates(ctx context.Context, taskID string) (Record, error) {
	if taskID == "" || s.Repository == nil {
		return Record{}, errors.New("matching service requires task id and repository")
	}
	return s.Repository.Latest(ctx, taskID)
}

func (s *Service) LatestWorkflowNodeCandidates(ctx context.Context, taskID, workflowNodeID string) (Record, error) {
	if taskID == "" || workflowNodeID == "" || s.Repository == nil {
		return Record{}, errors.New("workflow matching requires task, node and repository")
	}
	repository, ok := s.Repository.(WorkflowNodeRepository)
	if !ok {
		return Record{}, errors.New("matching repository does not support workflow nodes")
	}
	return repository.LatestWorkflowNode(ctx, taskID, workflowNodeID)
}

func candidateViews(candidates []domain.RankedCandidate, taskTags []string) []CandidateView {
	qualityIndex, valueIndex := preferredCandidateIndexes(candidates)
	views := make([]CandidateView, 0, len(candidates))
	for index, candidate := range candidates {
		badges := make([]string, 0, 3)
		if index == 0 {
			badges = append(badges, "best_overall")
		}
		if index == qualityIndex {
			badges = append(badges, "quality_first")
		}
		if index == valueIndex {
			badges = append(badges, "best_value")
		}
		fitScore := 100
		if len(taskTags) > 0 {
			fitScore = len(candidate.MatchedTags) * 100 / len(taskTags)
		}
		views = append(views, CandidateView{
			AgentID:                 candidate.Agent.ID,
			Name:                    candidate.Agent.Name,
			MatchedTags:             append([]string(nil), candidate.MatchedTags...),
			UnmatchedTags:           unmatchedTags(taskTags, candidate.MatchedTags),
			QuoteMinor:              strconv.FormatInt(candidate.Agent.PriceMinor, 10),
			EstimatedDurationSecond: int64(candidate.Agent.EstimatedDuration / time.Second),
			Score:                   candidate.Agent.Score,
			Completed:               candidate.Agent.Completed,
			ResponseMinutes:         candidate.Agent.ResponseMinutes,
			IsNew:                   candidate.Agent.RatingSampleSize < candidate.Agent.PriorWeight,
			RankScore:               strconv.FormatInt(candidate.RankScore, 10),
			RecommendationBadges:    badges,
			TaskFitScore:            fitScore,
			Confidence:              confidence(candidate.Agent.RatingSampleSize, candidate.Agent.PriorWeight),
			SampleSize:              candidate.Agent.RatingSampleSize,
			SimilarCompleted:        candidate.Agent.SimilarCompleted,
			OnTimeRate:              candidate.Agent.OnTimeRate,
			ReworkRate:              candidate.Agent.ReworkRate,
			DisputeRate:             candidate.Agent.DisputeRate,
			CurrentLoad:             candidate.Agent.CurrentLoad,
			ScoreDimensions:         append(json.RawMessage(nil), candidate.Agent.ScoreDimensions...),
			// API 契约中的案例始终是数组。没有案例时输出 [] 而不是 null，避免浏览器把
			// 整份候选响应判定为结构损坏，也让调用方无需维护两套“没有数据”语义。
			DeliveryCases: append(
				make([]domain.AgentDeliveryCase, 0, len(candidate.Agent.DeliveryCases)),
				candidate.Agent.DeliveryCases...,
			),
		})
	}
	return views
}

func preferredCandidateIndexes(candidates []domain.RankedCandidate) (int, int) {
	if len(candidates) == 0 {
		return -1, -1
	}
	qualityIndex, valueIndex := 0, 0
	for index := 1; index < len(candidates); index++ {
		if candidates[index].Agent.Score > candidates[qualityIndex].Agent.Score {
			qualityIndex = index
		}
		// score 先量化为千分位，再交叉相乘比较“每单位价格的质量”，避免浮点除法
		// 和不同运行时舍入让同一冻结快照得到不同徽标。
		currentQuality := int64(candidates[index].Agent.Score * 1000)
		bestQuality := int64(candidates[valueIndex].Agent.Score * 1000)
		if currentQuality*candidates[valueIndex].Agent.PriceMinor > bestQuality*candidates[index].Agent.PriceMinor {
			valueIndex = index
		}
	}
	return qualityIndex, valueIndex
}

func confidence(sampleSize, priorWeight int) string {
	if sampleSize < priorWeight {
		return "low"
	}
	if sampleSize < priorWeight*2 {
		return "medium"
	}
	return "high"
}

// unmatchedTags 从任务能力中减去已有证据交集。返回稳定顺序，确保候选快照、页面说明
// 和幂等重放一致；它只描述标签证据缺口，不对 Agent 的真实能力作超出证据的判断。
func unmatchedTags(taskTags, matchedTags []string) []string {
	matched := make(map[string]struct{}, len(matchedTags))
	for _, tag := range matchedTags {
		matched[tag] = struct{}{}
	}
	missing := make([]string, 0, len(taskTags))
	for _, tag := range taskTags {
		if _, ok := matched[tag]; !ok {
			missing = append(missing, tag)
		}
	}
	sort.Strings(missing)
	return missing
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
