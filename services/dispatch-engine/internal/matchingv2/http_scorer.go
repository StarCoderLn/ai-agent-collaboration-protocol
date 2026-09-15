package matchingv2

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
)

type scorerError struct {
	// code 是允许持久化和聚合的稳定类别；err 只留在进程内用于诊断。
	code string
	err  error
}

func (e *scorerError) Error() string { return e.code }
func (e *scorerError) Unwrap() error { return e.err }

// HTTPScorer 是 Dispatch Engine 到独立 Python 模型服务的窄适配器。它负责传输与响应
// 契约校验，不读取任务数据库，也不决定正式候选是否可选。
type HTTPScorer struct {
	BaseURL string
	Client  *http.Client
}

// scoreResponse 明确禁止模型服务返回额外字段；协议演进必须升级双方契约和特征版本。
type scoreResponse struct {
	ModelVersion string  `json:"modelVersion"`
	Scores       []Score `json:"scores"`
}

// CheckHealth 在数据库切换 shadow 前确认当前 HTTP 进程实际加载了同一版本，避免注册表
// 与内存制品漂移后让所有任务进入可预防的重试。
func (s *HTTPScorer) CheckHealth(ctx context.Context, expectedVersion string) error {
	if s == nil || s.Client == nil || strings.TrimSpace(s.BaseURL) == "" || expectedVersion == "" {
		return &scorerError{code: "MATCHING_V2_SCORER_NOT_CONFIGURED"}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(s.BaseURL, "/")+"/health", nil)
	if err != nil {
		return &scorerError{code: "MATCHING_V2_REQUEST_INVALID", err: err}
	}
	response, err := s.Client.Do(request)
	if err != nil {
		return &scorerError{code: "MATCHING_V2_MODEL_UNAVAILABLE", err: err}
	}
	defer response.Body.Close()
	var body struct {
		Status       string `json:"status"`
		ModelVersion string `json:"modelVersion"`
	}
	// 健康响应只有两个短字段，限制为 4 KiB 可防止异常上游造成无界读取。
	decoder := json.NewDecoder(io.LimitReader(response.Body, 4096))
	decoder.DisallowUnknownFields()
	if response.StatusCode != http.StatusOK || decoder.Decode(&body) != nil || ensureJSONEOF(decoder) != nil || body.Status != "ok" || body.ModelVersion != expectedVersion {
		return &scorerError{code: "MATCHING_V2_MODEL_VERSION_MISMATCH"}
	}
	return nil
}

// Score 同时校验请求候选集合和模型响应的不变量。模型服务即使返回 200，也不能插入
// 缺失、重复、越界或不满足 pCTCVR=pCTR×pCVR 的分数。
func (s *HTTPScorer) Score(ctx context.Context, claim Claim) ([]Score, error) {
	if s == nil || s.Client == nil || strings.TrimSpace(s.BaseURL) == "" || claim.ModelVersion == "" {
		return nil, &scorerError{code: "MATCHING_V2_SCORER_NOT_CONFIGURED"}
	}
	var request struct {
		FeatureSchemaVersion string `json:"featureSchemaVersion"`
		Candidates           []struct {
			AgentID string `json:"agentId"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal(claim.RequestPayload, &request); err != nil || request.FeatureSchemaVersion != claim.FeatureSchemaVersion || len(request.Candidates) == 0 {
		return nil, &scorerError{code: "MATCHING_V2_REQUEST_INVALID", err: err}
	}
	// expected 同时用于拒绝重复请求候选，并在响应验证时执行集合消减；最终必须为空。
	expected := make(map[string]struct{}, len(request.Candidates))
	for _, candidate := range request.Candidates {
		if candidate.AgentID == "" {
			return nil, &scorerError{code: "MATCHING_V2_REQUEST_INVALID"}
		}
		expected[candidate.AgentID] = struct{}{}
	}
	if len(expected) != len(request.Candidates) {
		return nil, &scorerError{code: "MATCHING_V2_REQUEST_INVALID"}
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(s.BaseURL, "/")+"/score", bytes.NewReader(claim.RequestPayload))
	if err != nil {
		return nil, &scorerError{code: "MATCHING_V2_REQUEST_INVALID", err: err}
	}
	httpRequest.Header.Set("content-type", "application/json")
	response, err := s.Client.Do(httpRequest)
	if err != nil {
		return nil, &scorerError{code: "MATCHING_V2_MODEL_UNAVAILABLE", err: err}
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		// 消耗有限响应体以便 HTTP 连接复用，但不把模型错误正文带入日志或数据库。
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil, &scorerError{code: "MATCHING_V2_MODEL_REJECTED", err: fmt.Errorf("status %d", response.StatusCode)}
	}
	var decoded scoreResponse
	decoder := json.NewDecoder(io.LimitReader(response.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&decoded); err != nil {
		return nil, &scorerError{code: "MATCHING_V2_RESPONSE_INVALID", err: err}
	}
	// Decode 成功只代表首个 JSON 值合法；显式读取到 EOF，防止模型服务或代理在
	// 合法响应后拼接第二个值，而调用方静默接受语义不明确的响应。
	if err = ensureJSONEOF(decoder); err != nil || decoded.ModelVersion != claim.ModelVersion || len(decoded.Scores) != len(expected) {
		return nil, &scorerError{code: "MATCHING_V2_RESPONSE_INVALID", err: err}
	}
	// Agent 集合、概率关系和 rank 排列全部在写库前验证，避免部分可信响应污染影子表。
	seenRanks := make(map[int]struct{}, len(decoded.Scores))
	for _, score := range decoded.Scores {
		if _, ok := expected[score.AgentID]; !ok {
			return nil, &scorerError{code: "MATCHING_V2_RESPONSE_INVALID"}
		}
		delete(expected, score.AgentID)
		if !probability(score.PCTR) || !probability(score.PCVR) || !probability(score.PCTCVR) ||
			math.Abs(score.PCTR*score.PCVR-score.PCTCVR) > 1e-5 || score.ShadowRank < 1 || score.ShadowRank > len(decoded.Scores) {
			return nil, &scorerError{code: "MATCHING_V2_RESPONSE_INVALID"}
		}
		if _, duplicate := seenRanks[score.ShadowRank]; duplicate {
			return nil, &scorerError{code: "MATCHING_V2_RESPONSE_INVALID"}
		}
		seenRanks[score.ShadowRank] = struct{}{}
	}
	if len(expected) != 0 {
		return nil, &scorerError{code: "MATCHING_V2_RESPONSE_INVALID"}
	}
	return decoded.Scores, nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	// Decoder.Decode 只消费第一个 JSON 值；第二次读取必须得到 EOF 才是唯一无歧义文档。
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("响应包含额外 JSON 值")
		}
		return err
	}
	return nil
}

func (s *HTTPScorer) FailureCode(err error) string {
	// 未知错误收敛为固定类别，禁止将网络地址、响应正文或库错误直接持久化。
	var classified *scorerError
	if errors.As(err, &classified) {
		return classified.code
	}
	return "MATCHING_V2_UNKNOWN_FAILURE"
}

func probability(value float64) bool {
	// 普通区间比较无法可靠拒绝 NaN，因此必须先显式排除 NaN 和正负无穷。
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= 1
}
