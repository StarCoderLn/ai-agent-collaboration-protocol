package matchingv2

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"testing"
	"time"
)

// TestHTTPScorerAgainstLiveONNXService 验证 Go 正式排序适配器与真实 ONNX Runtime
// 进程的协议接缝。普通测试不会擅自启动外部进程；只有显式提供地址和版本时才执行。
func TestHTTPScorerAgainstLiveONNXService(t *testing.T) {
	modelURL := os.Getenv("MATCHING_V2_LIVE_MODEL_URL")
	modelVersion := os.Getenv("MATCHING_V2_LIVE_MODEL_VERSION")
	if modelURL == "" || modelVersion == "" {
		t.Skip("MATCHING_V2_LIVE_MODEL_URL and MATCHING_V2_LIVE_MODEL_VERSION are not configured")
	}
	scorer := &HTTPScorer{BaseURL: modelURL, Client: &http.Client{Timeout: 10 * time.Second}}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := scorer.CheckHealth(ctx, modelVersion); err != nil {
		t.Fatalf("live ONNX health contract failed: %v", err)
	}
	// 固定样本不读取数据库、不调用 Embeddings，也不包含用户内容；未见 Agent ID
	// 同时覆盖线上 UNK 路径和 Go 对三段漏斗概率关系的严格校验。
	payload := json.RawMessage(`{"featureSchemaVersion":"matching-v2.features.v1","candidates":[{"schemaVersion":"matching-v2.dataset.v1","dataOrigin":"real","taskId":"live-contract-task","agentId":"live-contract-unknown-agent","taskCategory":"research","agentCategory":"research","occurredAt":"2026-09-15T00:00:00Z","semanticSimilarity":0.9,"tagCoverage":1,"priceRatio":0.9,"qualityScore":4.5,"confidence":0,"responseMinutes":5,"currentLoad":0,"onTimeRate":0.8,"reworkRate":0.1,"disputeRate":0.02,"admissionScore":90,"position":1,"isNew":1}]}`)
	scores, err := scorer.Score(ctx, Claim{
		ModelVersion: modelVersion, FeatureSchemaVersion: FeatureSchemaVersion, RequestPayload: payload,
	})
	if err != nil {
		t.Fatalf("live ONNX score contract failed: %v", err)
	}
	if len(scores) != 1 || scores[0].AgentID != "live-contract-unknown-agent" || scores[0].ShadowRank != 1 {
		t.Fatalf("live ONNX returned an unexpected candidate set: %+v", scores)
	}
}
