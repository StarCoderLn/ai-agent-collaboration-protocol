package agenthealth

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/protocol"
)

const maxHealthResponseBytes = 64 << 10

type HTTPProber struct{ Client *http.Client }

// Probe 始终返回四种协议健康分类之一（或成功）。精确认证错误码会保留给运维排障，
// 生命周期计数只消费归一化后的领域分类，避免协议细节泄漏到状态迁移规则。
func (p *HTTPProber) Probe(ctx context.Context, _ string, endpoint, secret, integrationMode string) Observation {
	if integrationMode == "" {
		integrationMode = "aicp_hmac"
	}
	if p.Client == nil || (integrationMode == "aicp_hmac" && secret == "") {
		return Observation{Result: domain.ProbeAgentInternalError, ResultCode: string(protocol.ErrCodeAgentInternalError)}
	}
	healthURL, err := healthEndpoint(endpoint)
	if err != nil {
		return Observation{Result: domain.ProbeProtocolIncompatible, ResultCode: string(protocol.ErrCodeProtocolVersionUnsupported)}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, healthURL, nil)
	if err != nil {
		return Observation{Result: domain.ProbeProtocolIncompatible, ResultCode: string(protocol.ErrCodeProtocolVersionUnsupported)}
	}
	if integrationMode == "aicp_hmac" {
		headers, signErr := protocol.Sign(protocol.SignRequest{Method: http.MethodGet, Path: "/healthz"}, secret, protocol.CallTypeProduction)
		if signErr != nil {
			return Observation{Result: domain.ProbeAgentInternalError, ResultCode: string(protocol.ErrCodeAgentInternalError)}
		}
		request.Header.Set(protocol.HeaderProtocolVersion, headers.ProtocolVersion)
		request.Header.Set(protocol.HeaderTimestamp, headers.Timestamp)
		request.Header.Set(protocol.HeaderNonce, headers.Nonce)
		request.Header.Set(protocol.HeaderSignature, headers.Signature)
		request.Header.Set(protocol.HeaderCallType, string(headers.CallType))
	} else if integrationMode == "http_json" && secret != "" {
		request.Header.Set("Authorization", "Bearer "+secret)
	} else if integrationMode != "http_json" {
		return Observation{Result: domain.ProbeProtocolIncompatible, ResultCode: string(protocol.ErrCodeProtocolVersionUnsupported)}
	}
	response, err := p.Client.Do(request)
	if err != nil {
		return Observation{Result: domain.ProbeConnectionTimeout, ResultCode: string(protocol.ErrCodeConnTimeout)}
	}
	defer response.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(response.Body, maxHealthResponseBytes+1))
	if readErr != nil || len(body) > maxHealthResponseBytes {
		return Observation{Result: domain.ProbeAgentInternalError, ResultCode: string(protocol.ErrCodeAgentInternalError)}
	}
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		var payload struct {
			Status string `json:"status"`
		}
		if json.Unmarshal(body, &payload) == nil && (payload.Status == "up" || payload.Status == "ok") {
			return Observation{Result: domain.ProbeSuccess, ResultCode: "HEALTH_OK"}
		}
		return Observation{Result: domain.ProbeAgentInternalError, ResultCode: string(protocol.ErrCodeAgentInternalError)}
	}
	var failure struct {
		ErrorCode string `json:"error_code"`
	}
	_ = json.Unmarshal(body, &failure)
	switch protocol.ErrorCode(failure.ErrorCode) {
	case protocol.ErrCodeAuthInvalidSignature, protocol.ErrCodeAuthExpiredTimestamp, protocol.ErrCodeAuthReplayedNonce:
		return Observation{Result: domain.ProbeAuthFailure, ResultCode: failure.ErrorCode}
	case protocol.ErrCodeProtocolVersionUnsupported:
		return Observation{Result: domain.ProbeProtocolIncompatible, ResultCode: failure.ErrorCode}
	case protocol.ErrCodeConnTimeout:
		return Observation{Result: domain.ProbeConnectionTimeout, ResultCode: failure.ErrorCode}
	case protocol.ErrCodeAgentInternalError:
		return Observation{Result: domain.ProbeAgentInternalError, ResultCode: failure.ErrorCode}
	}
	if response.StatusCode == http.StatusUnauthorized {
		return Observation{Result: domain.ProbeAuthFailure, ResultCode: string(protocol.ErrCodeAuthInvalidSignature)}
	}
	if response.StatusCode == http.StatusRequestTimeout || response.StatusCode == http.StatusGatewayTimeout {
		return Observation{Result: domain.ProbeConnectionTimeout, ResultCode: string(protocol.ErrCodeConnTimeout)}
	}
	return Observation{Result: domain.ProbeAgentInternalError, ResultCode: string(protocol.ErrCodeAgentInternalError)}
}

func healthEndpoint(serviceEndpoint string) (string, error) {
	parsed, err := url.Parse(serviceEndpoint)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", &url.Error{Op: "parse", URL: serviceEndpoint, Err: errInvalidEndpoint{}}
	}
	parsed.Path, parsed.RawPath, parsed.RawQuery, parsed.Fragment = "/healthz", "", "", ""
	return strings.TrimSuffix(parsed.String(), "/"), nil
}

type errInvalidEndpoint struct{}

func (errInvalidEndpoint) Error() string { return "invalid agent endpoint" }
