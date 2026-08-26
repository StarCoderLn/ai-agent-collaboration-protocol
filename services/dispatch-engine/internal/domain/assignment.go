package domain

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"
)

// AssignmentStatus 只描述“某次 Agent 分配”的生命周期，不复制业务服务中的任务
// 主状态机。业务服务根据这里产生的 accepted/accept_failed 结果迁移任务状态。
type AssignmentStatus string

const (
	AssignmentPendingAck   AssignmentStatus = "pending_ack"
	AssignmentAccepted     AssignmentStatus = "accepted"
	AssignmentAcceptFailed AssignmentStatus = "accept_failed"
	AssignmentCancelled    AssignmentStatus = "cancelled"
)

// Assignment 是分发引擎完成原子占用后持有的最小快照。IdempotencyKey 属于请求，
// 因此同一个键只能重放完全相同的 task/agent 组合，不能被复用到另一条分配上。
type Assignment struct {
	ID      string `json:"id"`
	TaskID  string `json:"taskId"`
	AgentID string `json:"agentId"`
	// 和候选报价使用同一字符串契约；内部仍保留 int64 参与 SQL 与领域比较。
	AgreedAmountMinor int64            `json:"-"`
	IdempotencyKey    string           `json:"idempotencyKey"`
	AssignedBy        string           `json:"assignedBy"`
	Version           int64            `json:"version"`
	Status            AssignmentStatus `json:"status"`
	LockedAt          time.Time        `json:"lockedAt"`
	AcceptBy          time.Time        `json:"acceptBy"`
	RespondedAt       time.Time        `json:"respondedAt"`
}

// MarshalJSON 是唯一的 HTTP 金额投影入口。禁止调用层临时转换，否则内部回调、最新分配
// 和确认响应很容易再次出现不一致字段或不安全 JSON number。
func (assignment Assignment) MarshalJSON() ([]byte, error) {
	type assignmentJSON struct {
		ID                string           `json:"id"`
		TaskID            string           `json:"taskId"`
		AgentID           string           `json:"agentId"`
		AgreedAmountMinor string           `json:"agreedAmountMinor"`
		IdempotencyKey    string           `json:"idempotencyKey"`
		AssignedBy        string           `json:"assignedBy"`
		Version           string           `json:"version"`
		Status            AssignmentStatus `json:"status"`
		LockedAt          time.Time        `json:"lockedAt"`
		AcceptBy          time.Time        `json:"acceptBy"`
		RespondedAt       time.Time        `json:"respondedAt"`
	}
	return json.Marshal(assignmentJSON{
		ID: assignment.ID, TaskID: assignment.TaskID, AgentID: assignment.AgentID,
		AgreedAmountMinor: strconv.FormatInt(assignment.AgreedAmountMinor, 10),
		IdempotencyKey:    assignment.IdempotencyKey, AssignedBy: assignment.AssignedBy,
		Version: strconv.FormatInt(assignment.Version, 10), Status: assignment.Status, LockedAt: assignment.LockedAt,
		AcceptBy: assignment.AcceptBy, RespondedAt: assignment.RespondedAt,
	})
}

var (
	ErrAssignmentAlreadyLocked = errors.New("ASSIGNMENT_ALREADY_LOCKED")
	ErrIdempotencyKeyReused    = errors.New("IDEMPOTENCY_KEY_REUSED")
	ErrAssignmentNotFound      = errors.New("ASSIGNMENT_NOT_FOUND")
	ErrAssignmentAlreadyFinal  = errors.New("ASSIGNMENT_ALREADY_FINAL")
)

// AssignmentBook 是 PostgreSQL 唯一部分索引语义的内存模型，用于领域测试和本地
// 适配器。生产仓储必须依靠数据库约束保证跨进程一致性，不能把本类型当分布式锁。
// 它同时保存 task 和 idempotency 两个索引，让并发占用与网络重放共享一处规则。
type AssignmentBook struct {
	mu            sync.Mutex
	byTask        map[string]Assignment
	byIdempotency map[string]Assignment
}

func NewAssignmentBook() *AssignmentBook {
	return &AssignmentBook{
		byTask:        make(map[string]Assignment),
		byIdempotency: make(map[string]Assignment),
	}
}

// Lock 对同一进程内的并发请求提供“最多一个成功”语义。同一幂等键、同一请求的
// 重放返回第一次的快照；同一键换参数会明确失败，避免调用方误把旧结果用于新任务。
func (b *AssignmentBook) Lock(input Assignment) (Assignment, error) {
	if input.TaskID == "" || input.AgentID == "" || input.IdempotencyKey == "" {
		return Assignment{}, fmt.Errorf("assignment identifiers must not be empty")
	}
	if input.LockedAt.IsZero() || input.AcceptBy.IsZero() || !input.AcceptBy.After(input.LockedAt) {
		return Assignment{}, fmt.Errorf("accept deadline must be after lock time")
	}

	b.mu.Lock()
	defer b.mu.Unlock()

	if existing, ok := b.byIdempotency[input.IdempotencyKey]; ok {
		if existing.TaskID == input.TaskID && existing.AgentID == input.AgentID {
			return existing, nil
		}
		return Assignment{}, ErrIdempotencyKeyReused
	}
	if existing, ok := b.byTask[input.TaskID]; ok && isAssignmentActive(existing.Status) {
		return Assignment{}, ErrAssignmentAlreadyLocked
	}

	input.Status = AssignmentPendingAck
	if input.Version == 0 {
		input.Version = 1
	}
	input.RespondedAt = time.Time{}
	b.byTask[input.TaskID] = input
	b.byIdempotency[input.IdempotencyKey] = input
	return input, nil
}

// Acknowledge 将 Agent 的签名确认结果固化为终态。验签和请求幂等由协议层完成；
// 领域层仍校验响应者就是被分配的 Agent，避免正确签名更新错误任务。
func (b *AssignmentBook) Acknowledge(taskID, agentID string, accepted bool, respondedAt time.Time) (Assignment, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	assignment, ok := b.byTask[taskID]
	if !ok || assignment.AgentID != agentID {
		return Assignment{}, ErrAssignmentNotFound
	}
	if assignment.Status != AssignmentPendingAck {
		return Assignment{}, ErrAssignmentAlreadyFinal
	}
	if respondedAt.After(assignment.AcceptBy) {
		assignment.Status = AssignmentAcceptFailed
	} else if accepted {
		assignment.Status = AssignmentAccepted
	} else {
		assignment.Status = AssignmentAcceptFailed
	}
	assignment.RespondedAt = respondedAt
	b.replace(assignment)
	return assignment, nil
}

// Expire 只处理仍待确认且截止时间已到的分配。它返回本轮刚进入失败态的记录，
// 调用方据此发出任务回到待匹配的领域事件；重复扫描不会重复发出事件。
func (b *AssignmentBook) Expire(now time.Time) []Assignment {
	b.mu.Lock()
	defer b.mu.Unlock()

	expired := make([]Assignment, 0)
	for taskID, assignment := range b.byTask {
		if assignment.Status != AssignmentPendingAck || assignment.AcceptBy.After(now) {
			continue
		}
		assignment.Status = AssignmentAcceptFailed
		assignment.RespondedAt = now
		b.byTask[taskID] = assignment
		b.byIdempotency[assignment.IdempotencyKey] = assignment
		expired = append(expired, assignment)
	}
	return expired
}

func (b *AssignmentBook) replace(assignment Assignment) {
	b.byTask[assignment.TaskID] = assignment
	b.byIdempotency[assignment.IdempotencyKey] = assignment
}

func isAssignmentActive(status AssignmentStatus) bool {
	return status == AssignmentPendingAck || status == AssignmentAccepted
}
