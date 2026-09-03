package delivery

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/protocol"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/quickagent"
)

const maxAgentResponseBytes = 1 << 20

type CallError struct {
	Code      string
	Retryable bool
}

func (e *CallError) Error() string { return e.Code }

type HTTPAgentCaller struct{ Client *http.Client }

func (c *HTTPAgentCaller) Call(ctx context.Context, message dispatch.DispatchMessage, target Target) (AgentResult, error) {
	if c.Client == nil || target.Endpoint == "" || len(target.Body) == 0 {
		return AgentResult{}, errors.New("agent call target is incomplete")
	}
	integrationMode := target.IntegrationMode
	if integrationMode == "" {
		// 迁移前的调用者与单元测试未携带模式时继续使用原 HMAC 行为。
		integrationMode = "aicp_hmac"
	}
	if integrationMode != "aicp_hmac" && integrationMode != "http_json" {
		return AgentResult{}, errors.New("agent integration mode is invalid")
	}
	if integrationMode == "aicp_hmac" && target.Secret == "" {
		return AgentResult{}, errors.New("agent call target is incomplete")
	}
	if message.TaskID == "" || message.ProtocolRequestID == "" {
		return AgentResult{}, errors.New("agent call message is incomplete")
	}
	endpoint, err := url.Parse(target.Endpoint)
	if err != nil || (endpoint.Scheme != "http" && endpoint.Scheme != "https") || endpoint.Host == "" || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return AgentResult{}, &CallError{Code: "AGENT_ENDPOINT_INVALID", Retryable: false}
	}
	path := endpoint.EscapedPath()
	if path == "" {
		path = "/"
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(target.Body))
	if err != nil {
		return AgentResult{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	// 面向发布者的候选确认键与平台调用 Agent 的派发键属于不同幂等域。前者刻意保持
	// 不透明，可能只有两段（例如 `assign:<client-id>`）；协议 v1 则要求
	// `{operation}:{taskId}:{clientGeneratedId}`。下游键必须由稳定派发标识生成，确保每次
	// 重试都重放同一个 Agent 操作，同时不把 UI 的键命名约定泄漏给外部 Agent。
	request.Header.Set("Idempotency-Key", dispatchIdempotencyKey(message))
	request.Header.Set("X-Request-ID", message.ProtocolRequestID)
	if integrationMode == "aicp_hmac" {
		headers, signErr := protocol.Sign(protocol.SignRequest{Method: http.MethodPost, Path: path, Body: target.Body}, target.Secret, protocol.CallTypeProduction)
		if signErr != nil {
			return AgentResult{}, signErr
		}
		request.Header.Set(protocol.HeaderProtocolVersion, headers.ProtocolVersion)
		request.Header.Set(protocol.HeaderTimestamp, headers.Timestamp)
		request.Header.Set(protocol.HeaderNonce, headers.Nonce)
		request.Header.Set(protocol.HeaderSignature, headers.Signature)
		request.Header.Set(protocol.HeaderCallType, string(headers.CallType))
	} else if target.Secret != "" {
		// 快速接入的访问密钥是提供者已有的 Bearer Token，不是平台 HMAC 密钥。
		request.Header.Set("Authorization", "Bearer "+target.Secret)
	}
	response, err := c.Client.Do(request)
	if err != nil {
		return AgentResult{}, &CallError{Code: "CONN_TIMEOUT", Retryable: true}
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxAgentResponseBytes+1))
	if err != nil {
		return AgentResult{}, &CallError{Code: "AGENT_RESPONSE_READ_FAILED", Retryable: true}
	}
	if len(body) > maxAgentResponseBytes {
		return AgentResult{}, &CallError{Code: "AGENT_RESPONSE_TOO_LARGE", Retryable: false}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return AgentResult{}, &CallError{
			Code:      fmt.Sprintf("AGENT_HTTP_%d", response.StatusCode),
			Retryable: response.StatusCode == http.StatusRequestTimeout || response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500,
		}
	}
	// HTTP 202 只表示 Agent 已持久化排队该请求。业务接单结果随后通过签名确认回调到达；
	// 如果把旧版 `{"accepted":true}` 正文当成同步接单，就会与真实回调竞态，并导致 Agent
	// 收到 ASSIGNMENT_ALREADY_FINAL 后中止执行。
	if response.StatusCode == http.StatusAccepted && integrationMode == "aicp_hmac" {
		return AgentResult{Accepted: nil}, nil
	}
	if integrationMode == "http_json" {
		if response.StatusCode == http.StatusAccepted {
			return AgentResult{}, &CallError{Code: "QUICK_AGENT_ASYNC_UNSUPPORTED", Retryable: false}
		}
		return quickAgentResult(message, body)
	}
	var acknowledgement struct {
		Accepted *bool `json:"accepted"`
	}
	if len(bytes.TrimSpace(body)) > 0 {
		if err = json.Unmarshal(body, &acknowledgement); err != nil {
			return AgentResult{}, &CallError{Code: "AGENT_RESPONSE_INVALID", Retryable: false}
		}
	}
	if acknowledgement.Accepted == nil {
		return AgentResult{}, &CallError{Code: "AGENT_ACK_MISSING", Retryable: false}
	}
	return AgentResult{Accepted: acknowledgement.Accepted}, nil
}

// quickAgentResult 把面向提供者的简单产物协议转换成 Business API 已有的
// 验收输入。Agent 不需要知道 agentId、assignmentId、USDC 或工作流状态。
func quickAgentResult(message dispatch.DispatchMessage, body []byte) (AgentResult, error) {
	artifacts, err := quickagent.ParseResponse(body)
	if err != nil {
		return AgentResult{}, &CallError{Code: "AGENT_RESPONSE_INVALID", Retryable: false}
	}
	results := make([]map[string]any, 0, len(artifacts))
	generatedAt := time.Now().UTC().Format(time.RFC3339Nano)
	for _, artifact := range artifacts {
		mapped, err := mapQuickArtifact(artifact, generatedAt)
		if err != nil {
			return AgentResult{}, err
		}
		results = append(results, mapped)
	}
	payload, err := json.Marshal(map[string]any{
		"agentId": message.AgentID, "assignmentId": message.AssignmentID, "results": results,
	})
	if err != nil {
		return AgentResult{}, err
	}
	accepted := true
	return AgentResult{Accepted: &accepted, QuickResultPayload: payload}, nil
}

func mapQuickArtifact(artifact quickagent.Artifact, generatedAt string) (map[string]any, error) {
	if artifact.Summary == "" || len(artifact.Content) == 0 {
		return nil, &CallError{Code: "AGENT_RESPONSE_INVALID", Retryable: false}
	}
	var content any
	if err := json.Unmarshal(artifact.Content, &content); err != nil {
		return nil, &CallError{Code: "AGENT_RESPONSE_INVALID", Retryable: false}
	}
	contentText, isText := content.(string)
	if !isText {
		encoded, err := json.Marshal(content)
		if err != nil {
			return nil, &CallError{Code: "AGENT_RESPONSE_INVALID", Retryable: false}
		}
		contentText = string(encoded)
	}
	result := map[string]any{"summary": artifact.Summary, "generatedAt": generatedAt}
	switch artifact.Type {
	case "document":
		result["kind"], result["mimeType"], result["content"] = "inline", defaultString(artifact.MIMEType, "text/markdown"), contentText
	case "code":
		result["kind"], result["mimeType"], result["content"] = "inline", defaultString(artifact.MIMEType, "text/plain"), contentText
	case "json":
		result["kind"], result["mimeType"], result["content"] = "inline", "application/json", contentText
	case "website":
		if isHTTPReference(contentText) {
			result["kind"], result["mimeType"], result["storageRef"], result["sizeBytes"] = "file", defaultString(artifact.MIMEType, "text/html"), contentText, "0"
		} else {
			result["kind"], result["mimeType"], result["content"] = "inline", defaultString(artifact.MIMEType, "text/html"), contentText
		}
	case "image":
		if !isHTTPReference(contentText) {
			return nil, &CallError{Code: "AGENT_RESPONSE_INVALID", Retryable: false}
		}
		result["kind"], result["mimeType"], result["storageRef"], result["sizeBytes"] = "file", defaultString(artifact.MIMEType, "image/png"), contentText, "0"
	case "video":
		if !isHTTPReference(contentText) {
			return nil, &CallError{Code: "AGENT_RESPONSE_INVALID", Retryable: false}
		}
		result["kind"], result["mimeType"], result["storageRef"], result["sizeBytes"] = "file", defaultString(artifact.MIMEType, "video/mp4"), contentText, "0"
	default:
		return nil, &CallError{Code: "AGENT_RESPONSE_INVALID", Retryable: false}
	}
	return result, nil
}

func defaultString(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

func isHTTPReference(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != ""
}

func dispatchIdempotencyKey(message dispatch.DispatchMessage) string {
	return "dispatch:" + message.TaskID + ":" + message.ProtocolRequestID
}
