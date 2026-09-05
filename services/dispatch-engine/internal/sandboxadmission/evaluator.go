package sandboxadmission

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

const (
	minimumSingleRunScore = 70
	minimumAverageScore   = 80
	maxEvaluationBody     = 1 << 20
	maxOutputForEvaluator = 120_000
)

// EvaluationInput 只包含评测所需的公开档案、标准任务和产物。凭证、提供者钱包和价格
// 均不应进入第三方模型上下文，避免准入评测扩大敏感信息暴露面。
type EvaluationInput struct {
	AgentName  string
	Capability string
	TestInputs []json.RawMessage
	Runs       []Run
}

type RunEvaluation struct {
	RunNo                int      `json:"runNo"`
	Score                int      `json:"score"`
	RequirementCoverage  bool     `json:"requirementCoverage"`
	ArtifactUsability    bool     `json:"artifactUsability"`
	InstructionFollowing bool     `json:"instructionFollowing"`
	SafeAndGrounded      bool     `json:"safeAndGrounded"`
	Issues               []string `json:"issues"`
}

type QualityEvaluation struct {
	Model        string          `json:"model"`
	AverageScore int             `json:"averageScore"`
	Passed       bool            `json:"passed"`
	Summary      string          `json:"summary"`
	Runs         []RunEvaluation `json:"runs"`
}

type QualityEvaluator interface {
	Evaluate(ctx context.Context, input EvaluationInput) (QualityEvaluation, error)
}

// OpenAICompatibleEvaluator 通过 OpenAI-compatible chat/completions 接口完成一次批量评测。
// 模型只给出结构化事实与分数，最终 passed 由本地固定阈值重新计算，不能由模型自由决定。
type OpenAICompatibleEvaluator struct {
	Client  *http.Client
	BaseURL string
	APIKey  string
	Model   string
}

func (e *OpenAICompatibleEvaluator) Evaluate(ctx context.Context, input EvaluationInput) (QualityEvaluation, error) {
	if e.Client == nil || strings.TrimSpace(e.APIKey) == "" || strings.TrimSpace(e.Model) == "" {
		return QualityEvaluation{}, errors.New("automatic admission evaluator is not configured")
	}
	endpoint, err := evaluatorEndpoint(e.BaseURL)
	if err != nil {
		return QualityEvaluation{}, err
	}
	payload, err := buildEvaluationPayload(e.Model, input)
	if err != nil {
		return QualityEvaluation{}, err
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return QualityEvaluation{}, errors.New("automatic admission request cannot be encoded")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return QualityEvaluation{}, err
	}
	request.Header.Set("Authorization", "Bearer "+e.APIKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := e.Client.Do(request)
	if err != nil {
		return QualityEvaluation{}, err
	}
	defer response.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(response.Body, maxEvaluationBody+1))
	if readErr != nil || len(body) > maxEvaluationBody {
		return QualityEvaluation{}, errors.New("automatic admission evaluator response is unreadable")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return QualityEvaluation{}, fmt.Errorf("automatic admission evaluator returned HTTP %d", response.StatusCode)
	}
	result, err := parseEvaluationResponse(body, e.Model)
	if err != nil {
		return QualityEvaluation{}, err
	}
	return result, nil
}

func evaluatorEndpoint(baseURL string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return "", errors.New("automatic admission evaluator URL is invalid")
	}
	parsed.Path = strings.TrimSuffix(parsed.Path, "/") + "/chat/completions"
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

func buildEvaluationPayload(model string, input EvaluationInput) (map[string]any, error) {
	if len(input.TestInputs) != RunsPerRound || len(input.Runs) != RunsPerRound {
		return nil, ErrRoundInconsistent
	}
	type evidence struct {
		RunNo  int             `json:"runNo"`
		Task   json.RawMessage `json:"task"`
		Output string          `json:"output"`
	}
	items := make([]evidence, 0, RunsPerRound)
	for index, run := range input.Runs {
		if run.OutputRef == nil {
			return nil, errors.New("automatic admission output is missing")
		}
		output, err := decodeInlineOutput(*run.OutputRef)
		if err != nil {
			return nil, err
		}
		items = append(items, evidence{RunNo: run.RunNo, Task: input.TestInputs[index], Output: output})
	}
	evidenceJSON, err := json.Marshal(map[string]any{
		"agent":  map[string]string{"name": input.AgentName, "declaredCapability": input.Capability},
		"trials": items,
	})
	if err != nil {
		return nil, errors.New("automatic admission evidence cannot be encoded")
	}
	// 自动准入只能验收用户能够看到的交付物。Agent 内部调用了哪个检索服务、如何完成
	// 引用白名单校验属于实现细节；要求把这些过程写进论文、图片或代码会污染真实产物，
	// 也会让不同技术路线受到不公平惩罚。声明能力只用于判断产物类型与用途是否匹配，
	// 不能把测试题本身的主题误当成 Agent 的能力名称。
	systemPrompt := `你是 Agent 市场的自动准入评测器。逐一检查三次测试产物是否覆盖任务、是否可直接使用、是否遵循指令、是否安全且没有虚构执行事实。只验收用户可见的最终产物：不得要求产物展示内部工具品牌、检索过程、调用日志、隐藏校验步骤或其他实现细节；只要引用或来源在产物中可追溯，就不得因未展示内部校验过程扣分。Agent 声明能力只用于判断产物类型和用途是否匹配，测试任务的具体主题不需要与能力名称相同，例如论文 Agent 围绕测试题主题交付一篇论文仍属于能力匹配。只根据提供的任务和产物判断，不因文风偏好加减分。必须返回 JSON，不得输出 Markdown。格式：{"summary":"简短总评","runs":[{"runNo":1,"score":0到100的整数,"requirementCoverage":true,"artifactUsability":true,"instructionFollowing":true,"safeAndGrounded":true,"issues":["具体问题"]}]}。runs 必须恰好包含 1、2、3。`
	return map[string]any{
		"model":       model,
		"temperature": 0,
		// 评测只需三组简洁分数和问题，输出上限限制平台侧费用；它不限制提供者的内部调用。
		"max_tokens":      3000,
		"response_format": map[string]string{"type": "json_object"},
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": string(evidenceJSON)},
		},
	}, nil
}

func parseEvaluationResponse(body []byte, model string) (QualityEvaluation, error) {
	var envelope struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(body, &envelope) != nil || len(envelope.Choices) != 1 {
		return QualityEvaluation{}, errors.New("automatic admission evaluator response is invalid")
	}
	var raw struct {
		Summary string          `json:"summary"`
		Runs    []RunEvaluation `json:"runs"`
	}
	if json.Unmarshal([]byte(envelope.Choices[0].Message.Content), &raw) != nil || strings.TrimSpace(raw.Summary) == "" || len(raw.Runs) != RunsPerRound {
		return QualityEvaluation{}, errors.New("automatic admission evaluator JSON is invalid")
	}
	sort.Slice(raw.Runs, func(i, j int) bool { return raw.Runs[i].RunNo < raw.Runs[j].RunNo })
	total := 0
	passed := true
	for index := range raw.Runs {
		run := &raw.Runs[index]
		if run.RunNo != index+1 || run.Score < 0 || run.Score > 100 || len(run.Issues) > 10 {
			return QualityEvaluation{}, errors.New("automatic admission evaluator scores are invalid")
		}
		total += run.Score
		if run.Score < minimumSingleRunScore || !run.RequirementCoverage || !run.ArtifactUsability || !run.InstructionFollowing || !run.SafeAndGrounded {
			passed = false
		}
	}
	average := total / RunsPerRound
	passed = passed && average >= minimumAverageScore
	return QualityEvaluation{
		Model: model, AverageScore: average, Passed: passed,
		Summary: strings.TrimSpace(raw.Summary), Runs: raw.Runs,
	}, nil
}

func decodeInlineOutput(reference string) (string, error) {
	comma := strings.IndexByte(reference, ',')
	if !strings.HasPrefix(reference, "data:") || comma < 0 || !strings.HasSuffix(reference[:comma], ";base64") {
		return "", errors.New("automatic admission output reference is invalid")
	}
	decoded, err := base64.StdEncoding.DecodeString(reference[comma+1:])
	if err != nil || len(decoded) == 0 {
		return "", errors.New("automatic admission output cannot be decoded")
	}
	if len(decoded) > maxOutputForEvaluator {
		decoded = decoded[:maxOutputForEvaluator]
	}
	return string(decoded), nil
}
