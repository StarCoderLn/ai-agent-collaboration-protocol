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
	"strings"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
)

var (
	ErrTaskNotMatchable = errors.New("TASK_NOT_MATCHABLE")
	ErrRecordNotFound   = errors.New("DISTRIBUTION_RECORD_NOT_FOUND")
)

const (
	DisplayTopK             = 3
	matchingV2FeatureSchema = "matching-v2.features.v1"
	matchingV2DatasetSchema = "matching-v2.dataset.v1"
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
	// Semantic 仅在 V1 启用时进入快照和指纹；描述正文不进入冻结记录，只保存内容哈希，
	// 既能识别输入变化，又避免把私有任务描述复制到分发审计表。
	Semantic *SemanticSnapshot `json:"semantic,omitempty"`
	// ModelVersion 进入输入指纹，保证模型升级后新匹配不会错误复用旧版本候选快照。
	ModelVersion string `json:"modelVersion,omitempty"`
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
	QuoteMinor              string   `json:"quoteMinor"`
	EstimatedDurationSecond int64    `json:"estimatedDurationSeconds"`
	Score                   float64  `json:"score"`
	Completed               int      `json:"completed"`
	ResponseMinutes         int      `json:"responseMinutes"`
	IsNew                   bool     `json:"isNew"`
	RankScore               string   `json:"rankScore"`
	SemanticSimilarity      *float64 `json:"semanticSimilarity,omitempty"`
	PCTR                    *float64 `json:"pctr,omitempty"`
	PCVR                    *float64 `json:"pcvr,omitempty"`
	PCTCVR                  *float64 `json:"pctcvr,omitempty"`
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
	MatchingMode     string                              `json:"matchingMode,omitempty"`
	SemanticModel    string                              `json:"semanticModel,omitempty"`
	SemanticQueryMS  float64                             `json:"semanticQueryMs,omitempty"`
	FallbackReason   string                              `json:"fallbackReason,omitempty"`
	ModelVersion     string                              `json:"modelVersion,omitempty"`
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
	// ShadowRequest 保存完整 V1 召回池的版本化特征，只交给仓储创建私有影子任务。
	// 它不进入候选 API，也绝不能被 dispatch.Service 当作可选择 Agent 集合。
	ShadowRequest json.RawMessage `json:"-"`
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
	Semantic   SemanticRetriever
	Ranker     FunnelRanker
	// RequireV2 只由正式服务入口开启；领域单元测试仍可独立验证硬约束和规则计算。
	RequireV2 bool
}

type FunnelScore struct {
	AgentID string
	PCTR    float64
	PCVR    float64
	PCTCVR  float64
	Rank    int
}

// FunnelRanker 隐藏 ONNX 服务的 HTTP 传输。匹配层只依赖模型版本和完整候选池评分。
type FunnelRanker interface {
	ModelVersion() string
	Rank(context.Context, json.RawMessage) ([]FunnelScore, error)
}

type SemanticDescriptor struct {
	Version    string
	Model      string
	Dimensions int
	TopK       int
}

// SemanticNeighbor 是匹配层消费的最小召回结果，不泄漏具体向量数据库类型。
type SemanticNeighbor struct {
	AgentID    string
	Similarity float64
}

// SemanticResult 将候选证据和纯数据库查询耗时一起返回，模型网络耗时不混入 <50ms 指标。
type SemanticResult struct {
	Neighbors     []SemanticNeighbor
	QueryDuration time.Duration
}

// SemanticRetriever 是 V1 深模块接口；V0 Service 不依赖 OpenAI 或 pgvector 的具体 SDK。
type SemanticRetriever interface {
	Descriptor() SemanticDescriptor
	Retrieve(ctx context.Context, task domain.MatchTask, agents []domain.AgentCandidate) (SemanticResult, error)
	FailureKind(err error) string
}

// SemanticSnapshot 保存足以复现输入身份的哈希与配置，不复制任务或 Agent 描述正文。
type SemanticSnapshot struct {
	Mode              string            `json:"mode"`
	Version           string            `json:"version"`
	Model             string            `json:"model"`
	Dimensions        int               `json:"dimensions"`
	TopK              int               `json:"topK"`
	TaskSourceHash    string            `json:"taskSourceHash"`
	AgentSourceHashes map[string]string `json:"agentSourceHashes"`
	FallbackReason    string            `json:"fallbackReason,omitempty"`
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
	if s.RequireV2 {
		if s.Semantic == nil || s.Ranker == nil {
			return Record{}, errors.New("matching V2 requires semantic retriever and funnel ranker")
		}
		input.ModelVersion = s.Ranker.ModelVersion()
	}
	if s.Semantic != nil {
		input.Semantic = semanticSnapshot(input, s.Semantic.Descriptor())
	}
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
	matchingMode := "rules_v0"
	semanticModel := ""
	semanticQueryMS := float64(0)
	fallbackReason := ""
	var shadowCandidates []domain.RankedCandidate
	if s.Semantic != nil && len(distribution.Candidates) > 0 {
		eligible := make([]domain.AgentCandidate, 0, len(distribution.Candidates))
		for _, candidate := range distribution.Candidates {
			eligible = append(eligible, candidate.Agent)
		}
		semanticResult, semanticErr := s.Semantic.Retrieve(ctx, input.Task, eligible)
		if semanticErr == nil {
			// 完整 V1 召回池只供 V2 影子重排。正式 V1 仍严格使用语义距离最前的
			// 三名再按既有规则排序，扩大召回池不能在影子阶段偷偷改变用户结果。
			shadowCandidates = semanticCandidates(distribution.Candidates, semanticResult.Neighbors)
			if s.RequireV2 {
				distribution.Candidates = shadowCandidates
				matchingMode = "learned_v2"
			} else {
				formalNeighbors := semanticResult.Neighbors
				if len(formalNeighbors) > DisplayTopK {
					formalNeighbors = formalNeighbors[:DisplayTopK]
				}
				distribution.Candidates = semanticCandidates(distribution.Candidates, formalNeighbors)
				matchingMode = "semantic_v1"
			}
			semanticModel = s.Semantic.Descriptor().Model
			semanticQueryMS = float64(semanticResult.QueryDuration.Microseconds()) / 1000
		} else if s.RequireV2 {
			return Record{}, errors.New("matching V2 semantic retrieval failed")
		} else {
			// fallback 指纹与成功 V1 指纹分离，并且只在本次 V1 尝试失败后查询。模型恢复后
			// 下一次请求仍会先尝试 V1，不会被历史 fallback 快照永久短路。
			fallbackReason = s.Semantic.FailureKind(semanticErr)
			input.Semantic.Mode = "rules_v0_fallback"
			input.Semantic.FallbackReason = fallbackReason
			snapshot, fingerprint, err = snapshotInput(input)
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
			matchingMode = "rules_v0_fallback"
			semanticModel = s.Semantic.Descriptor().Model
		}
	}
	var shadowRequest json.RawMessage
	if (matchingMode == "semantic_v1" || matchingMode == "learned_v2") && len(shadowCandidates) > 0 {
		shadowRequest, err = buildShadowRequest(input.Task, shadowCandidates, evaluatedAt)
		if err != nil {
			return Record{}, err
		}
	}
	if matchingMode == "learned_v2" {
		scores, rankErr := s.Ranker.Rank(ctx, shadowRequest)
		if rankErr != nil {
			return Record{}, errors.New("matching V2 ranking failed")
		}
		distribution.Candidates, err = applyFunnelRanking(distribution.Candidates, scores)
		if err != nil {
			return Record{}, err
		}
		// 正式 V2 已同步消费该特征池，不再创建异步影子任务。
		shadowRequest = nil
	}
	formalCandidates := distribution.Candidates
	if len(formalCandidates) > DisplayTopK {
		formalCandidates = formalCandidates[:DisplayTopK]
	}
	record := Record{
		TaskID:               taskID,
		WorkflowNodeID:       workflowNodeID,
		RuleVersion:          distribution.RuleVersion,
		MatchingMode:         matchingMode,
		SemanticModel:        semanticModel,
		SemanticQueryMS:      semanticQueryMS,
		FallbackReason:       fallbackReason,
		ModelVersion:         input.ModelVersion,
		InputFingerprint:     fingerprint,
		InputSnapshot:        snapshotWithEvaluationTime(snapshot, evaluatedAt),
		Candidates:           candidateViews(formalCandidates, input.Task.Tags),
		FilterReasons:        distribution.FilterReasons,
		AssignmentMode:       input.AssignmentMode,
		DispatchReady:        input.DispatchReady,
		PreviousAssignmentID: input.PreviousAssignmentID,
		ShadowRequest:        shadowRequest,
	}
	return save(ctx, record)
}

func applyFunnelRanking(candidates []domain.RankedCandidate, scores []FunnelScore) ([]domain.RankedCandidate, error) {
	byAgent := make(map[string]FunnelScore, len(scores))
	for _, score := range scores {
		if score.AgentID == "" || score.Rank < 1 || score.Rank > len(candidates) {
			return nil, errors.New("matching V2 returned invalid ranking")
		}
		byAgent[score.AgentID] = score
	}
	if len(byAgent) != len(candidates) {
		return nil, errors.New("matching V2 returned incomplete ranking")
	}
	ranked := append([]domain.RankedCandidate(nil), candidates...)
	for index := range ranked {
		score, ok := byAgent[ranked[index].Agent.ID]
		if !ok {
			return nil, errors.New("matching V2 returned a different candidate set")
		}
		ranked[index].PCTR = pointer(score.PCTR)
		ranked[index].PCVR = pointer(score.PCVR)
		ranked[index].PCTCVR = pointer(score.PCTCVR)
		ranked[index].RankScore = int64(score.PCTCVR * 1_000_000_000)
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		left, right := byAgent[ranked[i].Agent.ID], byAgent[ranked[j].Agent.ID]
		if left.Rank == right.Rank {
			return ranked[i].Agent.ID < ranked[j].Agent.ID
		}
		return left.Rank < right.Rank
	})
	return ranked, nil
}

func pointer(value float64) *float64 { return &value }

type shadowScoreRequest struct {
	FeatureSchemaVersion string                   `json:"featureSchemaVersion"`
	Candidates           []shadowFeatureCandidate `json:"candidates"`
}

type shadowFeatureCandidate struct {
	SchemaVersion      string  `json:"schemaVersion"`
	DataOrigin         string  `json:"dataOrigin"`
	TaskID             string  `json:"taskId"`
	AgentID            string  `json:"agentId"`
	TaskCategory       string  `json:"taskCategory"`
	AgentCategory      string  `json:"agentCategory"`
	OccurredAt         string  `json:"occurredAt"`
	SemanticSimilarity float64 `json:"semanticSimilarity"`
	TagCoverage        float64 `json:"tagCoverage"`
	PriceRatio         float64 `json:"priceRatio"`
	QualityScore       float64 `json:"qualityScore"`
	Confidence         float64 `json:"confidence"`
	ResponseMinutes    int     `json:"responseMinutes"`
	CurrentLoad        int     `json:"currentLoad"`
	OnTimeRate         float64 `json:"onTimeRate"`
	ReworkRate         float64 `json:"reworkRate"`
	DisputeRate        float64 `json:"disputeRate"`
	AdmissionScore     float64 `json:"admissionScore"`
	Position           int     `json:"position"`
	IsNew              int     `json:"isNew"`
}

// buildShadowRequest 只从本次匹配的冻结输入构造特征。任务预算为 0 时用中性比率 1，
// 避免除零；置信度用样本量与贝叶斯先验的比例表示，保持在 [0,1]。
func buildShadowRequest(task domain.MatchTask, candidates []domain.RankedCandidate, occurredAt time.Time) (json.RawMessage, error) {
	request := shadowScoreRequest{FeatureSchemaVersion: matchingV2FeatureSchema, Candidates: make([]shadowFeatureCandidate, 0, len(candidates))}
	for index, candidate := range candidates {
		agent := candidate.Agent
		similarity := float64(0)
		if candidate.SemanticSimilarity != nil {
			similarity = *candidate.SemanticSimilarity
		}
		coverage := float64(1)
		if len(task.Tags) > 0 {
			coverage = float64(len(candidate.MatchedTags)) / float64(len(task.Tags))
		}
		priceRatio := float64(1)
		if task.BudgetMinor > 0 {
			priceRatio = float64(agent.PriceMinor) / float64(task.BudgetMinor)
		}
		confidenceDenominator := agent.RatingSampleSize + agent.PriorWeight
		confidenceValue := float64(0)
		if confidenceDenominator > 0 {
			confidenceValue = float64(agent.RatingSampleSize) / float64(confidenceDenominator)
		}
		isNew := 0
		if agent.Completed == 0 {
			isNew = 1
		}
		request.Candidates = append(request.Candidates, shadowFeatureCandidate{
			SchemaVersion: matchingV2DatasetSchema, DataOrigin: "real", TaskID: task.ID, AgentID: agent.ID,
			TaskCategory: task.CategoryID, AgentCategory: agent.CategoryID, OccurredAt: occurredAt.UTC().Format(time.RFC3339Nano),
			SemanticSimilarity: similarity, TagCoverage: coverage, PriceRatio: priceRatio, QualityScore: agent.Score,
			Confidence: confidenceValue, ResponseMinutes: agent.ResponseMinutes, CurrentLoad: agent.CurrentLoad,
			OnTimeRate: agent.OnTimeRate, ReworkRate: agent.ReworkRate, DisputeRate: agent.DisputeRate,
			AdmissionScore: agent.AdmissionScore, Position: index + 1, IsNew: isNew,
		})
	}
	return json.Marshal(request)
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
			AgentID: candidate.Agent.ID,
			Name:    candidate.Agent.Name,
			// 空匹配也是合法证据，必须从权威出口稳定编码成 []。以 nil 为起点复制空切片
			// 会让 encoding/json 输出 null，严格客户端会因此拒绝整份候选快照。
			MatchedTags: append(
				make([]string, 0, len(candidate.MatchedTags)),
				candidate.MatchedTags...,
			),
			UnmatchedTags:           unmatchedTags(taskTags, candidate.MatchedTags),
			QuoteMinor:              strconv.FormatInt(candidate.Agent.PriceMinor, 10),
			EstimatedDurationSecond: int64(candidate.Agent.EstimatedDuration / time.Second),
			Score:                   candidate.Agent.Score,
			Completed:               candidate.Agent.Completed,
			ResponseMinutes:         candidate.Agent.ResponseMinutes,
			// “新 Agent”只表达尚无真实结算记录，不再借用评分低样本状态。一次任务必须
			// 完成、验收并结算后 Completed 才会增加，单纯接单或执行失败不会移除标识。
			IsNew:                candidate.Agent.Completed == 0,
			RankScore:            strconv.FormatInt(candidate.RankScore, 10),
			SemanticSimilarity:   candidate.SemanticSimilarity,
			PCTR:                 candidate.PCTR,
			PCVR:                 candidate.PCVR,
			PCTCVR:               candidate.PCTCVR,
			RecommendationBadges: badges,
			TaskFitScore:         fitScore,
			Confidence:           confidence(candidate.Agent.RatingSampleSize, candidate.Agent.PriorWeight),
			SampleSize:           candidate.Agent.RatingSampleSize,
			SimilarCompleted:     candidate.Agent.SimilarCompleted,
			OnTimeRate:           candidate.Agent.OnTimeRate,
			ReworkRate:           candidate.Agent.ReworkRate,
			DisputeRate:          candidate.Agent.DisputeRate,
			CurrentLoad:          candidate.Agent.CurrentLoad,
			ScoreDimensions:      append(json.RawMessage(nil), candidate.Agent.ScoreDimensions...),
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

func semanticSnapshot(input MatchInput, descriptor SemanticDescriptor) *SemanticSnapshot {
	agentHashes := make(map[string]string, len(input.Agents))
	for _, agent := range input.Agents {
		agentHashes[agent.ID] = sourceDigest(agent.Tags, agent.CapabilityDescription)
	}
	return &SemanticSnapshot{
		Mode: "semantic_v1", Version: descriptor.Version, Model: descriptor.Model,
		Dimensions: descriptor.Dimensions, TopK: descriptor.TopK,
		TaskSourceHash: sourceDigest(input.Task.Tags, input.Task.Description), AgentSourceHashes: agentHashes,
	}
}

func sourceDigest(tags []string, description string) string {
	normalizedTags := append([]string(nil), tags...)
	sort.Strings(normalizedTags)
	digest := sha256.Sum256([]byte(strings.Join(normalizedTags, "\x00") + "\x01" + strings.TrimSpace(description)))
	return hex.EncodeToString(digest[:])
}

func semanticCandidates(candidates []domain.RankedCandidate, neighbors []SemanticNeighbor) []domain.RankedCandidate {
	similarities := make(map[string]float64, len(neighbors))
	for _, neighbor := range neighbors {
		similarities[neighbor.AgentID] = neighbor.Similarity
	}
	selected := make([]domain.RankedCandidate, 0, len(neighbors))
	for _, candidate := range candidates {
		if similarity, ok := similarities[candidate.Agent.ID]; ok {
			value := similarity
			candidate.SemanticSimilarity = &value
			selected = append(selected, candidate)
		}
	}
	return selected
}
