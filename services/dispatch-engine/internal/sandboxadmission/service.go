// sandboxadmission 包负责新 Agent 相互隔离的三次调用准入轮次。它刻意不依赖任务、分配、
// 评分或资金模块：这些记录属于正式业务，沙箱测试必须从结构上无法创建它们。
package sandboxadmission

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const RunsPerRound = 3

var (
	ErrAgentNotFound         = errors.New("sandbox Agent was not found")
	ErrAgentNotPendingReview = errors.New("sandbox Agent is not pending review")
	ErrTemplateNotFound      = errors.New("sandbox test template was not found")
	ErrRoundInconsistent     = errors.New("sandbox round is inconsistent")
	ErrRunLeaseLost          = errors.New("sandbox run lease is no longer owned")
	identifierPattern        = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

type Command struct {
	AgentID string
	// RoundID 由注册审核事件提供。复用同一个 ID 表示重试同一逻辑轮次；提供者主动要求
	// 重新测试时必须使用新的 ID。
	RoundID string
}

type RoundPlan struct {
	AgentID             string
	RoundID             string
	TemplateID          string
	AgentName           string
	Capability          string
	Tags                []string
	Endpoint            string
	IntegrationMode     string
	EncryptedCredential string
	TestInput           json.RawMessage
}

type RunStatus string

const (
	RunPending   RunStatus = "pending"
	RunRunning   RunStatus = "running"
	RunCompleted RunStatus = "completed"
	RunFailed    RunStatus = "failed"
)

type TechnicalMetrics struct {
	ProtocolCompliant bool    `json:"protocol_compliant"`
	LatencyMS         int64   `json:"latency_ms"`
	ErrorCategory     *string `json:"error_category"`
	HTTPStatus        *int    `json:"http_status"`
	ResponseBytes     int64   `json:"response_bytes"`
}

type Run struct {
	ID               string
	AgentID          string
	RoundID          string
	TemplateID       string
	RunNo            int
	CallType         string
	Status           RunStatus
	OutputRef        *string
	TechnicalMetrics *TechnicalMetrics
	StartedAt        *time.Time
	CompletedAt      *time.Time
	CreatedAt        time.Time
}

type Claim struct {
	RunID     string
	AgentID   string
	RoundID   string
	RunNo     int
	LockToken string
}

type CallRequest struct {
	AgentID         string
	RoundID         string
	RunNo           int
	Endpoint        string
	IntegrationMode string
	Secret          string
	Body            []byte
	IdempotencyKey  string
}

type CallOutcome struct {
	Succeeded bool
	OutputRef *string
	Metrics   TechnicalMetrics
}

type Repository interface {
	PrepareRound(ctx context.Context, agentID, roundID string, createdAt time.Time) (RoundPlan, error)
	ClaimRun(ctx context.Context, agentID, roundID string, runNo int, now time.Time, lease time.Duration) (Claim, bool, error)
	CompleteRun(ctx context.Context, claim Claim, outcome CallOutcome, completedAt time.Time) error
	ReleaseRun(ctx context.Context, claim Claim) error
	ListRound(ctx context.Context, agentID, roundID string) ([]Run, error)
}

type CredentialDecryptor interface {
	DecryptCredential(ctx context.Context, encrypted string) (string, error)
}

type Caller interface {
	Call(ctx context.Context, request CallRequest) (CallOutcome, error)
}

type Result struct {
	AgentID      string
	RoundID      string
	AgentName    string
	Capability   string
	TestInputs   []json.RawMessage
	Runs         []Run
	CallsStarted int
}

type Service struct {
	Repository Repository
	Decryptor  CredentialDecryptor
	Caller     Caller
	Now        func() time.Time
	Lease      time.Duration
}

// RunSandboxTest 创建一个幂等准入轮次并尝试其中三次逻辑调用。恢复后的调用始终使用同一
// Idempotency-Key，因此遵循协议 v1 的 Agent 会重放已存结果，而不是执行第四次逻辑调用。
func (s *Service) RunSandboxTest(ctx context.Context, command Command) (Result, error) {
	if s.Repository == nil || s.Decryptor == nil || s.Caller == nil {
		return Result{}, errors.New("sandbox admission service requires repository, decryptor and caller")
	}
	if !identifierPattern.MatchString(command.AgentID) || !identifierPattern.MatchString(command.RoundID) {
		return Result{}, errors.New("sandbox admission requires UUID agent and round identifiers")
	}
	now := time.Now().UTC()
	if s.Now != nil {
		now = s.Now().UTC()
	}
	lease := s.Lease
	if lease <= 0 {
		lease = 2 * time.Minute
	}
	plan, err := s.Repository.PrepareRound(ctx, command.AgentID, command.RoundID, now)
	if err != nil {
		return Result{}, err
	}
	if len(plan.TestInput) == 0 || plan.Endpoint == "" ||
		(plan.IntegrationMode != "http_json" && plan.EncryptedCredential == "") {
		return Result{}, errors.New("sandbox round target is incomplete")
	}

	callsStarted := 0
	for runNo := 1; runNo <= RunsPerRound; runNo++ {
		started, runErr := s.runPreparedStep(ctx, plan, runNo, now, lease)
		if runErr != nil {
			return Result{}, runErr
		}
		if started {
			callsStarted++
		}
	}
	return s.loadPreparedResult(ctx, plan, callsStarted)
}

// RunSandboxStep 供持久工作流把每次外部 Agent 调用放入独立 Activity。仓储租约与稳定
// 幂等键仍是最终防重边界，因此 Temporal Activity 重试不会产生第四次逻辑调用。
func (s *Service) RunSandboxStep(ctx context.Context, command Command, runNo int) (Run, error) {
	if s.Repository == nil || s.Decryptor == nil || s.Caller == nil || runNo < 1 || runNo > RunsPerRound {
		return Run{}, errors.New("sandbox admission step is not configured")
	}
	now := time.Now().UTC()
	if s.Now != nil {
		now = s.Now().UTC()
	}
	lease := s.Lease
	if lease <= 0 {
		lease = 2 * time.Minute
	}
	plan, err := s.Repository.PrepareRound(ctx, command.AgentID, command.RoundID, now)
	if err != nil {
		return Run{}, err
	}
	if len(plan.TestInput) == 0 || plan.Endpoint == "" ||
		(plan.IntegrationMode != "http_json" && plan.EncryptedCredential == "") {
		return Run{}, errors.New("sandbox round target is incomplete")
	}
	if _, err = s.runPreparedStep(ctx, plan, runNo, now, lease); err != nil {
		return Run{}, err
	}
	runs, err := s.Repository.ListRound(ctx, command.AgentID, command.RoundID)
	if err != nil {
		return Run{}, err
	}
	for _, run := range runs {
		if run.RunNo == runNo {
			return run, nil
		}
	}
	return Run{}, ErrRoundInconsistent
}

// LoadSandboxResult 只读取已经持久化的三次调用证据，供质量评测 Activity 使用。
func (s *Service) LoadSandboxResult(ctx context.Context, command Command) (Result, error) {
	now := time.Now().UTC()
	if s.Now != nil {
		now = s.Now().UTC()
	}
	plan, err := s.Repository.PrepareRound(ctx, command.AgentID, command.RoundID, now)
	if err != nil {
		return Result{}, err
	}
	return s.loadPreparedResult(ctx, plan, 0)
}

func (s *Service) runPreparedStep(ctx context.Context, plan RoundPlan, runNo int, now time.Time, lease time.Duration) (bool, error) {
	claim, claimed, err := s.Repository.ClaimRun(ctx, plan.AgentID, plan.RoundID, runNo, now, lease)
	if err != nil || !claimed {
		return false, err
	}
	secret := ""
	defer func() { secret = "" }()
	if plan.EncryptedCredential != "" {
		secret, err = s.Decryptor.DecryptCredential(ctx, plan.EncryptedCredential)
		if err != nil || secret == "" {
			_ = s.Repository.ReleaseRun(ctx, claim)
			return false, errors.New("sandbox signing credential is unavailable")
		}
	}
	testInput, err := testInputForRun(plan, runNo)
	if err != nil {
		_ = s.Repository.ReleaseRun(ctx, claim)
		return false, err
	}
	outcome, err := s.Caller.Call(ctx, CallRequest{
		AgentID: plan.AgentID, RoundID: plan.RoundID, RunNo: runNo, Endpoint: plan.Endpoint,
		IntegrationMode: plan.IntegrationMode, Secret: secret, Body: testInput,
		IdempotencyKey: sandboxIdempotencyKey(plan.RoundID, runNo),
	})
	if err != nil {
		_ = s.Repository.ReleaseRun(ctx, claim)
		return false, err
	}
	completedAt := time.Now().UTC()
	if s.Now != nil {
		completedAt = s.Now().UTC()
	}
	if err = s.Repository.CompleteRun(ctx, claim, outcome, completedAt); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Service) loadPreparedResult(ctx context.Context, plan RoundPlan, callsStarted int) (Result, error) {
	runs, err := s.Repository.ListRound(ctx, plan.AgentID, plan.RoundID)
	if err != nil {
		return Result{}, err
	}
	if len(runs) != RunsPerRound {
		return Result{}, ErrRoundInconsistent
	}
	testInputs := make([]json.RawMessage, 0, RunsPerRound)
	for runNo := 1; runNo <= RunsPerRound; runNo++ {
		testInput, inputErr := testInputForRun(plan, runNo)
		if inputErr != nil {
			return Result{}, inputErr
		}
		testInputs = append(testInputs, testInput)
	}
	return Result{
		AgentID: plan.AgentID, RoundID: plan.RoundID,
		AgentName: plan.AgentName, Capability: plan.Capability, TestInputs: testInputs,
		Runs: runs, CallsStarted: callsStarted,
	}, nil
}

/**
 * testInputForRun 从轮次开始时冻结的模板中选择对应测试题，并补入 Agent 自述能力。
 * v1 模板只有单个对象，仍按原样兼容；v2 及以后使用恰好三个 cases，防止所谓“三次
 * 测试”实际只是重复同一道题。动态补充字段只使用公开档案，不会把凭证写入任务正文。
 */
func testInputForRun(plan RoundPlan, runNo int) ([]byte, error) {
	if runNo < 1 || runNo > RunsPerRound {
		return nil, ErrRoundInconsistent
	}
	var template struct {
		Cases []map[string]any `json:"cases"`
	}
	if err := json.Unmarshal(plan.TestInput, &template); err != nil {
		return nil, errors.New("sandbox test template is invalid")
	}
	if len(template.Cases) == 0 {
		// 已经发起的 v1 轮次必须继续使用被冻结的原模板，不能因部署新代码而改变输入。
		return append([]byte(nil), plan.TestInput...), nil
	}
	if len(template.Cases) != RunsPerRound {
		return nil, ErrRoundInconsistent
	}
	testCase := template.Cases[runNo-1]
	// 通用题目的原始标题只描述验证维度（例如“约束遵循测试”），直接交给内容生成
	// Agent 容易被误当成最终作品主题。把公开 Agent 名称写入任务标题后，论文、图片、
	// PPT 与 Coding Agent 都能明确“用自己的能力完成这个维度”，无需为每种类型复制题库。
	if title, ok := testCase["title"].(string); ok {
		title = strings.TrimSpace(title)
		agentName := strings.TrimSpace(plan.AgentName)
		if title != "" && agentName != "" {
			testCase["title"] = agentName + " · " + title
		}
	}
	testCase["id"] = "sandbox:" + plan.RoundID + ":" + strconv.Itoa(runNo)
	testCase["requiredCapability"] = plan.Capability
	testCase["tags"] = append([]string(nil), plan.Tags...)
	testCase["agentProfile"] = map[string]any{
		"name":               plan.AgentName,
		"declaredCapability": plan.Capability,
	}
	encoded, err := json.Marshal(testCase)
	if err != nil {
		return nil, errors.New("sandbox test input cannot be encoded")
	}
	return encoded, nil
}

func sandboxIdempotencyKey(roundID string, runNo int) string {
	return "sandbox:" + roundID + ":" + strconv.Itoa(runNo)
}
