// executionproxy 包把已经验签的 Agent 回调转发给 Business API；权威 TypeScript 状态机
// 和结果事务均位于后者，Go 侧不重复实现业务状态规则。
package executionproxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
)

const maxResponseBytes = 1 << 20

type Response struct {
	StatusCode int
	Body       []byte
}

type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

func (c *Client) Forward(ctx context.Context, taskID, workflowNodeID, operation, idempotencyKey string, body []byte) (Response, error) {
	if c.BaseURL == "" || c.Token == "" || c.HTTP == nil {
		return Response{}, errors.New("execution proxy is not configured")
	}
	if operation != "status" && operation != "results" {
		return Response{}, errors.New("execution proxy operation is invalid")
	}
	base, err := url.Parse(c.BaseURL)
	if err != nil {
		return Response{}, err
	}
	base.Path = strings.TrimSuffix(base.Path, "/") + "/api/internal/tasks/" + url.PathEscape(taskID) + "/execution/" + operation
	if workflowNodeID != "" {
		base.Path = strings.TrimSuffix(strings.TrimSuffix(base.Path, "/execution/"+operation), "/") +
			"/workflow-nodes/" + url.PathEscape(workflowNodeID) + "/execution/" + operation
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, base.String(), bytes.NewReader(body))
	if err != nil {
		return Response{}, err
	}
	request.Header.Set("Authorization", "Bearer "+c.Token)
	request.Header.Set("Idempotency-Key", idempotencyKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := c.HTTP.Do(request)
	if err != nil {
		return Response{}, err
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return Response{}, err
	}
	if len(responseBody) > maxResponseBytes {
		return Response{}, errors.New("execution proxy response exceeds limit")
	}
	return Response{StatusCode: response.StatusCode, Body: responseBody}, nil
}

// RunTimeoutScan 触发由 TypeScript 管理的截止时间迁移；Go 只负责调度调用，绝不自行计算
// 或写入目标任务状态。
func (c *Client) RunTimeoutScan(ctx context.Context, limit int) error {
	return c.runWorker(ctx, "execution-timeouts", limit)
}

// RunScoreSnapshot 请求 Business API 计算带版本的评分快照。Go 调度器只控制执行频率；
// 评分公式和数据库事实仍由 TypeScript 侧统一管理。
func (c *Client) RunScoreSnapshot(ctx context.Context, limit int) error {
	return c.runWorker(ctx, "score-snapshots", limit)
}

func (c *Client) runWorker(ctx context.Context, worker string, limit int) error {
	if c.BaseURL == "" || c.Token == "" || c.HTTP == nil || limit <= 0 {
		return errors.New("business worker client is not configured")
	}
	base, err := url.Parse(c.BaseURL)
	if err != nil {
		return err
	}
	base.Path = strings.TrimSuffix(base.Path, "/") + "/api/internal/workers/" + url.PathEscape(worker)
	body, err := json.Marshal(map[string]int{"limit": limit})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, base.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.Token)
	request.Header.Set("Content-Type", "application/json")
	response, err := c.HTTP.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBytes))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return errors.New("business worker request was rejected")
	}
	return nil
}
