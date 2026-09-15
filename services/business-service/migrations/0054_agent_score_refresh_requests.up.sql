-- 评分相关任务事件在原业务事务中写入本表，异步 worker 随后只重算受影响的 Agent。
-- 每个 Agent 最多保留一个待处理请求：连续评分、结算或仲裁事件会合并，避免重复扫描历史。
BEGIN;
CREATE TABLE agent_score_refresh_requests (
    agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    requested_at TIMESTAMPTZ NOT NULL,
    reason_event_id BIGINT NOT NULL REFERENCES task_events(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Worker 先处理等待最久的请求；主键同时支持领取时的行锁和处理后的精确删除。
CREATE INDEX idx_agent_score_refresh_requests_due
    ON agent_score_refresh_requests(requested_at, agent_id);
COMMIT;
