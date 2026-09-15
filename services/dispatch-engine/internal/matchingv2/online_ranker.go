package matchingv2

import (
	"context"
	"encoding/json"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/matching"
)

// OnlineRanker 把现有严格 HTTP Scorer 适配为正式 Matching V2 的同步排序接口。候选集合、
// 概率范围和 pCTCVR 乘法关系仍由 HTTPScorer 在返回匹配层之前统一校验。
type OnlineRanker struct {
	Scorer  *HTTPScorer
	Version string
}

func (r *OnlineRanker) ModelVersion() string { return r.Version }

func (r *OnlineRanker) Rank(ctx context.Context, payload json.RawMessage) ([]matching.FunnelScore, error) {
	scores, err := r.Scorer.Score(ctx, Claim{
		ModelVersion: r.Version, FeatureSchemaVersion: FeatureSchemaVersion, RequestPayload: payload,
	})
	if err != nil {
		return nil, err
	}
	result := make([]matching.FunnelScore, 0, len(scores))
	for _, score := range scores {
		result = append(result, matching.FunnelScore{
			AgentID: score.AgentID, PCTR: score.PCTR, PCVR: score.PCVR,
			PCTCVR: score.PCTCVR, Rank: score.ShadowRank,
		})
	}
	return result, nil
}
