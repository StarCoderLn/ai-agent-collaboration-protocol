package domain

import (
	"fmt"
	"strings"
)

// AgentStatus 是候选过滤与生命周期迁移共用的权威状态。下架是终态；暂停原因
// 不塞进额外布尔值，而是和状态一起形成一个完整快照，避免表达非法组合。
type AgentStatus string

const (
	AgentPendingReview AgentStatus = "pending_review"
	AgentActive        AgentStatus = "active"
	AgentPaused        AgentStatus = "paused"
	AgentDelisted      AgentStatus = "delisted"
)

type PauseReason string

const (
	PauseReasonHealth PauseReason = "health_check"
	PauseReasonManual PauseReason = "manual"
)

type AgentState struct {
	Status      AgentStatus
	PauseReason PauseReason
}

// AgentEvent 使用封闭接口表达互斥迁移事件。调用方必须选择具体事件类型，不能把
// eventName/reason 任意字符串拼成一个状态迁移请求。
type AgentEvent interface{ isAgentEvent() }

// AdminApprove 接受两种互斥证据：当前 MVP 的人工审核理由，或后续 Feature 15
// 产生的沙箱判定 ID。状态机只认结构化证据，不允许无依据把 Agent 直接转为 active。
type AdminApprove struct {
	ReviewReason        string
	AdmissionDecisionID string
}
type AdminReject struct{ ReviewReason string }
type ManualPause struct{}
type AutoPauseHealthCheck struct{}
type ManualResume struct{}
type AutoResumeHealthCheck struct{}
type ProviderDelist struct{}

func (AdminApprove) isAgentEvent()          {}
func (AdminReject) isAgentEvent()           {}
func (ManualPause) isAgentEvent()           {}
func (AutoPauseHealthCheck) isAgentEvent()  {}
func (ManualResume) isAgentEvent()          {}
func (AutoResumeHealthCheck) isAgentEvent() {}
func (ProviderDelist) isAgentEvent()        {}

type InvalidStateTransitionError struct {
	From  AgentState
	Event AgentEvent
}

func (e InvalidStateTransitionError) Error() string {
	return fmt.Sprintf("INVALID_STATE_TRANSITION: %s cannot apply %T", e.From.Status, e.Event)
}

type ResumeRequiresHealthRecoveryError struct{}

func (ResumeRequiresHealthRecoveryError) Error() string { return "RESUME_REQUIRES_HEALTH_RECOVERY" }

// TransitionAgentStatus 是生命周期规则的唯一写入口。API、健康检查和沙箱准入
// 都调用它，因此任何新入口都无法绕过暂停原因或下架终态的约束。
func TransitionAgentStatus(from AgentState, event AgentEvent) (AgentState, error) {
	switch e := event.(type) {
	case AdminApprove:
		hasManualReason := strings.TrimSpace(e.ReviewReason) != ""
		hasSandboxDecision := strings.TrimSpace(e.AdmissionDecisionID) != ""
		if from.Status == AgentPendingReview && hasManualReason != hasSandboxDecision {
			return AgentState{Status: AgentActive}, nil
		}
	case AdminReject:
		if from.Status == AgentPendingReview && strings.TrimSpace(e.ReviewReason) != "" {
			return AgentState{Status: AgentDelisted}, nil
		}
	case ManualPause:
		if from.Status == AgentActive {
			return AgentState{Status: AgentPaused, PauseReason: PauseReasonManual}, nil
		}
	case AutoPauseHealthCheck:
		if from.Status == AgentActive {
			return AgentState{Status: AgentPaused, PauseReason: PauseReasonHealth}, nil
		}
	case ManualResume:
		if from.Status == AgentPaused && from.PauseReason == PauseReasonHealth {
			return from, ResumeRequiresHealthRecoveryError{}
		}
		if from.Status == AgentPaused && from.PauseReason == PauseReasonManual {
			return AgentState{Status: AgentActive}, nil
		}
	case AutoResumeHealthCheck:
		if from.Status == AgentPaused && from.PauseReason == PauseReasonHealth {
			return AgentState{Status: AgentActive}, nil
		}
	case ProviderDelist:
		if from.Status != AgentDelisted {
			return AgentState{Status: AgentDelisted}, nil
		}
	}
	return from, InvalidStateTransitionError{From: from, Event: event}
}

type ProbeResult string

const (
	ProbeSuccess              ProbeResult = "success"
	ProbeAuthFailure          ProbeResult = "auth_failure"
	ProbeProtocolIncompatible ProbeResult = "protocol_incompatible"
	ProbeConnectionTimeout    ProbeResult = "connection_timeout"
	ProbeAgentInternalError   ProbeResult = "agent_internal_error"
)

type HealthConfig struct {
	FailureThreshold       int
	ResumeSuccessThreshold int
}
type HealthCounter struct {
	ConsecutiveFailures  int
	ConsecutiveSuccesses int
}
type HealthOutcome struct {
	Counter              HealthCounter
	State                AgentState
	CountedTowardFailure bool
	Transitioned         bool
}

// ApplyHealthProbe 只接收专门的健康探测结果，真实任务失败没有入口进入该计数器。
// 内部错误会落库但中断“连续网络/协议失败”链，避免把业务质量问题误判成不可达。
func ApplyHealthProbe(state AgentState, counter HealthCounter, result ProbeResult, config HealthConfig) (HealthOutcome, error) {
	if config.FailureThreshold <= 0 || config.ResumeSuccessThreshold <= 0 {
		return HealthOutcome{}, fmt.Errorf("health thresholds must be positive")
	}
	out := HealthOutcome{Counter: counter, State: state}
	counted := result == ProbeAuthFailure || result == ProbeProtocolIncompatible || result == ProbeConnectionTimeout
	out.CountedTowardFailure = counted

	if state.Status == AgentPaused && state.PauseReason == PauseReasonHealth {
		if result == ProbeSuccess {
			out.Counter.ConsecutiveSuccesses++
			out.Counter.ConsecutiveFailures = 0
		} else {
			out.Counter.ConsecutiveSuccesses = 0
		}
		if out.Counter.ConsecutiveSuccesses >= config.ResumeSuccessThreshold {
			next, err := TransitionAgentStatus(state, AutoResumeHealthCheck{})
			if err != nil {
				return out, err
			}
			out.State, out.Counter, out.Transitioned = next, HealthCounter{}, true
		}
		return out, nil
	}

	if result == ProbeSuccess {
		out.Counter = HealthCounter{}
		return out, nil
	}
	if !counted {
		out.Counter.ConsecutiveFailures = 0
		return out, nil
	}
	out.Counter.ConsecutiveFailures++
	if state.Status == AgentActive && out.Counter.ConsecutiveFailures >= config.FailureThreshold {
		next, err := TransitionAgentStatus(state, AutoPauseHealthCheck{})
		if err != nil {
			return out, err
		}
		out.State, out.Counter, out.Transitioned = next, HealthCounter{}, true
	}
	return out, nil
}
