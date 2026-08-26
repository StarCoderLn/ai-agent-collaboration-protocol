package sandboxadmission

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/protocol"
)

const maxSandboxResponseBytes = 1 << 20

type HTTPCaller struct {
	Client *http.Client
	Now    func() time.Time
}

func (c *HTTPCaller) Call(ctx context.Context, input CallRequest) (CallOutcome, error) {
	if c.Client == nil || input.Secret == "" || len(input.Body) == 0 || input.IdempotencyKey == "" {
		return CallOutcome{}, errors.New("sandbox HTTP caller is not configured")
	}
	endpoint, err := url.Parse(input.Endpoint)
	if err != nil || (endpoint.Scheme != "http" && endpoint.Scheme != "https") || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return failedOutcome(0, 0, string(protocol.ErrCodeProtocolVersionUnsupported), nil, false, 0), nil
	}
	path := endpoint.EscapedPath()
	if path == "" {
		path = "/"
	}
	headers, err := protocol.Sign(
		protocol.SignRequest{Method: http.MethodPost, Path: path, Body: input.Body},
		input.Secret,
		protocol.CallTypeSandbox,
	)
	if err != nil {
		return CallOutcome{}, errors.New("sandbox request signing failed")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(input.Body))
	if err != nil {
		return CallOutcome{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", input.IdempotencyKey)
	request.Header.Set("X-Request-ID", input.RoundID+"-"+input.IdempotencyKey[len(input.IdempotencyKey)-1:])
	request.Header.Set(protocol.HeaderProtocolVersion, headers.ProtocolVersion)
	request.Header.Set(protocol.HeaderTimestamp, headers.Timestamp)
	request.Header.Set(protocol.HeaderNonce, headers.Nonce)
	request.Header.Set(protocol.HeaderSignature, headers.Signature)
	request.Header.Set(protocol.HeaderCallType, string(headers.CallType))

	startedAt := c.now()
	response, err := c.Client.Do(request)
	latency := elapsedMilliseconds(startedAt, c.now())
	if err != nil {
		if ctx.Err() != nil {
			return CallOutcome{}, ctx.Err()
		}
		return failedOutcome(latency, 0, string(protocol.ErrCodeConnTimeout), nil, false, 0), nil
	}
	defer response.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(response.Body, maxSandboxResponseBytes+1))
	status := response.StatusCode
	if readErr != nil || len(body) > maxSandboxResponseBytes {
		return failedOutcome(latency, status, string(protocol.ErrCodeAgentInternalError), nil, false, int64(len(body))), nil
	}
	outputRef := inlineOutputReference(response.Header.Get("Content-Type"), body)
	if status >= 200 && status < 300 {
		if !validJSONObject(body) {
			return failedOutcome(latency, status, string(protocol.ErrCodeAgentInternalError), outputRef, false, int64(len(body))), nil
		}
		return CallOutcome{
			Succeeded: true,
			OutputRef: outputRef,
			Metrics: TechnicalMetrics{
				ProtocolCompliant: true, LatencyMS: latency, HTTPStatus: &status,
				ResponseBytes: int64(len(body)),
			},
		}, nil
	}
	errorCategory, compliant := classifyErrorResponse(status, body)
	return failedOutcome(latency, status, errorCategory, outputRef, compliant, int64(len(body))), nil
}

func (c *HTTPCaller) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func failedOutcome(latency int64, status int, category string, outputRef *string, compliant bool, responseBytes int64) CallOutcome {
	var httpStatus *int
	if status > 0 {
		httpStatus = &status
	}
	return CallOutcome{
		Succeeded: false,
		OutputRef: outputRef,
		Metrics: TechnicalMetrics{
			ProtocolCompliant: compliant, LatencyMS: latency, ErrorCategory: &category,
			HTTPStatus: httpStatus, ResponseBytes: responseBytes,
		},
	}
}

func validJSONObject(body []byte) bool {
	var value map[string]any
	return len(bytes.TrimSpace(body)) > 0 && json.Unmarshal(body, &value) == nil && value != nil
}

func classifyErrorResponse(status int, body []byte) (string, bool) {
	var payload struct {
		ErrorCode string `json:"error_code"`
		Message   string `json:"message"`
		Retryable *bool  `json:"retryable"`
	}
	if json.Unmarshal(body, &payload) == nil && payload.Message != "" && payload.Retryable != nil && protocolErrorRetryable(payload.ErrorCode, *payload.Retryable) {
		return payload.ErrorCode, true
	}
	if status == http.StatusUnauthorized {
		return string(protocol.ErrCodeAuthInvalidSignature), false
	}
	if status == http.StatusRequestTimeout || status == http.StatusGatewayTimeout {
		return string(protocol.ErrCodeConnTimeout), false
	}
	return string(protocol.ErrCodeAgentInternalError), false
}

func protocolErrorRetryable(value string, retryable bool) bool {
	switch protocol.ErrorCode(value) {
	case protocol.ErrCodeAuthInvalidSignature, protocol.ErrCodeAuthExpiredTimestamp,
		protocol.ErrCodeAuthReplayedNonce, protocol.ErrCodeProtocolVersionUnsupported:
		return !retryable
	case protocol.ErrCodeConnTimeout, protocol.ErrCodeAgentInternalError:
		return retryable
	default:
		return false
	}
}

// MVP 把大小受限且不可信的响应保存为自包含 data URI，调用方只持久化不透明引用。后续
// 对象存储适配器可以替换本函数而不改服务或 schema；1 MiB 上限防止 Agent 借准入流程
// 制造无限制数据库 IO。
func inlineOutputReference(contentType string, body []byte) *string {
	if len(body) == 0 {
		return nil
	}
	mime := strings.TrimSpace(strings.Split(contentType, ";")[0])
	if mime == "" || strings.ContainsAny(mime, "\r\n,") {
		mime = "application/octet-stream"
	}
	value := "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(body)
	return &value
}

func elapsedMilliseconds(start, end time.Time) int64 {
	if end.Before(start) {
		return 0
	}
	return end.Sub(start).Milliseconds()
}
