package matchingfeedback

import (
	"context"
	"errors"
	"testing"
	"time"
)

type repositoryFake struct {
	exposure Exposure
	err      error
}

func (r *repositoryFake) RecordExposure(_ context.Context, exposure Exposure) error {
	r.exposure = exposure
	return r.err
}

// TestRecordExposureValidatesTimeAndDelegatesFrozenCandidateCheck 固定当前时间，分别验证
// 合法归一化、最低可见时长和离线事件上限，避免测试依赖机器时钟。
func TestRecordExposureValidatesTimeAndDelegatesFrozenCandidateCheck(t *testing.T) {
	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	repository := &repositoryFake{}
	service := Service{Repository: repository, Now: func() time.Time { return now }}
	exposure := Exposure{
		EventKey: "candidate-view:session:record:agent", ViewSessionID: "session", DistributionRecordID: "record",
		TaskID: "task", WorkflowNodeID: "node", AgentID: "agent", ActorID: " publisher ",
		Position: 2, VisibleMillis: 1250, OccurredAt: now.Add(-time.Minute),
	}
	if err := service.RecordExposure(context.Background(), exposure); err != nil {
		t.Fatal(err)
	}
	if repository.exposure.ActorID != "publisher" || !repository.exposure.OccurredAt.Equal(exposure.OccurredAt) {
		t.Fatalf("曝光事实未按契约归一化：%+v", repository.exposure)
	}
	exposure.VisibleMillis = 999
	if err := service.RecordExposure(context.Background(), exposure); !errors.Is(err, ErrInvalidExposure) {
		t.Fatalf("不足一秒的候选可见时间不应形成曝光事实：%v", err)
	}
	exposure.VisibleMillis = 1000

	exposure.OccurredAt = now.Add(-25 * time.Hour)
	if err := service.RecordExposure(context.Background(), exposure); !errors.Is(err, ErrInvalidExposure) {
		t.Fatalf("过期浏览器事件必须被拒绝：%v", err)
	}
}
