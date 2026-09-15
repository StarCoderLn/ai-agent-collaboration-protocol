// Package matchingv2 承载 V2 影子推理的可靠执行边界。它只消费匹配事务冻结的私有
// 召回池并保存对照分数，不能改写正式 candidates、选人结果或任何资金状态。
package matchingv2

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

const FeatureSchemaVersion = "matching-v2.features.v1"

// Claim 是一次带租约的影子评分任务。LockToken 绑定本次领取者，旧 Worker 超时返回后
// 不能覆盖已经被新 Worker 重新领取并完成的结果。
type Claim struct {
	JobID                string
	DistributionRecordID string
	LockToken            string
	AttemptNo            int
	ModelVersion         string
	FeatureSchemaVersion string
	RequestPayload       json.RawMessage
}

// Score 保存 ESMM 的三个可解释概率与本模型版本内的影子名次。
type Score struct {
	AgentID    string  `json:"agentId"`
	PCTR       float64 `json:"pctr"`
	PCVR       float64 `json:"pcvr"`
	PCTCVR     float64 `json:"pctcvr"`
	ShadowRank int     `json:"shadowRank"`
}

// Repository 把领取、完成和失败重试收敛为持久化状态机，允许 Worker 保持无状态。
type Repository interface {
	Claim(context.Context, time.Time, time.Duration) (Claim, bool, error)
	Complete(context.Context, Claim, []Score, time.Time) error
	Fail(context.Context, Claim, string, time.Time) error
}

// Scorer 隔离模型传输协议。FailureCode 必须返回稳定类别，不能泄露原始响应正文。
type Scorer interface {
	Score(context.Context, Claim) ([]Score, error)
	FailureCode(error) string
}

// Worker 每次只消费一个影子任务。Now 和 Lease 可注入以验证租约过期与重试边界。
type Worker struct {
	Repository Repository
	Scorer     Scorer
	Now        func() time.Time
	Lease      time.Duration
}

// RunOnce 最多领取一个任务，便于多实例用 PostgreSQL SKIP LOCKED 自然分片。推理失败
// 只推进影子任务自身的有限重试，永远不向正式匹配调用栈返回失败。
func (w *Worker) RunOnce(ctx context.Context) (bool, error) {
	if w == nil || w.Repository == nil || w.Scorer == nil {
		return false, errors.New("matching V2 worker is not configured")
	}
	now := time.Now().UTC()
	if w.Now != nil {
		now = w.Now().UTC()
	}
	lease := w.Lease
	if lease <= 0 {
		lease = 30 * time.Second
	}
	// Claim 使用 SKIP LOCKED 后，多实例无需进程级协调即可安全并行消费。
	claim, claimed, err := w.Repository.Claim(ctx, now, lease)
	if err != nil || !claimed {
		return claimed, err
	}
	scores, scoreErr := w.Scorer.Score(ctx, claim)
	if scoreErr != nil {
		// 失败只更新影子任务；返回的 repository 错误用于暴露“连失败状态也没写成”的情况。
		return true, w.Repository.Fail(ctx, claim, w.Scorer.FailureCode(scoreErr), now)
	}
	return true, w.Repository.Complete(ctx, claim, scores, now)
}
