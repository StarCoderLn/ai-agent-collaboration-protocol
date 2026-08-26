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

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/protocol"
)

const maxAgentResponseBytes = 1 << 20

type CallError struct {
	Code      string
	Retryable bool
}

func (e *CallError) Error() string { return e.Code }

type HTTPAgentCaller struct{ Client *http.Client }

func (c *HTTPAgentCaller) Call(ctx context.Context, message dispatch.DispatchMessage, target Target) (AgentResult, error) {
	if c.Client == nil || target.Endpoint == "" || target.Secret == "" || len(target.Body) == 0 {
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
	headers, err := protocol.Sign(protocol.SignRequest{Method: http.MethodPost, Path: path, Body: target.Body}, target.Secret, protocol.CallTypeProduction)
	if err != nil {
		return AgentResult{}, err
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
	request.Header.Set(protocol.HeaderProtocolVersion, headers.ProtocolVersion)
	request.Header.Set(protocol.HeaderTimestamp, headers.Timestamp)
	request.Header.Set(protocol.HeaderNonce, headers.Nonce)
	request.Header.Set(protocol.HeaderSignature, headers.Signature)
	request.Header.Set(protocol.HeaderCallType, string(headers.CallType))
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
	if response.StatusCode == http.StatusAccepted {
		return AgentResult{Accepted: nil}, nil
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

func dispatchIdempotencyKey(message dispatch.DispatchMessage) string {
	return "dispatch:" + message.TaskID + ":" + message.ProtocolRequestID
}
