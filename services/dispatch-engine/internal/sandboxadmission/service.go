// sandboxadmission 包负责新 Agent 相互隔离的三次调用准入轮次。它刻意不依赖任务、分配、
// 评分或资金模块：这些记录属于正式业务，沙箱测试必须从结构上无法创建它们。
package sandboxadmission

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
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

	secret := ""
	callsStarted := 0
	defer func() { secret = "" }()
	for runNo := 1; runNo <= RunsPerRound; runNo++ {
		claim, claimed, claimErr := s.Repository.ClaimRun(ctx, command.AgentID, command.RoundID, runNo, now, lease)
		if claimErr != nil {
			return Result{}, claimErr
		}
		if !claimed {
			continue
		}
		if secret == "" && plan.EncryptedCredential != "" {
			secret, err = s.Decryptor.DecryptCredential(ctx, plan.EncryptedCredential)
			if err != nil || secret == "" {
				_ = s.Repository.ReleaseRun(ctx, claim)
				return Result{}, errors.New("sandbox signing credential is unavailable")
			}
		}
		callsStarted++
		outcome, callErr := s.Caller.Call(ctx, CallRequest{
			AgentID: command.AgentID, RoundID: command.RoundID, RunNo: runNo,
			Endpoint: plan.Endpoint, IntegrationMode: plan.IntegrationMode,
			Secret: secret, Body: append([]byte(nil), plan.TestInput...),
			IdempotencyKey: sandboxIdempotencyKey(command.RoundID, runNo),
		})
		if callErr != nil {
			_ = s.Repository.ReleaseRun(ctx, claim)
			return Result{}, callErr
		}
		completedAt := now
		if s.Now != nil {
			completedAt = s.Now().UTC()
		} else {
			completedAt = time.Now().UTC()
		}
		if err = s.Repository.CompleteRun(ctx, claim, outcome, completedAt); err != nil {
			return Result{}, err
		}
	}
	secret = ""
	runs, err := s.Repository.ListRound(ctx, command.AgentID, command.RoundID)
	if err != nil {
		return Result{}, err
	}
	if len(runs) != RunsPerRound {
		return Result{}, ErrRoundInconsistent
	}
	return Result{AgentID: command.AgentID, RoundID: command.RoundID, Runs: runs, CallsStarted: callsStarted}, nil
}

func sandboxIdempotencyKey(roundID string, runNo int) string {
	return "sandbox:" + roundID + ":" + strconv.Itoa(runNo)
}
