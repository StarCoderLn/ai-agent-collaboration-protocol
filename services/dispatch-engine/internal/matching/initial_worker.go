package matching

import (
	"context"
	"errors"
	"fmt"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
)

// InitialMatchSource 只暴露“尚无任何候选记录”的 matching 任务。多实例可能同时读到
// 同一任务，但 RunMatching 的输入指纹唯一约束会把并发执行收敛成同一条记录。
type InitialMatchSource interface {
	PendingInitialMatchTaskIDs(ctx context.Context, limit int) ([]string, error)
}

type WorkflowMatchTarget struct {
	TaskID         string
	WorkflowNodeID string
}

type WorkflowInitialMatchSource interface {
	PendingInitialWorkflowNodes(ctx context.Context, limit int) ([]WorkflowMatchTarget, error)
}

type InitialMatchRunner interface {
	RunMatching(ctx context.Context, taskID string) (Record, error)
}

type WorkflowInitialMatchRunner interface {
	RunWorkflowNodeMatching(ctx context.Context, taskID, workflowNodeID string) (Record, error)
}

type AutomaticDispatcher interface {
	ConfirmCandidate(ctx context.Context, command dispatch.LockCommand) (dispatch.LockResult, error)
}

// InitialMatchCoordinator 把“冻结候选”和“按冻结排名自动分配”收进同一个入口。
// 手动、自动都复用同一匹配记录；自动模式也复用 dispatch.Service 的原子锁定、
// durable attempt 与队列发送，不在 worker 中复制事务或错误恢复规则。
type InitialMatchCoordinator struct {
	Matcher    InitialMatchRunner
	Dispatcher AutomaticDispatcher
}

func (c InitialMatchCoordinator) RunMatching(ctx context.Context, taskID string) (Record, error) {
	if c.Matcher == nil {
		return Record{}, errors.New("initial match coordinator requires matcher")
	}
	record, err := c.Matcher.RunMatching(ctx, taskID)
	if err != nil {
		return Record{}, err
	}
	switch record.AssignmentMode {
	case AssignmentManual:
		return record, nil
	case AssignmentAutomatic:
		if len(record.Candidates) == 0 {
			// fallbackOnFail=manual 的 MVP 页面允许发布者调整条件后重新匹配；这里不能
			// 为了推进状态而伪造候选或 assignment。
			return record, nil
		}
		if c.Dispatcher == nil || record.ID == "" || record.TaskID == "" {
			return Record{}, errors.New("automatic assignment requires dispatcher and persisted matching record")
		}
		_, err = c.Dispatcher.ConfirmCandidate(ctx, dispatch.LockCommand{
			TaskID: record.TaskID, AgentID: record.Candidates[0].AgentID, ActorID: "system:auto",
			IdempotencyKey: fmt.Sprintf("dispatch:auto:%s:%s", record.TaskID, record.ID),
		})
		if err != nil {
			return Record{}, err
		}
		return record, nil
	default:
		return Record{}, fmt.Errorf("unsupported assignment mode %q", record.AssignmentMode)
	}
}

func (c InitialMatchCoordinator) RunWorkflowNodeMatching(
	ctx context.Context,
	taskID, workflowNodeID string,
) (Record, error) {
	matcher, ok := c.Matcher.(WorkflowInitialMatchRunner)
	if !ok || taskID == "" || workflowNodeID == "" {
		return Record{}, errors.New("initial workflow matching requires node-aware matcher")
	}
	record, err := matcher.RunWorkflowNodeMatching(ctx, taskID, workflowNodeID)
	if err != nil {
		return Record{}, err
	}
	switch record.AssignmentMode {
	case AssignmentManual:
		return record, nil
	case AssignmentAutomatic:
		if len(record.Candidates) == 0 {
			return record, nil
		}
		if c.Dispatcher == nil || record.ID == "" {
			return Record{}, errors.New("automatic workflow assignment requires dispatcher and matching record")
		}
		_, err = c.Dispatcher.ConfirmCandidate(ctx, dispatch.LockCommand{
			TaskID: taskID, WorkflowNodeID: workflowNodeID,
			AgentID: record.Candidates[0].AgentID, ActorID: "system:auto",
			IdempotencyKey: fmt.Sprintf("dispatch:auto:%s:%s:%s", taskID, workflowNodeID, record.ID),
		})
		if err != nil {
			return Record{}, err
		}
		return record, nil
	default:
		return Record{}, fmt.Errorf("unsupported assignment mode %q", record.AssignmentMode)
	}
}

type InitialMatchWorker struct {
	Source InitialMatchSource
	Runner InitialMatchRunner
	Limit  int
}

type InitialMatchBatch struct {
	Claimed   int
	Generated int
}

type WorkflowInitialMatchWorker struct {
	Source WorkflowInitialMatchSource
	Runner WorkflowInitialMatchRunner
	Limit  int
}

// RunOnce 的失败隔离与旧任务 worker 相同，但处理单位是 node，不是 task。一个并行节点
// 匹配失败不能阻塞同一工作流的另一条已经解锁分支。
func (w *WorkflowInitialMatchWorker) RunOnce(ctx context.Context) (InitialMatchBatch, error) {
	if w.Source == nil || w.Runner == nil || w.Limit <= 0 {
		return InitialMatchBatch{}, errors.New("workflow match worker requires source, runner and positive limit")
	}
	targets, err := w.Source.PendingInitialWorkflowNodes(ctx, w.Limit)
	if err != nil {
		return InitialMatchBatch{}, err
	}
	result := InitialMatchBatch{Claimed: len(targets)}
	var failures []error
	for _, target := range targets {
		if _, runErr := w.Runner.RunWorkflowNodeMatching(ctx, target.TaskID, target.WorkflowNodeID); runErr == nil {
			result.Generated++
		} else if !errors.Is(runErr, ErrTaskNotMatchable) {
			failures = append(failures, runErr)
		}
	}
	return result, errors.Join(failures...)
}

// RunOnce 逐项执行并汇总错误：单个损坏任务不能饿死同批其他任务；失败任务因没有记录，
// 下个 tick 会再次出现。TASK_NOT_MATCHABLE 表示扫描后状态已变化，不需要视为服务故障。
func (w *InitialMatchWorker) RunOnce(ctx context.Context) (InitialMatchBatch, error) {
	if w.Source == nil || w.Runner == nil || w.Limit <= 0 {
		return InitialMatchBatch{}, errors.New("initial match worker requires source, runner and positive limit")
	}
	taskIDs, err := w.Source.PendingInitialMatchTaskIDs(ctx, w.Limit)
	if err != nil {
		return InitialMatchBatch{}, err
	}
	result := InitialMatchBatch{Claimed: len(taskIDs)}
	var failures []error
	for _, taskID := range taskIDs {
		if _, runErr := w.Runner.RunMatching(ctx, taskID); runErr == nil {
			result.Generated++
		} else if !errors.Is(runErr, ErrTaskNotMatchable) {
			failures = append(failures, runErr)
		}
	}
	return result, errors.Join(failures...)
}
