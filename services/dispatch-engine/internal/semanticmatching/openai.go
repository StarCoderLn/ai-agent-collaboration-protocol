package semanticmatching

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// OpenAIEmbedder 实现官方 Embeddings HTTP 契约，不依赖额外 SDK，也不记录请求正文或密钥。
type OpenAIEmbedder struct {
	Client     *http.Client
	BaseURL    string
	APIKey     string
	Model      string
	Dimensions int
}

type embeddingRequest struct {
	Input      []string `json:"input"`
	Model      string   `json:"model"`
	Dimensions int      `json:"dimensions"`
}

type embeddingResponse struct {
	Data []struct {
		Index     int       `json:"index"`
		Embedding []float32 `json:"embedding"`
	} `json:"data"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error,omitempty"`
}

// Embed 只向 OpenAI 官方 Embeddings 端点发送公开 Agent 能力或当前任务文本。错误消息
// 不包含 Authorization header，也不返回完整第三方正文，防止日志意外泄露密钥或输入。
func (e *OpenAIEmbedder) Embed(ctx context.Context, inputs []string) ([][]float32, error) {
	if e == nil || e.Client == nil || strings.TrimSpace(e.APIKey) == "" || len(inputs) == 0 {
		return nil, errors.New("openai embedder is not configured")
	}
	model := e.Model
	if model == "" {
		model = DefaultModel
	}
	dimensions := e.Dimensions
	if dimensions == 0 {
		dimensions = DefaultDimensions
	}
	body, err := json.Marshal(embeddingRequest{Input: inputs, Model: model, Dimensions: dimensions})
	if err != nil {
		return nil, err
	}
	baseURL := strings.TrimRight(e.BaseURL, "/")
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/embeddings", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+e.APIKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := e.Client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("openai embeddings request failed: %w", err)
	}
	defer response.Body.Close()
	limited := io.LimitReader(response.Body, 8<<20)
	var decoded embeddingResponse
	if err = json.NewDecoder(limited).Decode(&decoded); err != nil {
		return nil, errors.New("openai embeddings returned invalid JSON")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if decoded.Error != nil && decoded.Error.Type != "" {
			return nil, fmt.Errorf("openai embeddings rejected request: status=%d type=%s", response.StatusCode, decoded.Error.Type)
		}
		return nil, fmt.Errorf("openai embeddings rejected request: status=%d", response.StatusCode)
	}
	if len(decoded.Data) != len(inputs) {
		return nil, fmt.Errorf("openai embeddings count mismatch: got %d want %d", len(decoded.Data), len(inputs))
	}
	vectors := make([][]float32, len(inputs))
	for _, item := range decoded.Data {
		if item.Index < 0 || item.Index >= len(vectors) || vectors[item.Index] != nil {
			return nil, errors.New("openai embeddings returned invalid indexes")
		}
		vectors[item.Index] = item.Embedding
	}
	return vectors, nil
}
