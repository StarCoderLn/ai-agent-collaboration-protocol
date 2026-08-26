-- Feature 15: 新 Agent 沙箱准入（T-001）。
--
-- 沙箱调用与正式任务在物理表上隔离：本 migration 不引用 tasks、task_assignments、
-- scoring_* 或资金表。round_id 是一次“三次调用”轮次的稳定幂等标识；同一 Agent
-- 在修复后重测时使用新的 round_id，进程重试时继续使用原 round_id。
BEGIN;

CREATE TABLE sandbox_test_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- NULL 表示所有分类的通用兜底模板；分类专属模板优先于通用模板。
    category_id UUID REFERENCES categories(id),
    test_input JSONB NOT NULL CHECK (jsonb_typeof(test_input) = 'object'),
    checklist_items JSONB NOT NULL CHECK (
        jsonb_typeof(checklist_items) = 'array'
        AND jsonb_array_length(checklist_items) > 0
    ),
    version INTEGER NOT NULL CHECK (version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deprecated_at TIMESTAMPTZ,
    CHECK (deprecated_at IS NULL OR deprecated_at >= created_at)
);

-- PostgreSQL 的普通 UNIQUE 允许多个 NULL，通用模板和分类模板需要分别约束。
CREATE UNIQUE INDEX uq_sandbox_template_generic_version
    ON sandbox_test_templates(version) WHERE category_id IS NULL;
CREATE UNIQUE INDEX uq_sandbox_template_category_version
    ON sandbox_test_templates(category_id, version) WHERE category_id IS NOT NULL;
CREATE INDEX idx_sandbox_templates_lookup
    ON sandbox_test_templates(category_id, version DESC) WHERE deprecated_at IS NULL;

CREATE TABLE sandbox_test_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    template_id UUID NOT NULL REFERENCES sandbox_test_templates(id),
    round_id UUID NOT NULL,
    run_no SMALLINT NOT NULL CHECK (run_no BETWEEN 1 AND 3),
    -- 沙箱表只允许 sandbox，避免调用方遗漏标记后把 production 结果写进准入证据。
    call_type TEXT NOT NULL DEFAULT 'sandbox' CHECK (call_type = 'sandbox'),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    output_ref TEXT,
    technical_metrics JSONB CHECK (
        technical_metrics IS NULL OR jsonb_typeof(technical_metrics) = 'object'
    ),
    lock_token UUID,
    locked_until TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (agent_id, round_id, run_no),
    -- running 必须且只能带完整租约；其它状态禁止残留半个或过期租约字段。
    CHECK ((status = 'running') = (lock_token IS NOT NULL AND locked_until IS NOT NULL)),
    CHECK (
        status IN ('pending', 'running')
        OR (technical_metrics IS NOT NULL AND completed_at IS NOT NULL)
    )
);
CREATE INDEX idx_sandbox_runs_agent_round
    ON sandbox_test_runs(agent_id, round_id, run_no);
CREATE INDEX idx_sandbox_runs_recoverable
    ON sandbox_test_runs(status, locked_until)
    WHERE status IN ('pending', 'running');

CREATE TABLE sandbox_evaluations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    round_id UUID NOT NULL,
    run_ids JSONB NOT NULL CHECK (
        jsonb_typeof(run_ids) = 'array'
        AND jsonb_array_length(run_ids) = 3
    ),
    reviewer_id TEXT NOT NULL,
    checked_items JSONB NOT NULL CHECK (jsonb_typeof(checked_items) = 'object'),
    decision TEXT NOT NULL CHECK (decision IN ('passed', 'not_passed')),
    decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (agent_id, round_id)
);
CREATE INDEX idx_sandbox_evaluations_reviewer_time
    ON sandbox_evaluations(reviewer_id, decided_at DESC);

-- 稳定 ID 让本地环境、测试和后续运营页面不依赖插入顺序。清单项统一写成
-- “发现了负面问题吗”，false 才表示通过，消除“未跑题应该勾是还是勾否”的歧义。
INSERT INTO sandbox_test_templates(
    id, category_id, test_input, checklist_items, version
) VALUES (
    '15000000-0000-4000-8000-000000000001',
    NULL,
    '{
      "objective": "Return a concise capability demonstration for the supplied request.",
      "request": "Explain the approach, produce one representative deliverable, and state any assumptions.",
      "constraints": ["Return valid JSON", "Do not claim tools or evidence that were not used"]
    }'::jsonb,
    '[
      {"key":"protocol_noncompliant","label":"The response violates the platform protocol or cannot be parsed.","expected":false,"source":"automatic"},
      {"key":"request_failed","label":"The Agent returned an error instead of a usable result.","expected":false,"source":"automatic"},
      {"key":"format_invalid","label":"The output format is empty, garbled, or clearly invalid.","expected":false,"source":"reviewer"},
      {"key":"off_topic","label":"The output is materially unrelated to the test request.","expected":false,"source":"reviewer"},
      {"key":"obvious_template_copy","label":"The output is an obvious unrelated template copy.","expected":false,"source":"reviewer"}
    ]'::jsonb,
    1
);

COMMIT;
