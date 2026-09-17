package webhook

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"

	agentdelivery "github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/delivery"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/executionproxy"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/protocol"
)

const maxWebhookResponseBytes = 64 << 10

type ResultSubmitter interface {
	Forward(ctx context.Context, taskID, workflowNodeID, operation, idempotencyKey string, body []byte) (executionproxy.Response, error)
}

type HTTPSender struct {
	Client    *http.Client
	Submitter ResultSubmitter
}

type eventEnvelope struct {
	SchemaVersion string          `json:"schemaVersion"`
	EventID       string          `json:"eventId"`
	TaskID        string          `json:"taskId"`
	EventType     string          `json:"eventType"`
	StatusVersion string          `json:"statusVersion"`
	Payload       json.RawMessage `json:"payload"`
	CreatedAt     string          `json:"createdAt"`
}

func (s *HTTPSender) Send(ctx context.Context, delivery Delivery, secret string) error {
	if delivery.IntegrationMode == "http_json" {
		return s.sendQuickRework(ctx, delivery, secret)
	}
	if s.Client == nil || secret == "" {
		return errors.New("webhook sender is not configured")
	}
	endpoint, err := url.Parse(delivery.Endpoint)
	if err != nil || (endpoint.Scheme != "http" && endpoint.Scheme != "https") || endpoint.Host == "" ||
		endpoint.RawQuery != "" || endpoint.Fragment != "" || endpoint.User != nil {
		return &DeliveryError{Code: "AGENT_WEBHOOK_ENDPOINT_INVALID", Retryable: false}
	}
	body, err := json.Marshal(eventEnvelope{
		SchemaVersion: "task-event.v1",
		EventID:       delivery.TaskEventID,
		TaskID:        delivery.TaskID,
		EventType:     delivery.EventType,
		StatusVersion: delivery.StatusVersion,
		Payload:       json.RawMessage(delivery.Payload),
		// 固定 UTC + 毫秒精度，保证相同 outbox 记录每次重试都产生完全一致的签名 body。
		CreatedAt: delivery.EventCreatedAt.UTC().Format("2006-01-02T15:04:05.000Z"),
	})
	if err != nil {
		return &DeliveryError{Code: "WEBHOOK_PAYLOAD_INVALID", Retryable: false}
	}
	path := endpoint.EscapedPath()
	if path == "" {
		path = "/"
	}
	headers, err := protocol.Sign(
		protocol.SignRequest{Method: http.MethodPost, Path: path, Body: body}, secret, protocol.CallTypeProduction,
	)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", delivery.IdempotencyKey)
	request.Header.Set("X-Request-ID", delivery.TaskEventID)
	request.Header.Set(protocol.HeaderProtocolVersion, headers.ProtocolVersion)
	request.Header.Set(protocol.HeaderTimestamp, headers.Timestamp)
	request.Header.Set(protocol.HeaderNonce, headers.Nonce)
	request.Header.Set(protocol.HeaderSignature, headers.Signature)
	request.Header.Set(protocol.HeaderCallType, string(headers.CallType))
	response, err := s.Client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return &DeliveryError{Code: "CONN_TIMEOUT", Retryable: true}
	}
	defer response.Body.Close()
	responseBody, readErr := io.ReadAll(io.LimitReader(response.Body, maxWebhookResponseBytes+1))
	if readErr != nil {
		return &DeliveryError{Code: "WEBHOOK_RESPONSE_READ_FAILED", Retryable: true}
	}
	if len(responseBody) > maxWebhookResponseBytes {
		return &DeliveryError{Code: "WEBHOOK_RESPONSE_TOO_LARGE", Retryable: false}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &DeliveryError{
			Code: fmt.Sprintf("AGENT_HTTP_%d", response.StatusCode),
			Retryable: response.StatusCode == http.StatusRequestTimeout ||
				response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500,
		}
	}
	return nil
}

// sendQuickRework 把定向返工 outbox 转成 HTTP JSON Agent 已理解的 dispatch.v1，随后把
// 同步产物交回 Marketplace API。业务状态仍只由 TypeScript 事务更新；本 worker 负责
// 可重试的外部调用和转交，不在 Go 侧复制节点状态机。
func (s *HTTPSender) sendQuickRework(ctx context.Context, item Delivery, secret string) error {
	if s.Client == nil || s.Submitter == nil || item.EventType != "task.rework_requested" {
		return &DeliveryError{Code: "QUICK_REWORK_SENDER_NOT_CONFIGURED", Retryable: false}
	}
	var eventPayload struct {
		Dispatch       json.RawMessage `json:"dispatch"`
		WorkflowNodeID string          `json:"workflowNodeId"`
		RequestID      string          `json:"requestId"`
	}
	if err := json.Unmarshal(item.Payload, &eventPayload); err != nil || len(eventPayload.Dispatch) == 0 ||
		eventPayload.WorkflowNodeID == "" || eventPayload.RequestID == "" {
		return &DeliveryError{Code: "QUICK_REWORK_PAYLOAD_INVALID", Retryable: false}
	}
	var formalDispatch struct {
		AssignmentID string `json:"assignmentId"`
	}
	if err := json.Unmarshal(eventPayload.Dispatch, &formalDispatch); err != nil || formalDispatch.AssignmentID == "" {
		return &DeliveryError{Code: "QUICK_REWORK_PAYLOAD_INVALID", Retryable: false}
	}
	message := dispatch.DispatchMessage{
		AssignmentID:      formalDispatch.AssignmentID,
		TaskID:            item.TaskID,
		WorkflowNodeID:    eventPayload.WorkflowNodeID,
		AgentID:           item.AgentID,
		AttemptID:         item.ID,
		IdempotencyKey:    item.IdempotencyKey,
		ProtocolRequestID: eventPayload.RequestID,
	}
	result, err := (&agentdelivery.HTTPAgentCaller{Client: s.Client}).Call(ctx, message, agentdelivery.Target{
		Endpoint: item.Endpoint, Secret: secret, Body: eventPayload.Dispatch, IntegrationMode: "http_json",
	})
	if err != nil {
		var callErr *agentdelivery.CallError
		if errors.As(err, &callErr) {
			return &DeliveryError{Code: callErr.Code, Retryable: callErr.Retryable}
		}
		return err
	}
	if len(result.QuickResultPayload) == 0 {
		return &DeliveryError{Code: "QUICK_REWORK_RESULT_MISSING", Retryable: false}
	}
	response, err := s.Submitter.Forward(
		ctx,
		item.TaskID,
		eventPayload.WorkflowNodeID,
		"results",
		"quick-rework-result:"+item.TaskID+":"+eventPayload.RequestID,
		result.QuickResultPayload,
	)
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &DeliveryError{
			Code:      fmt.Sprintf("QUICK_REWORK_RESULT_HTTP_%d", response.StatusCode),
			Retryable: response.StatusCode == http.StatusRequestTimeout || response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500,
		}
	}
	return nil
}
