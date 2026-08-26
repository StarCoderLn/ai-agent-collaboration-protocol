-- Feature 11: 单调执行进度、每批 1~3 个版本化结果、返工与验收快照。
BEGIN;

CREATE TABLE task_execution_state (
    task_id UUID PRIMARY KEY REFERENCES tasks(id),
    assignment_id UUID NOT NULL REFERENCES task_assignments(id),
    progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    last_reported_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Agent 回调使用幂等键 + body 指纹。响应丢失后的重投返回同一快照；同一个键换 body
-- 会被拒绝，不能把“幂等”误实现成无条件吞掉第二个请求。
CREATE TABLE agent_callback_inbox (
    idempotency_key TEXT PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES tasks(id),
    assignment_id UUID NOT NULL REFERENCES task_assignments(id),
    operation TEXT NOT NULL CHECK (operation IN ('execution_status','result_submit')),
    request_fingerprint TEXT NOT NULL,
    response_snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 一批提交对应 1~3 行；每个候选结果都有稳定 result_id，发布者才能明确选择其中一个。
CREATE TABLE task_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id),
    assignment_id UUID NOT NULL REFERENCES task_assignments(id),
    submission_batch UUID NOT NULL,
    batch_no INTEGER NOT NULL CHECK (batch_no > 0),
    result_index INTEGER NOT NULL CHECK (result_index BETWEEN 1 AND 3),
    summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 1000),
    artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('inline','file')),
    body_or_file_ref TEXT NOT NULL CHECK (length(body_or_file_ref) > 0),
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
    generated_at TIMESTAMPTZ NOT NULL,
    note TEXT,
    is_latest BOOLEAN NOT NULL DEFAULT TRUE,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(task_id, batch_no, result_index),
    UNIQUE(submission_batch, result_index)
);
CREATE INDEX idx_task_results_latest ON task_results(task_id, submitted_at DESC) WHERE is_latest;

CREATE TABLE rework_config (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    max_rework_count INTEGER NOT NULL DEFAULT 2 CHECK (max_rework_count >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO rework_config(id) VALUES (TRUE);

CREATE TABLE rework_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id),
    result_id UUID NOT NULL REFERENCES task_results(id),
    request_no INTEGER NOT NULL CHECK (request_no > 0),
    reason TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(task_id, request_no)
);

-- 验收时冻结成交金额与当时生效的手续费规则，后续改费率或 Agent 报价都不能改写
-- 已确认结算明细。实际链上 release 由 feature 6 消费本快照。
CREATE TABLE task_acceptances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL UNIQUE REFERENCES tasks(id),
    result_id UUID NOT NULL REFERENCES task_results(id),
    assignment_id UUID NOT NULL REFERENCES task_assignments(id),
    accepted_by TEXT NOT NULL,
    gross_amount_minor BIGINT NOT NULL CHECK (gross_amount_minor > 0),
    platform_fee_minor BIGINT NOT NULL CHECK (platform_fee_minor >= 0),
    agent_amount_minor BIGINT NOT NULL CHECK (agent_amount_minor >= 0),
    fee_rule_version TEXT NOT NULL REFERENCES platform_fee_config(version),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (platform_fee_minor + agent_amount_minor = gross_amount_minor)
);
COMMIT;
