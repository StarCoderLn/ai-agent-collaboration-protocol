-- Feature 10: 单调状态事件、Webhook 投递与 SSE 断线续传来源。
BEGIN;
CREATE TABLE task_events (
    id BIGSERIAL PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES tasks(id),
    status_version BIGINT NOT NULL CHECK (status_version > 0),
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(task_id, status_version)
);
CREATE INDEX idx_task_events_replay ON task_events(task_id, id);

-- 通知重试参数属于运行时业务配置，不能散落在 Go worker 的常量里。生产环境可通过
-- 受控 migration/运营配置调整；worker 每次失败落库时读取当前值。
CREATE TABLE notification_config (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    max_webhook_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_webhook_attempts > 0),
    base_retry_seconds INTEGER NOT NULL DEFAULT 1 CHECK (base_retry_seconds > 0),
    max_retry_seconds INTEGER NOT NULL DEFAULT 300 CHECK (max_retry_seconds > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO notification_config(id) VALUES (TRUE);

CREATE TABLE webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_event_id BIGINT NOT NULL REFERENCES task_events(id),
    agent_id UUID NOT NULL REFERENCES agents(id),
    -- 保存事件产生时的端点快照。Agent 后续修改档案不会让历史投递悄悄改投新地址。
    endpoint TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('pending','processing','delivered','retry_pending','dead_letter')),
    attempt_no INTEGER NOT NULL DEFAULT 0 CHECK (attempt_no >= 0),
    last_error_code TEXT,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_until TIMESTAMPTZ,
    -- token 防止租约过期后，旧 worker 覆盖新 worker 已经完成的投递结果。
    lock_token UUID,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(task_event_id, agent_id)
);
CREATE INDEX idx_webhook_deliveries_due
    ON webhook_deliveries(status, next_attempt_at, locked_until)
    WHERE status IN ('pending','processing','retry_pending');
CREATE INDEX idx_webhook_deliveries_dead_letter
    ON webhook_deliveries(updated_at DESC, id)
    WHERE status='dead_letter';
COMMIT;
