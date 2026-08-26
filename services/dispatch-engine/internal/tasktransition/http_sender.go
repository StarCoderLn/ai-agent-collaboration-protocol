package tasktransition

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

const maxTransitionResponseBytes = 64 << 10

type DeliveryError struct {
	Code      string
	Retryable bool
}

func (e *DeliveryError) Error() string { return e.Code }

type HTTPSender struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

func (s *HTTPSender) Send(ctx context.Context, event Event) error {
	if s.BaseURL == "" || s.Token == "" || s.Client == nil {
		return errors.New("business api transition sender is not configured")
	}
	base, err := url.Parse(s.BaseURL)
	if err != nil {
		return err
	}
	base.Path = strings.TrimSuffix(base.Path, "/") + "/api/internal/tasks/" + url.PathEscape(event.TaskID) + "/transitions"
	body, err := json.Marshal(map[string]string{
		"eventId": event.ID, "assignmentId": event.AssignmentID, "eventType": event.EventType,
	})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, base.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+s.Token)
	request.Header.Set("Content-Type", "application/json")
	response, err := s.Client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	limited, readErr := io.ReadAll(io.LimitReader(response.Body, maxTransitionResponseBytes+1))
	if readErr != nil {
		return readErr
	}
	if len(limited) > maxTransitionResponseBytes {
		return &DeliveryError{Code: "TRANSITION_RESPONSE_TOO_LARGE", Retryable: true}
	}
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return nil
	}
	var failure struct {
		Code      string `json:"error_code"`
		Retryable bool   `json:"retryable"`
	}
	if err = json.Unmarshal(limited, &failure); err != nil || failure.Code == "" {
		return &DeliveryError{Code: fmt.Sprintf("TRANSITION_HTTP_%d", response.StatusCode), Retryable: response.StatusCode >= 500}
	}
	return &DeliveryError{Code: failure.Code, Retryable: failure.Retryable}
}
