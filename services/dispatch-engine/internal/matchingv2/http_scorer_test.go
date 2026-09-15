package matchingv2

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

// TestHTTPScorerAcceptsCompleteESMMResponse 固定一组满足乘法关系的概率，证明合法响应
// 不会被严格校验误拒绝。
func TestHTTPScorerAcceptsCompleteESMMResponse(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodPost || request.URL.Path != "/score" {
			t.Fatalf("unexpected model request: %s %s", request.Method, request.URL.Path)
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"modelVersion":"matching-v2-20260914000000-12345678","scores":[{"agentId":"agent-a","pctr":0.5,"pcvr":0.4,"pctcvr":0.2,"shadowRank":1}]}`))}, nil
	})}
	payload, _ := json.Marshal(map[string]any{
		"featureSchemaVersion": FeatureSchemaVersion,
		"candidates":           []map[string]any{{"agentId": "agent-a"}},
	})
	scorer := HTTPScorer{BaseURL: "http://model.local", Client: client}
	scores, err := scorer.Score(context.Background(), Claim{
		ModelVersion: "matching-v2-20260914000000-12345678", FeatureSchemaVersion: FeatureSchemaVersion,
		RequestPayload: payload,
	})
	if err != nil || len(scores) != 1 || scores[0].PCTCVR != 0.2 {
		t.Fatalf("valid response rejected: scores=%+v err=%v", scores, err)
	}
}

// TestHTTPScorerRejectsInconsistentFunnelProbability 防止模型自由返回与 pCTR*pCVR 不一致
// 的联合概率，否则排序值与页面解释会表达两套互相矛盾的语义。
func TestHTTPScorerRejectsInconsistentFunnelProbability(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"modelVersion":"matching-v2-20260914000000-12345678","scores":[{"agentId":"agent-a","pctr":0.5,"pcvr":0.4,"pctcvr":0.5,"shadowRank":1}]}`))}, nil
	})}
	payload := json.RawMessage(`{"featureSchemaVersion":"matching-v2.features.v1","candidates":[{"agentId":"agent-a"}]}`)
	scorer := HTTPScorer{BaseURL: "http://model.local", Client: client}
	_, err := scorer.Score(context.Background(), Claim{
		ModelVersion: "matching-v2-20260914000000-12345678", FeatureSchemaVersion: FeatureSchemaVersion,
		RequestPayload: payload,
	})
	if scorer.FailureCode(err) != "MATCHING_V2_RESPONSE_INVALID" {
		t.Fatalf("inconsistent pCTCVR was accepted: %v", err)
	}
}

// TestHTTPScorerRejectsTrailingJSONValue 覆盖标准 Decoder 容易忽略的第二个 JSON 文档。
func TestHTTPScorerRejectsTrailingJSONValue(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		body := `{"modelVersion":"matching-v2-20260914000000-12345678","scores":[{"agentId":"agent-a","pctr":0.5,"pcvr":0.4,"pctcvr":0.2,"shadowRank":1}]} {"unexpected":true}`
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	payload := json.RawMessage(`{"featureSchemaVersion":"matching-v2.features.v1","candidates":[{"agentId":"agent-a"}]}`)
	scorer := HTTPScorer{BaseURL: "http://model.local", Client: client}
	_, err := scorer.Score(context.Background(), Claim{
		ModelVersion: "matching-v2-20260914000000-12345678", FeatureSchemaVersion: FeatureSchemaVersion,
		RequestPayload: payload,
	})
	if scorer.FailureCode(err) != "MATCHING_V2_RESPONSE_INVALID" {
		t.Fatalf("尾随 JSON 值未被拒绝: %v", err)
	}
}

// TestHTTPScorerHealthRejectsAmbiguousResponse 确保模型发布门也执行唯一 JSON 文档约束。
func TestHTTPScorerHealthRejectsAmbiguousResponse(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Body: io.NopCloser(strings.NewReader(
				`{"status":"ok","modelVersion":"matching-v2-20260914000000-12345678"} {"status":"ok"}`,
			)),
		}, nil
	})}
	scorer := HTTPScorer{BaseURL: "http://model.local", Client: client}
	if err := scorer.CheckHealth(context.Background(), "matching-v2-20260914000000-12345678"); scorer.FailureCode(err) != "MATCHING_V2_MODEL_VERSION_MISMATCH" {
		t.Fatalf("含第二个 JSON 值的健康响应未被拒绝: %v", err)
	}
}
