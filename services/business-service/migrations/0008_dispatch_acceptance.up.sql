-- Feature 9: 候选原子占用与幂等派发。
BEGIN;
CREATE TABLE dispatch_config (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    accept_timeout_seconds INTEGER NOT NULL DEFAULT 300 CHECK (accept_timeout_seconds > 0),
    max_dispatch_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_dispatch_attempts > 0),
    max_transition_attempts INTEGER NOT NULL DEFAULT 12 CHECK (max_transition_attempts > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO dispatch_config(id) VALUES (TRUE);

CREATE TABLE task_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id),
    agent_id UUID NOT NULL REFERENCES agents(id),
    distribution_record_id UUID NOT NULL REFERENCES job_distribution_records(id),
    agreed_amount_minor BIGINT NOT NULL CHECK (agreed_amount_minor > 0),
    status TEXT NOT NULL CHECK (status IN ('pending_ack','accepted','accept_failed','cancelled')),
    version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
    assigned_by TEXT NOT NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    accept_by TIMESTAMPTZ NOT NULL,
    responded_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_active_task_assignment ON task_assignments(task_id) WHERE status IN ('pending_ack','accepted');

CREATE TABLE dispatch_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assignment_id UUID NOT NULL REFERENCES task_assignments(id),
    idempotency_key TEXT NOT NULL UNIQUE,
    protocol_request_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('queued','sent','accepted','rejected','failed','dead_letter')),
    attempt_no INTEGER NOT NULL DEFAULT 1 CHECK (attempt_no > 0),
    error_code TEXT,
    next_attempt_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Go 不直接改写 TypeScript 权威任务状态机。每次分配结果与同一事务写入 outbox，
-- 由投递器调用 Business API 的内部迁移入口；失败可重试，不会留下不可恢复的跨服务半状态。
CREATE TABLE task_transition_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assignment_id UUID NOT NULL REFERENCES task_assignments(id),
    task_id UUID NOT NULL REFERENCES tasks(id),
    event_type TEXT NOT NULL CHECK (event_type IN ('assignment_locked','agent_accepted','assignment_failed')),
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','delivered','dead_letter')),
    attempt_no INTEGER NOT NULL DEFAULT 0 CHECK (attempt_no >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_until TIMESTAMPTZ,
    last_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at TIMESTAMPTZ,
    UNIQUE (assignment_id, event_type)
);
CREATE INDEX idx_task_transition_outbox_due
    ON task_transition_outbox(status, next_attempt_at, locked_until)
    WHERE status IN ('pending','processing');

-- Business API 使用 event_id 作为 inbox 幂等键。即使状态迁移已经提交而 HTTP 响应在
-- 网络中丢失，Go worker 重投同一事件也只会读取第一次结果，不会再次推进状态机。
CREATE TABLE task_transition_inbox (
    event_id UUID PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES tasks(id),
    assignment_id UUID NOT NULL REFERENCES task_assignments(id),
    event_type TEXT NOT NULL CHECK (event_type IN ('assignment_locked','agent_accepted','assignment_failed')),
    resulting_status TEXT NOT NULL,
    resulting_status_version BIGINT NOT NULL CHECK (resulting_status_version > 0),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMIT;
