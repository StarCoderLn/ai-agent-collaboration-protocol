// agenthealth 包负责定时探测 Agent 的连通性。它只接受专用健康探测结果，真实任务失败
// 不能进入生命周期熔断器，避免把业务执行问题误判为 Agent 离线。
package agenthealth

import (
	"context"
	"errors"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
)

// Claim 是完成一次探测所需最小数据的租约快照。凭证在 worker 即将发起网络调用前
// 始终保持加密状态，避免明文跨越不必要的处理边界。
type Claim struct {
	AgentID             string
	LockToken           string
	Endpoint            string
	IntegrationMode     string
	EncryptedCredential string
}

type Observation struct {
	Result     domain.ProbeResult
	ResultCode string
}

type Repository interface {
	ClaimDue(ctx context.Context, now time.Time, lease time.Duration, limit int) ([]Claim, error)
	Complete(ctx context.Context, claim Claim, observation Observation, checkedAt time.Time) (domain.HealthOutcome, error)
	Release(ctx context.Context, claim Claim, retryAt time.Time) error
}

type CredentialDecryptor interface {
	DecryptCredential(ctx context.Context, encrypted string) (string, error)
}

type Prober interface {
	Probe(ctx context.Context, agentID, endpoint, secret, integrationMode string) Observation
}

type RunResult struct {
	Claimed     int
	Completed   int
	Transitions int
}

type Worker struct {
	Repository Repository
	Decryptor  CredentialDecryptor
	Prober     Prober
	Now        func() time.Time
	Lease      time.Duration
}

// RunOnce 处理一批数量受限且已取得租约的探测。凭证或 KMS 失败属于平台故障，因此只
// 释放租约并安排短暂重试，不写入虚假的 Agent 健康结果，也不消耗 Agent 连续失败阈值。
func (w *Worker) RunOnce(ctx context.Context, limit int) (RunResult, error) {
	if w.Repository == nil || w.Decryptor == nil || w.Prober == nil || limit <= 0 {
		return RunResult{}, errors.New("agent health worker requires repository, decryptor, prober and positive limit")
	}
	now := time.Now().UTC()
	if w.Now != nil {
		now = w.Now()
	}
	lease := w.Lease
	if lease <= 0 {
		lease = 30 * time.Second
	}
	claims, err := w.Repository.ClaimDue(ctx, now, lease, limit)
	if err != nil {
		return RunResult{}, err
	}
	result := RunResult{Claimed: len(claims)}
	var combined error
	for _, claim := range claims {
		secret := ""
		if claim.EncryptedCredential != "" {
			var decryptErr error
			secret, decryptErr = w.Decryptor.DecryptCredential(ctx, claim.EncryptedCredential)
			if decryptErr != nil {
				combined = errors.Join(combined, decryptErr, w.Repository.Release(ctx, claim, now.Add(time.Minute)))
				continue
			}
		} else if claim.IntegrationMode != "http_json" {
			combined = errors.Join(combined, errors.New("signed Agent health credential is unavailable"), w.Repository.Release(ctx, claim, now.Add(time.Minute)))
			continue
		}
		observation := w.Prober.Probe(ctx, claim.AgentID, claim.Endpoint, secret, claim.IntegrationMode)
		// 明文 secret 只活到单次网络调用结束，不进入结果、错误或日志。
		secret = ""
		if ctx.Err() != nil {
			combined = errors.Join(combined, ctx.Err())
			break
		}
		outcome, completeErr := w.Repository.Complete(ctx, claim, observation, now)
		if completeErr != nil {
			combined = errors.Join(combined, completeErr)
			continue
		}
		result.Completed++
		if outcome.Transitioned {
			result.Transitions++
		}
	}
	return result, combined
}
