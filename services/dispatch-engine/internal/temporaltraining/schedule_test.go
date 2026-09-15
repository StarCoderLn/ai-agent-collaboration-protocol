package temporaltraining

import (
	"context"
	"testing"

	"go.temporal.io/sdk/client"
)

type scheduleCreatorFake struct{ options client.ScheduleOptions }

func (f *scheduleCreatorFake) Create(_ context.Context, options client.ScheduleOptions) (client.ScheduleHandle, error) {
	f.options = options
	return nil, nil
}

// TestEnsureNightlyScheduleUsesUTCAndSkipsOverlappingTraining 锁定时区、队列和失败暂停策略，
// 防止部署机器本地时区或 SDK 默认值悄悄改变训练成本与窗口。
func TestEnsureNightlyScheduleUsesUTCAndSkipsOverlappingTraining(t *testing.T) {
	creator := &scheduleCreatorFake{}
	if err := EnsureNightlySchedule(context.Background(), creator, "training-queue", 90); err != nil {
		t.Fatal(err)
	}
	if creator.options.ID != DefaultScheduleID || creator.options.Spec.TimeZoneName != "UTC" ||
		len(creator.options.Spec.Calendars) != 1 || creator.options.Spec.Calendars[0].Hour[0].Start != 2 ||
		creator.options.Action.(*client.ScheduleWorkflowAction).TaskQueue != "training-queue" ||
		creator.options.PauseOnFailure != true {
		t.Fatalf("nightly training schedule is unsafe: %+v", creator.options)
	}
}
