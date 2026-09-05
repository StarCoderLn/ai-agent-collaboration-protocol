package sandboxadmission

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestOpenAICompatibleEvaluatorRecomputesPassFromPlatformThresholds(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Header.Get("Authorization") != "Bearer evaluator-secret" {
			t.Fatal("评测请求没有使用服务端凭证")
		}
		body := `{"choices":[{"message":{"content":"{\"summary\":\"整体可用\",\"runs\":[{\"runNo\":1,\"score\":90,\"requirementCoverage\":true,\"artifactUsability\":true,\"instructionFollowing\":true,\"safeAndGrounded\":true,\"issues\":[]},{\"runNo\":2,\"score\":69,\"requirementCoverage\":true,\"artifactUsability\":true,\"instructionFollowing\":true,\"safeAndGrounded\":true,\"issues\":[\"细节不足\"]},{\"runNo\":3,\"score\":90,\"requirementCoverage\":true,\"artifactUsability\":true,\"instructionFollowing\":true,\"safeAndGrounded\":true,\"issues\":[]}]}"}}]}`
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}

	evaluator := OpenAICompatibleEvaluator{
		Client: client, BaseURL: "https://api.example.test", APIKey: "evaluator-secret", Model: "test-model",
	}
	result, err := evaluator.Evaluate(context.Background(), evaluationFixture())
	if err != nil {
		t.Fatal(err)
	}
	if result.Passed || result.AverageScore != 83 {
		t.Fatalf("单次低于 70 必须失败，且平均分由平台计算：%+v", result)
	}
}

func TestParseEvaluationResponseRejectsMissingOrDuplicateTrialNumbers(t *testing.T) {
	body := []byte(`{"choices":[{"message":{"content":"{\"summary\":\"无效\",\"runs\":[{\"runNo\":1,\"score\":90},{\"runNo\":1,\"score\":90},{\"runNo\":3,\"score\":90}]}"}}]}`)
	if _, err := parseEvaluationResponse(body, "test-model"); err == nil {
		t.Fatal("重复 runNo 不能形成可追溯的三次评测")
	}
}

func TestBuildEvaluationPayloadOnlyJudgesUserVisibleArtifacts(t *testing.T) {
	payload, err := buildEvaluationPayload("test-model", evaluationFixture())
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	prompt := string(encoded)
	if payload["max_tokens"] != 3000 {
		t.Fatal("评测必须限制输出预算，避免简短评分生成不必要的长文")
	}
	for _, invariant := range []string{
		"只验收用户可见的最终产物",
		"不得要求产物展示内部工具品牌",
		"测试任务的具体主题不需要与能力名称相同",
	} {
		if !strings.Contains(prompt, invariant) {
			t.Fatalf("自动评测提示缺少用户可见边界：%s", invariant)
		}
	}
}

func evaluationFixture() EvaluationInput {
	runs := make([]Run, 0, RunsPerRound)
	inputs := make([]json.RawMessage, 0, RunsPerRound)
	for runNo := 1; runNo <= RunsPerRound; runNo++ {
		body := fmt.Sprintf(`{"status":"completed","artifacts":[{"type":"document","summary":"试运行 %d","content":"可验收产物"}]}`, runNo)
		ref := "data:application/json;base64," + base64.StdEncoding.EncodeToString([]byte(body))
		runs = append(runs, Run{RunNo: runNo, OutputRef: &ref})
		inputs = append(inputs, []byte(fmt.Sprintf(`{"title":"测试 %d"}`, runNo)))
	}
	return EvaluationInput{
		AgentName: "测试 Agent", Capability: "生成可验收文档",
		TestInputs: inputs, Runs: runs,
	}
}

func TestDecodeInlineOutputRejectsExternalReferences(t *testing.T) {
	if _, err := decodeInlineOutput("https://example.com/result.json"); err == nil || !strings.Contains(err.Error(), "reference") {
		t.Fatal("评测器只能消费沙箱层冻结的内联响应，不能擅自访问 Agent 提供的外部地址")
	}
}
