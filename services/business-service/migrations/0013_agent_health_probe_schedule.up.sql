-- Feature 3 补充：健康探测的持久化调度与多 worker 租约。
-- 探测间隔仍由 agent_status_config 决定；本表只保存下一次执行时间和当前租约，
-- 不复制 Agent 状态或连续成功/失败计数。
BEGIN;
CREATE TABLE agent_health_probe_schedule (
    agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    next_probe_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_until TIMESTAMPTZ,
    lock_token UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((lock_token IS NULL) = (locked_until IS NULL))
);
CREATE INDEX idx_agent_health_probe_schedule_due
    ON agent_health_probe_schedule(next_probe_at, locked_until);
COMMIT;
