// quickagent 包集中定义无需 SDK 的 HTTP JSON 接入契约。沙箱准入和正式派发都必须
// 通过这里解析响应，避免“上架测试通过、真实任务却因格式不同失败”的双重标准。
package quickagent

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

var ErrInvalidResponse = errors.New("quick Agent response is invalid")

type Artifact struct {
	Type     string          `json:"type"`
	Summary  string          `json:"summary"`
	Content  json.RawMessage `json:"content"`
	MIMEType string          `json:"mimeType,omitempty"`
}

// ParseResponse 接受提供者最小响应，同时忽略未知扩展字段以保持向前兼容。状态、产物
// 数量、类型及必填内容仍严格校验；尾随第二段 JSON 会被拒绝，防止歧义解析。
func ParseResponse(body []byte) ([]Artifact, error) {
	var response struct {
		Status    string     `json:"status"`
		Artifacts []Artifact `json:"artifacts"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	if err := decoder.Decode(&response); err != nil {
		return nil, ErrInvalidResponse
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, ErrInvalidResponse
	}
	if response.Status != "completed" || len(response.Artifacts) < 1 || len(response.Artifacts) > 3 {
		return nil, ErrInvalidResponse
	}
	for _, artifact := range response.Artifacts {
		if !supportedArtifactType(artifact.Type) || strings.TrimSpace(artifact.Summary) == "" || len(artifact.Content) == 0 {
			return nil, ErrInvalidResponse
		}
		var content any
		if json.Unmarshal(artifact.Content, &content) != nil || content == nil {
			return nil, ErrInvalidResponse
		}
	}
	return response.Artifacts, nil
}

func supportedArtifactType(value string) bool {
	switch value {
	case "document", "code", "json", "website", "image", "video":
		return true
	default:
		return false
	}
}
