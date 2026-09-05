-- Agent 自动准入：将“人工审核”替换为可恢复的三次试运行与自动质量评测。
--
-- sandbox_test_runs 继续保存每一次实际调用；本表只保存一轮准入的调度、结论和
-- 恢复租约。两类事实分开后，Worker 重启时可以精确判断是继续调用、继续评测，还是
-- 只补做生命周期迁移，而不需要根据零散字段猜测当前阶段。
BEGIN;

CREATE TABLE sandbox_admission_rounds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
    trigger_type TEXT NOT NULL CHECK (trigger_type IN ('initial', 'provider_retry')),
    -- 提供者重试使用公网请求的 Idempotency-Key；初始自动轮次没有外部请求，因此为空。
    request_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'passed', 'failed')),
    technical_passed BOOLEAN,
    final_score SMALLINT CHECK (final_score BETWEEN 0 AND 100),
    evaluator_model TEXT,
    failure_code TEXT,
    summary TEXT,
    evaluation_report JSONB CHECK (
        evaluation_report IS NULL OR jsonb_typeof(evaluation_report) = 'object'
    ),
    lock_token UUID,
    locked_until TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (agent_id, attempt_no),
    CHECK ((trigger_type = 'initial') = (request_id IS NULL)),
    -- 只有 running 轮次持有租约；完成态必须同时具有完成时间。
    CHECK ((status = 'running') = (lock_token IS NOT NULL AND locked_until IS NOT NULL)),
    CHECK ((status IN ('passed', 'failed')) = (completed_at IS NOT NULL))
);

-- 同一个 Agent 同时只能有一轮未完成准入。该约束让多实例 Worker 和用户重复点击
-- “重新验证”最终收敛到同一个轮次，而不是并发产生六次或更多模型调用。
CREATE UNIQUE INDEX uq_sandbox_admission_open_round
    ON sandbox_admission_rounds(agent_id)
    WHERE status IN ('queued', 'running');
CREATE INDEX idx_sandbox_admission_worker
    ON sandbox_admission_rounds(status, next_attempt_at, locked_until, created_at)
    WHERE status IN ('queued', 'running');

-- 旧字段名 reviewer_id 保留是为了兼容已经部署的表结构；自动评测写入稳定的系统身份，
-- 新增列保存机器评测分数与报告。历史人工记录仍可审计，但不会再参与新 Agent 准入。
ALTER TABLE sandbox_evaluations
    ADD COLUMN score SMALLINT CHECK (score BETWEEN 0 AND 100),
    ADD COLUMN evaluator_model TEXT,
    ADD COLUMN evaluation_report JSONB CHECK (
        evaluation_report IS NULL OR jsonb_typeof(evaluation_report) = 'object'
    );

-- v2 模板包含三个不同的标准任务。Worker 会把 Agent 自述能力和标签补入每个任务，
-- 因而它既保持题目结构稳定，也不会要求图片、论文和 Coding Agent 完成同一种产物。
INSERT INTO sandbox_test_templates(
    id, category_id, test_input, checklist_items, version
) VALUES (
    '15000000-0000-4000-8000-000000000002',
    NULL,
    '{
      "cases": [
        {
          "title": "核心能力演示",
          "description": "请围绕你声明的核心能力，为一个虚构的新产品完成一份具有代表性、可以直接查看的最小交付物。",
          "acceptanceCriteria": "交付物必须与声明能力一致、内容完整，并能让使用者直接判断质量。",
          "deliverableFormat": "返回至少一个符合平台协议的可验收产物。"
        },
        {
          "title": "约束遵循测试",
          "description": "请完成一份小型示例，明确说明关键假设，并确保最终产物同时满足任务目标和输出格式要求。",
          "acceptanceCriteria": "不得只给过程说明；必须提供实际产物，且不得虚构未使用的工具、来源或执行结果。",
          "deliverableFormat": "返回结构清晰、内容可用的最终产物。"
        },
        {
          "title": "信息不完整场景测试",
          "description": "面对一个细节不完整但可以合理推进的需求，请做最少必要假设并完成一份代表性交付。",
          "acceptanceCriteria": "假设必须清楚、不过度扩张需求，产物应与 Agent 声明能力直接相关且可以验收。",
          "deliverableFormat": "返回最终产物，并在摘要中说明采用的主要假设。"
        }
      ]
    }'::jsonb,
    '[
      {"key":"protocol_noncompliant","label":"响应违反平台协议或无法解析。","expected":false,"source":"automatic"},
      {"key":"request_failed","label":"Agent 返回错误或没有可用产物。","expected":false,"source":"automatic"},
      {"key":"format_invalid","label":"产物为空、乱码、损坏或无法直接查看。","expected":false,"source":"ai_evaluator"},
      {"key":"off_topic","label":"产物与测试任务或 Agent 声明能力明显无关。","expected":false,"source":"ai_evaluator"},
      {"key":"requirement_missed","label":"产物遗漏测试任务的关键验收要求。","expected":false,"source":"ai_evaluator"},
      {"key":"unsafe_or_fabricated","label":"产物包含明显不安全内容或虚构执行事实。","expected":false,"source":"ai_evaluator"}
    ]'::jsonb,
    2
);

COMMIT;
