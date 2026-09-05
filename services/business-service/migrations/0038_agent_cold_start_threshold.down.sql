-- 仅移除本版本新增的独立冷启动门槛；历史任务、评分和 Agent 状态均保留。
BEGIN;

ALTER TABLE agent_status_config
    DROP COLUMN probation_completed_task_threshold;

COMMIT;
