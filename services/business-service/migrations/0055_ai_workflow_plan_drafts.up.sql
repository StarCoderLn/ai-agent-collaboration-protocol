-- AI 工作流草案与正式交易 DAG 分离：模型和用户可以产生多个可审计修订，只有发布者
-- 明确确认的当前版本才允许固化到 task_workflow_runs/nodes/edges。
BEGIN;

CREATE TABLE task_workflow_plan_revisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id),
    revision BIGINT NOT NULL CHECK (revision > 0),
    source TEXT NOT NULL CHECK (source IN ('template','ai','user')),
    provider TEXT,
    model TEXT,
    prompt_version TEXT,
    summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 500),
    assumptions JSONB NOT NULL CHECK (jsonb_typeof(assumptions) = 'array'),
    nodes JSONB NOT NULL CHECK (jsonb_typeof(nodes) = 'array'),
    edges JSONB NOT NULL CHECK (jsonb_typeof(edges) = 'array'),
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(task_id, revision),
    UNIQUE(task_id, id)
);

CREATE TABLE task_workflow_plan_heads (
    task_id UUID PRIMARY KEY REFERENCES tasks(id),
    current_revision_id UUID NOT NULL,
    current_revision BIGINT NOT NULL CHECK (current_revision > 0),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed')),
    version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
    confirmed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (task_id, current_revision_id)
      REFERENCES task_workflow_plan_revisions(task_id, id),
    CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL))
);

CREATE INDEX idx_workflow_plan_revisions_task
    ON task_workflow_plan_revisions(task_id, revision DESC);
CREATE INDEX idx_workflow_plan_heads_draft
    ON task_workflow_plan_heads(status, updated_at, task_id)
    WHERE status = 'draft';

COMMIT;
