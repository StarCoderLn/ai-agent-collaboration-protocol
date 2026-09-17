-- 已确认但尚未选人、尚未托管的工作流可能因历史规划协议与 Agent 目录漂移而不可执行。
-- 恢复操作在删除活动投影前保存完整快照，避免为修复演示数据而丢失候选与曝光审计。
BEGIN;

CREATE TABLE workflow_plan_recovery_archives (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id),
    reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 8 AND 500),
    recovered_by TEXT NOT NULL CHECK (length(trim(recovered_by)) > 0),
    plan_revision BIGINT NOT NULL CHECK (plan_revision > 0),
    snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_workflow_plan_recovery_archives_task
    ON workflow_plan_recovery_archives(task_id, created_at DESC, id);

COMMENT ON TABLE workflow_plan_recovery_archives IS
    '未选人且未托管工作流恢复前的不可变审计快照；活动投影删除后仍可追溯原计划、候选和曝光事实。';

COMMIT;
