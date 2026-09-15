// Package matchingfeedback 记录 V2 训练所需的真实候选曝光。它只接受已经冻结在
// JobDistributionRecord 中的候选，不能创建候选、改变顺序或推进任何任务状态。
package matchingfeedback

import (
	"context"
	"errors"
	"strings"
	"time"
)

var (
	// ErrInvalidExposure 表示请求自身缺字段、越界或时间不可信，调用方不应原样重试。
	ErrInvalidExposure = errors.New("matching exposure is invalid")
	// ErrExposureDenied 表示请求引用的任务、节点、候选或位置不属于同一冻结快照。
	ErrExposureDenied = errors.New("matching exposure does not reference a frozen candidate")
)

// Exposure 是浏览器观察到的一次候选可见事实。业务身份和候选归属仍由服务端仓储
// 重新验证，不能因为客户端提供了这些字段就直接相信。
type Exposure struct {
	// EventKey 在一次页面会话内稳定，数据库以它收敛网络重试。
	EventKey             string
	ViewSessionID        string
	DistributionRecordID string
	TaskID               string
	WorkflowNodeID       string
	AgentID              string
	ActorID              string
	Position             int
	VisibleMillis        int
	OccurredAt           time.Time
}

// Repository 隐藏冻结候选校验和 PostgreSQL 幂等写入，领域服务只负责通用边界校验。
type Repository interface {
	RecordExposure(context.Context, Exposure) error
}

// Service 统一普通任务和工作流节点的曝光时间语义。Now 只用于确定性测试；生产为空。
type Service struct {
	Repository Repository
	Now        func() time.Time
}

// RecordExposure 校验浏览器时间的合理范围，但以数据库 created_at 作为接收审计时间。
// 最长允许 24 小时离线重试，未来偏差限制为 5 分钟，避免伪造远期曝光污染时间切分。
func (s *Service) RecordExposure(ctx context.Context, exposure Exposure) error {
	if s == nil || s.Repository == nil || strings.TrimSpace(exposure.ActorID) == "" ||
		len(exposure.EventKey) < 16 || len(exposure.EventKey) > 200 ||
		exposure.ViewSessionID == "" || exposure.DistributionRecordID == "" || exposure.TaskID == "" || exposure.AgentID == "" ||
		exposure.Position < 1 || exposure.Position > 100 || exposure.VisibleMillis < 1000 || exposure.VisibleMillis > 600000 ||
		exposure.OccurredAt.IsZero() {
		return ErrInvalidExposure
	}
	now := time.Now().UTC()
	if s.Now != nil {
		now = s.Now().UTC()
	}
	occurredAt := exposure.OccurredAt.UTC()
	// 允许短时离线和客户端时钟偏差，但拒绝会改变训练时间切分的陈旧或未来事件。
	if occurredAt.Before(now.Add(-24*time.Hour)) || occurredAt.After(now.Add(5*time.Minute)) {
		return ErrInvalidExposure
	}
	exposure.ActorID = strings.TrimSpace(exposure.ActorID)
	exposure.OccurredAt = occurredAt
	return s.Repository.RecordExposure(ctx, exposure)
}
