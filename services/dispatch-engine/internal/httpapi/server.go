package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/agentlifecycle"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/executionproxy"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/matching"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/protocol"
)

const (
	maxRequestBodyBytes     = 1 << 20
	headerInternalActor     = "X-Actor-ID"
	headerInternalActorType = "X-Actor-Type"
)

type Matcher interface {
	RunMatching(ctx context.Context, taskID string) (matching.Record, error)
	LatestCandidates(ctx context.Context, taskID string) (matching.Record, error)
}

type Dispatcher interface {
	ConfirmCandidate(ctx context.Context, command dispatch.LockCommand) (dispatch.LockResult, error)
	Acknowledge(ctx context.Context, assignmentID, agentID string, accepted bool) (domain.Assignment, error)
}

type AssignmentReader interface {
	LatestForTask(ctx context.Context, taskID string) (dispatch.LockResult, error)
}

type Server struct {
	InternalToken    string
	Matcher          Matcher
	Dispatcher       Dispatcher
	AssignmentReader AssignmentReader
	AgentLifecycle   agentlifecycle.Transitioner
	Verifier         *protocol.Verifier
	ExecutionProxy   interface {
		Forward(ctx context.Context, taskID, operation, idempotencyKey string, body []byte) (executionproxy.Response, error)
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /internal/tasks/{id}/candidates", s.internal(s.getCandidates))
	mux.HandleFunc("POST /internal/tasks/{id}/rematch", s.internal(s.rematch))
	mux.HandleFunc("POST /internal/tasks/{id}/assignments", s.internal(s.confirmAssignment))
	mux.HandleFunc("GET /internal/tasks/{id}/assignments/latest", s.internal(s.latestAssignment))
	mux.HandleFunc("POST /internal/agents/{id}/transitions", s.internal(s.transitionAgentLifecycle))
	mux.HandleFunc("POST /agent-callback/assignments/{id}/ack", s.acknowledgeAssignment)
	mux.HandleFunc("POST /agent-callback/tasks/{id}/status", s.forwardExecutionStatus)
	mux.HandleFunc("POST /agent-callback/tasks/{id}/results", s.forwardExecutionResults)
	mux.HandleFunc("GET /health", func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
	})
	return mux
}

func (s *Server) transitionAgentLifecycle(writer http.ResponseWriter, request *http.Request) {
	if s.AgentLifecycle == nil {
		writeError(writer, http.StatusServiceUnavailable, "AGENT_LIFECYCLE_UNAVAILABLE", "Agent 生命周期服务暂不可用", true)
		return
	}
	var input struct {
		Event               string `json:"event"`
		ReviewReason        string `json:"reviewReason,omitempty"`
		AdmissionDecisionID string `json:"admissionDecisionId,omitempty"`
	}
	if err := decodeStrictJSON(request, &input); err != nil {
		writeError(writer, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Agent 生命周期请求格式不正确", false)
		return
	}
	actorType := agentlifecycle.ActorType(request.Header.Get(headerInternalActorType))
	event, err := lifecycleEvent(input.Event, input.ReviewReason, input.AdmissionDecisionID, actorType)
	if err != nil {
		writeError(writer, http.StatusForbidden, "AGENT_LIFECYCLE_FORBIDDEN", "当前身份不能执行该生命周期操作", false)
		return
	}
	snapshot, err := s.AgentLifecycle.Transition(request.Context(), agentlifecycle.Command{
		AgentID: request.PathValue("id"), ActorID: request.Header.Get(headerInternalActor),
		ActorType: actorType, Event: event, IdempotencyKey: request.Header.Get("Idempotency-Key"), Now: time.Now().UTC(),
	})
	if err != nil {
		writeLifecycleError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, snapshot)
}

func lifecycleEvent(name, reviewReason, admissionDecisionID string, actorType agentlifecycle.ActorType) (domain.AgentEvent, error) {
	switch name {
	case "admin_approve":
		if actorType == agentlifecycle.ActorAdmin && (reviewReason != "" || admissionDecisionID != "") {
			return domain.AdminApprove{ReviewReason: reviewReason, AdmissionDecisionID: admissionDecisionID}, nil
		}
	case "admin_reject":
		if actorType == agentlifecycle.ActorAdmin && reviewReason != "" {
			return domain.AdminReject{ReviewReason: reviewReason}, nil
		}
	case "manual_pause":
		if actorType == agentlifecycle.ActorProvider {
			return domain.ManualPause{}, nil
		}
	case "manual_resume":
		if actorType == agentlifecycle.ActorProvider {
			return domain.ManualResume{}, nil
		}
	case "provider_delist":
		if actorType == agentlifecycle.ActorProvider {
			return domain.ProviderDelist{}, nil
		}
	}
	return nil, agentlifecycle.ErrForbidden
}

func writeLifecycleError(writer http.ResponseWriter, err error) {
	var invalid domain.InvalidStateTransitionError
	var recovery domain.ResumeRequiresHealthRecoveryError
	switch {
	case errors.Is(err, agentlifecycle.ErrAgentNotFound):
		writeError(writer, http.StatusNotFound, "AGENT_NOT_FOUND", "Agent 不存在或无权访问", false)
	case errors.Is(err, agentlifecycle.ErrForbidden):
		writeError(writer, http.StatusForbidden, "AGENT_LIFECYCLE_FORBIDDEN", "当前身份不能执行该生命周期操作", false)
	case errors.Is(err, agentlifecycle.ErrIdempotencyRequired):
		writeError(writer, http.StatusBadRequest, "IDEMPOTENCY_KEY_MISSING", "请求缺少 Idempotency-Key", false)
	case errors.Is(err, agentlifecycle.ErrIdempotencyKeyReused):
		writeError(writer, http.StatusConflict, "IDEMPOTENCY_KEY_REUSED", "幂等键已用于其他 Agent 操作", false)
	case errors.As(err, &recovery):
		writeError(writer, http.StatusConflict, "RESUME_REQUIRES_HEALTH_RECOVERY", "等待自动恢复探测通过，或联系平台运营", false)
	case errors.As(err, &invalid):
		writeError(writer, http.StatusConflict, "INVALID_STATE_TRANSITION", "当前 Agent 状态不允许执行此操作", false)
	default:
		writeError(writer, http.StatusInternalServerError, "AGENT_LIFECYCLE_FAILED", "Agent 生命周期操作失败", true)
	}
}

func (s *Server) forwardExecutionStatus(writer http.ResponseWriter, request *http.Request) {
	s.forwardExecutionCallback(writer, request, "status")
}

func (s *Server) forwardExecutionResults(writer http.ResponseWriter, request *http.Request) {
	s.forwardExecutionCallback(writer, request, "results")
}

func (s *Server) forwardExecutionCallback(writer http.ResponseWriter, request *http.Request, operation string) {
	if s.Verifier == nil || s.ExecutionProxy == nil {
		writeError(writer, http.StatusServiceUnavailable, "CALLBACK_UNAVAILABLE", "执行回调暂不可用", true)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, 4<<20))
	if err != nil {
		writeError(writer, http.StatusRequestEntityTooLarge, "VALIDATION_FAILED", "执行回调请求体过大", false)
		return
	}
	var identity struct {
		AgentID string `json:"agentId"`
	}
	if err = json.Unmarshal(body, &identity); err != nil || identity.AgentID == "" {
		writeError(writer, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "执行回调格式不正确", false)
		return
	}
	idempotencyKey := request.Header.Get("Idempotency-Key")
	if !validCallbackIdempotencyKey(idempotencyKey, request.PathValue("id")) {
		writeError(writer, http.StatusBadRequest, "IDEMPOTENCY_KEY_REQUIRED", "执行回调缺少合法幂等键", false)
		return
	}
	_, protocolError := s.Verifier.VerifySignature(request.Context(), protocol.SignedRequest{
		AgentID: identity.AgentID, Method: request.Method, Path: request.URL.Path, Body: body,
		ProtocolVersion: request.Header.Get(protocol.HeaderProtocolVersion),
		Timestamp:       request.Header.Get(protocol.HeaderTimestamp), Nonce: request.Header.Get(protocol.HeaderNonce),
		Signature: request.Header.Get(protocol.HeaderSignature), CallType: protocol.CallType(request.Header.Get(protocol.HeaderCallType)),
	})
	if protocolError != nil {
		writeJSON(writer, protocolError.Code.HTTPStatus(), protocolError.Response())
		return
	}
	result, err := s.ExecutionProxy.Forward(request.Context(), request.PathValue("id"), operation, idempotencyKey, body)
	if err != nil {
		writeError(writer, http.StatusBadGateway, "BUSINESS_API_UNAVAILABLE", "业务状态服务暂不可用", true)
		return
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(result.StatusCode)
	_, _ = writer.Write(result.Body)
}

func validCallbackIdempotencyKey(key, taskID string) bool {
	parts := strings.Split(key, ":")
	return len(parts) == 3 && (parts[0] == "status" || parts[0] == "result-submit") && parts[1] == taskID && len(parts[2]) >= 8
}

func (s *Server) internal(next http.HandlerFunc) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		if s.InternalToken == "" {
			writeError(writer, http.StatusServiceUnavailable, "INTERNAL_AUTH_NOT_CONFIGURED", "内部服务认证尚未配置", true)
			return
		}
		provided := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
		if len(provided) != len(s.InternalToken) || subtle.ConstantTimeCompare([]byte(provided), []byte(s.InternalToken)) != 1 {
			writeError(writer, http.StatusUnauthorized, "UNAUTHENTICATED", "内部服务认证失败", false)
			return
		}
		next(writer, request)
	}
}

func (s *Server) getCandidates(writer http.ResponseWriter, request *http.Request) {
	if s.Matcher == nil {
		writeError(writer, http.StatusServiceUnavailable, "MATCHER_UNAVAILABLE", "匹配服务暂不可用", true)
		return
	}
	record, err := s.Matcher.LatestCandidates(request.Context(), request.PathValue("id"))
	if err != nil {
		writeMatchingError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, record)
}

func (s *Server) rematch(writer http.ResponseWriter, request *http.Request) {
	if s.Matcher == nil {
		writeError(writer, http.StatusServiceUnavailable, "MATCHER_UNAVAILABLE", "匹配服务暂不可用", true)
		return
	}
	record, err := s.Matcher.RunMatching(request.Context(), request.PathValue("id"))
	if err != nil {
		writeMatchingError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, record)
}

func (s *Server) confirmAssignment(writer http.ResponseWriter, request *http.Request) {
	if s.Dispatcher == nil {
		writeError(writer, http.StatusServiceUnavailable, "DISPATCHER_UNAVAILABLE", "派发服务暂不可用", true)
		return
	}
	var body struct {
		AgentID string `json:"agentId"`
	}
	if err := decodeStrictJSON(request, &body); err != nil || body.AgentID == "" {
		writeError(writer, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "agentId 格式不正确", false)
		return
	}
	actorID, idempotencyKey := request.Header.Get(headerInternalActor), request.Header.Get("Idempotency-Key")
	result, err := s.Dispatcher.ConfirmCandidate(request.Context(), dispatch.LockCommand{
		TaskID: request.PathValue("id"), AgentID: body.AgentID, ActorID: actorID, IdempotencyKey: idempotencyKey,
	})
	if err != nil {
		writeDispatchError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, result)
}

func (s *Server) latestAssignment(writer http.ResponseWriter, request *http.Request) {
	if s.AssignmentReader == nil {
		writeError(writer, http.StatusServiceUnavailable, "DISPATCHER_UNAVAILABLE", "派发服务暂不可用", true)
		return
	}
	result, err := s.AssignmentReader.LatestForTask(request.Context(), request.PathValue("id"))
	if err != nil {
		writeDispatchError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, result)
}

func (s *Server) acknowledgeAssignment(writer http.ResponseWriter, request *http.Request) {
	if s.Verifier == nil || s.Dispatcher == nil {
		writeError(writer, http.StatusServiceUnavailable, "CALLBACK_UNAVAILABLE", "接单回调暂不可用", true)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, maxRequestBodyBytes))
	if err != nil {
		writeError(writer, http.StatusBadRequest, "VALIDATION_FAILED", "请求体过大或无法读取", false)
		return
	}
	var input struct {
		AgentID  string `json:"agentId"`
		Accepted bool   `json:"accepted"`
	}
	if err = decodeStrictBytes(body, &input); err != nil || input.AgentID == "" {
		writeError(writer, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "接单回调格式不正确", false)
		return
	}
	_, protocolError := s.Verifier.VerifySignature(request.Context(), protocol.SignedRequest{
		AgentID: input.AgentID, Method: request.Method, Path: request.URL.Path, Body: body,
		ProtocolVersion: request.Header.Get(protocol.HeaderProtocolVersion),
		Timestamp:       request.Header.Get(protocol.HeaderTimestamp),
		Nonce:           request.Header.Get(protocol.HeaderNonce),
		Signature:       request.Header.Get(protocol.HeaderSignature),
		CallType:        protocol.CallType(request.Header.Get(protocol.HeaderCallType)),
	})
	if protocolError != nil {
		writeJSON(writer, protocolError.Code.HTTPStatus(), protocolError.Response())
		return
	}
	assignment, err := s.Dispatcher.Acknowledge(request.Context(), request.PathValue("id"), input.AgentID, input.Accepted)
	if err != nil {
		writeDispatchError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, assignment)
}

func decodeStrictJSON(request *http.Request, target any) error {
	body, err := io.ReadAll(io.LimitReader(request.Body, maxRequestBodyBytes+1))
	if err != nil {
		return err
	}
	if len(body) > maxRequestBodyBytes {
		return errors.New("request body exceeds limit")
	}
	return decodeStrictBytes(body, target)
}

func decodeStrictBytes(body []byte, target any) error {
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("request body must contain exactly one JSON value")
	}
	return nil
}

func writeMatchingError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, matching.ErrTaskNotMatchable):
		writeError(writer, http.StatusConflict, "TASK_NOT_MATCHABLE", "任务当前不处于待匹配状态", false)
	case errors.Is(err, matching.ErrRecordNotFound):
		writeError(writer, http.StatusNotFound, "CANDIDATES_NOT_FOUND", "尚未生成候选记录", false)
	default:
		writeError(writer, http.StatusInternalServerError, "MATCHING_FAILED", "匹配服务执行失败", true)
	}
}

func writeDispatchError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, dispatch.ErrAssignmentAlreadyLocked):
		writeError(writer, http.StatusConflict, "ASSIGNMENT_ALREADY_LOCKED", "任务已被其他候选锁定", false)
	case errors.Is(err, dispatch.ErrCandidateNotFound):
		writeError(writer, http.StatusUnprocessableEntity, "CANDIDATE_NOT_FOUND", "候选不存在或已过期", false)
	case errors.Is(err, dispatch.ErrIdempotencyKeyReused):
		writeError(writer, http.StatusConflict, "IDEMPOTENCY_KEY_REUSED", "幂等键已用于其他请求", false)
	case errors.Is(err, dispatch.ErrDispatchNotFound), errors.Is(err, domain.ErrAssignmentNotFound):
		writeError(writer, http.StatusNotFound, "ASSIGNMENT_NOT_FOUND", "分配记录不存在", false)
	case errors.Is(err, domain.ErrAssignmentAlreadyFinal):
		writeError(writer, http.StatusConflict, "ASSIGNMENT_ALREADY_FINAL", "分配已完成响应，不能重复确认", false)
	default:
		writeError(writer, http.StatusServiceUnavailable, "DISPATCH_FAILED", "派发服务暂不可用", true)
	}
}

func writeError(writer http.ResponseWriter, status int, code, message string, retryable bool) {
	writeJSON(writer, status, map[string]any{"error_code": code, "message": message, "retryable": retryable})
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}
