package temporaltraining

import (
	"context"
	"errors"
	"time"

	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/client"
)

const DefaultScheduleID = "aicp-matching-v2-nightly"

// ScheduleCreator 保留 Temporal Schedule Client 的最小能力，便于测试幂等配置而不启动服务。
type ScheduleCreator interface {
	Create(context.Context, client.ScheduleOptions) (client.ScheduleHandle, error)
}

// EnsureNightlySchedule 幂等创建 UTC 02:00 的夜间训练。Temporal 默认跳过重叠运行，
// 并在连续失败后暂停 Schedule，避免数据库或模型异常时每天叠加昂贵训练。
func EnsureNightlySchedule(ctx context.Context, creator ScheduleCreator, taskQueue string, lookbackDays int) error {
	if creator == nil || lookbackDays <= 0 || lookbackDays > 365 {
		return errors.New("matching training schedule is not configured")
	}
	if taskQueue == "" {
		taskQueue = DefaultTaskQueue
	}
	_, err := creator.Create(ctx, client.ScheduleOptions{
		ID: DefaultScheduleID,
		Spec: client.ScheduleSpec{Calendars: []client.ScheduleCalendarSpec{{
			Minute: []client.ScheduleRange{{Start: 0}}, Hour: []client.ScheduleRange{{Start: 2}},
		}}, TimeZoneName: "UTC"},
		Action: &client.ScheduleWorkflowAction{
			ID: "aicp-matching-v2-nightly-run", Workflow: WorkflowName,
			Args: []interface{}{WorkflowInput{LookbackDays: lookbackDays}}, TaskQueue: taskQueue,
			WorkflowExecutionTimeout: 2 * time.Hour,
		},
		// 最多补跑六小时内错过的凌晨任务；更久的停机等待下一夜，避免恢复时堆积多轮训练。
		CatchupWindow:  6 * time.Hour,
		PauseOnFailure: true,
		Note:           "基于真实曝光与已完成漏斗事实训练 V2 candidate 模型",
	})
	if err == nil {
		return nil
	}
	// 固定 Schedule ID 使重复启动天然幂等；其他错误仍返回，避免把权限或连接故障吞掉。
	var alreadyExists *serviceerror.AlreadyExists
	if errors.As(err, &alreadyExists) {
		return nil
	}
	return err
}
