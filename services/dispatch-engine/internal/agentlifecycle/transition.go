// agentlifecycle 包定义内部 HTTP API 与 PostgreSQL 适配器共享的事务型生命周期命令边界；
// 具体迁移规则仍集中在 domain 包中。
package agentlifecycle

import (
	"context"
	"errors"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
)

var (
	ErrAgentNotFound        = errors.New("AGENT_NOT_FOUND")
	ErrForbidden            = errors.New("AGENT_LIFECYCLE_FORBIDDEN")
	ErrIdempotencyRequired  = errors.New("IDEMPOTENCY_KEY_MISSING")
	ErrIdempotencyKeyReused = errors.New("IDEMPOTENCY_KEY_REUSED")
)

type ActorType string

const (
	ActorProvider ActorType = "provider"
	ActorAdmin    ActorType = "admin"
)

type Command struct {
	AgentID        string
	ActorID        string
	ActorType      ActorType
	Event          domain.AgentEvent
	IdempotencyKey string
	Now            time.Time
}

type Snapshot struct {
	AgentID     string             `json:"agentId"`
	Status      domain.AgentStatus `json:"status"`
	PauseReason *string            `json:"pauseReason"`
	UpdatedAt   time.Time          `json:"updatedAt"`
}

type Transitioner interface {
	Transition(ctx context.Context, command Command) (Snapshot, error)
}
