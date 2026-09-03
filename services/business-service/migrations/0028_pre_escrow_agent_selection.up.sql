-- 托管前工作流选人：任务先拆分并冻结每个节点的 Agent 报价，再按准确合计金额托管。
-- selection 与 assignment 明确分离：前者是报价选择，后者才会占用 Agent 并派发。
BEGIN;

ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN (
  'draft','planning','awaiting_escrow','matching','awaiting_agent_acceptance','executing',
  'awaiting_review','rework','pending_settlement','execution_failed','settled',
  'disputed','refunded','timed_out'
));

ALTER TABLE task_workflow_nodes DROP CONSTRAINT task_workflow_nodes_status_check;
ALTER TABLE task_workflow_nodes ADD CONSTRAINT task_workflow_nodes_status_check CHECK (status IN (
  'selecting','selected','blocked','matching','awaiting_agent_acceptance','executing',
  'execution_failed','awaiting_review','rework','accepted','disputed','cancelled'
));

ALTER TABLE task_workflow_nodes
  ADD COLUMN selected_agent_id UUID REFERENCES agents(id),
  ADD COLUMN selection_record_id UUID REFERENCES job_distribution_records(id),
  ADD COLUMN agreed_amount_minor BIGINT CHECK (agreed_amount_minor > 0),
  ADD CONSTRAINT task_workflow_nodes_selection_check CHECK (
    (selected_agent_id IS NULL AND selection_record_id IS NULL AND agreed_amount_minor IS NULL)
    OR
    (selected_agent_id IS NOT NULL AND selection_record_id IS NOT NULL AND agreed_amount_minor IS NOT NULL)
  );

ALTER TABLE task_workflow_runs
  ADD COLUMN quoted_total_minor BIGINT CHECK (quoted_total_minor > 0),
  ADD COLUMN quote_confirmed_at TIMESTAMPTZ,
  ADD CONSTRAINT task_workflow_runs_quote_check CHECK (
    (quoted_total_minor IS NULL AND quote_confirmed_at IS NULL)
    OR
    (quoted_total_minor IS NOT NULL AND quote_confirmed_at IS NOT NULL)
  );

-- 既有工作流已经按 total_budget_minor 完成托管或正在执行。迁移只补齐兼容事实，
-- 不伪造各节点在新流程中的选择记录。
UPDATE task_workflow_runs
   SET quoted_total_minor=total_budget_minor,
       quote_confirmed_at=created_at;

CREATE INDEX idx_workflow_nodes_selection_agent
    ON task_workflow_nodes(selected_agent_id, updated_at DESC)
    WHERE selected_agent_id IS NOT NULL;

-- 平台验收案例直接从工作流结果读取；本表只保存提供者主动提交的公开案例，避免把
-- 自述内容伪装成平台已验证成绩。
CREATE TABLE agent_portfolio_cases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
    summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 600),
    artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('document','image','video','website','code','other')),
    preview_ref TEXT NOT NULL CHECK (length(trim(preview_ref)) BETWEEN 1 AND 2000),
    category_id UUID REFERENCES categories(id),
    tags TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_portfolio_cases_agent
    ON agent_portfolio_cases(agent_id, created_at DESC, id);

COMMIT;
