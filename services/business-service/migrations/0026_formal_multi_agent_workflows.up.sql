-- 正式多 Agent 工作流：一个任务包含多个有依赖关系的工作节点，每个节点独立匹配、
-- 派发、执行、验收和结算。旧单 Agent 任务通过 workflow_node_id IS NULL 保持原语义。
BEGIN;

CREATE TABLE task_workflow_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL UNIQUE REFERENCES tasks(id),
    status TEXT NOT NULL DEFAULT 'planning' CHECK (status IN (
      'planning','running','awaiting_review','completed','failed','disputed','cancelled'
    )),
    version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
    currency TEXT NOT NULL DEFAULT 'USDC' CHECK (currency = 'USDC'),
    total_budget_minor BIGINT NOT NULL CHECK (total_budget_minor > 0),
    released_amount_minor BIGINT NOT NULL DEFAULT 0 CHECK (released_amount_minor >= 0),
    refundable_amount_minor BIGINT NOT NULL CHECK (refundable_amount_minor >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (released_amount_minor + refundable_amount_minor <= total_budget_minor)
);
CREATE INDEX idx_task_workflow_runs_status
    ON task_workflow_runs(status, updated_at, id);

CREATE TABLE task_workflow_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_run_id UUID NOT NULL REFERENCES task_workflow_runs(id),
    task_id UUID NOT NULL REFERENCES tasks(id),
    node_key TEXT NOT NULL CHECK (node_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
    kind TEXT NOT NULL CHECK (kind IN (
      'requirements','design','coding','testing','deployment','research','image','video','generic'
    )),
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
    description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 2000),
    category_id UUID NOT NULL REFERENCES categories(id),
    tags TEXT[] NOT NULL DEFAULT '{}',
    required_capability TEXT NOT NULL CHECK (length(trim(required_capability)) BETWEEN 1 AND 500),
    input_contract TEXT NOT NULL CHECK (length(trim(input_contract)) BETWEEN 1 AND 120),
    output_contract TEXT NOT NULL CHECK (length(trim(output_contract)) BETWEEN 1 AND 120),
    budget_cap_minor BIGINT NOT NULL CHECK (budget_cap_minor > 0),
    position_index INTEGER NOT NULL CHECK (position_index >= 0),
    status TEXT NOT NULL DEFAULT 'blocked' CHECK (status IN (
      'blocked','matching','awaiting_agent_acceptance','executing','execution_failed',
      'awaiting_review','rework','accepted','disputed','cancelled'
    )),
    version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(workflow_run_id, node_key),
    UNIQUE(workflow_run_id, position_index),
    UNIQUE(id, task_id),
    CHECK ((status = 'accepted') = (accepted_at IS NOT NULL))
);
CREATE INDEX idx_task_workflow_nodes_task
    ON task_workflow_nodes(task_id, position_index, id);
CREATE INDEX idx_task_workflow_nodes_matchable
    ON task_workflow_nodes(status, updated_at, id) WHERE status='matching';

CREATE TABLE task_workflow_edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_run_id UUID NOT NULL REFERENCES task_workflow_runs(id),
    source_node_id UUID NOT NULL REFERENCES task_workflow_nodes(id),
    target_node_id UUID NOT NULL REFERENCES task_workflow_nodes(id),
    artifact_contract TEXT NOT NULL CHECK (length(trim(artifact_contract)) BETWEEN 1 AND 120),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(workflow_run_id, source_node_id, target_node_id),
    CHECK (source_node_id <> target_node_id)
);
CREATE INDEX idx_task_workflow_edges_target
    ON task_workflow_edges(target_node_id, source_node_id);

-- 匹配快照增加节点维度。NULL 仍表示旧任务级匹配；部分唯一索引保证两个模式互不覆盖。
ALTER TABLE job_distribution_records
    ADD COLUMN workflow_node_id UUID,
    ADD CONSTRAINT fk_distribution_workflow_node_task
      FOREIGN KEY (workflow_node_id, task_id) REFERENCES task_workflow_nodes(id, task_id);
DROP INDEX uq_distribution_task_input;
CREATE UNIQUE INDEX uq_distribution_legacy_task_input
    ON job_distribution_records(task_id, input_fingerprint)
    WHERE workflow_node_id IS NULL;
CREATE UNIQUE INDEX uq_distribution_workflow_node_input
    ON job_distribution_records(workflow_node_id, input_fingerprint)
    WHERE workflow_node_id IS NOT NULL;
CREATE INDEX idx_distribution_workflow_node_time
    ON job_distribution_records(workflow_node_id, created_at DESC)
    WHERE workflow_node_id IS NOT NULL;

-- assignment 仍是全平台唯一的 Agent 占用事实，只增加所属节点；不建立第二套浅层分配表。
ALTER TABLE task_assignments
    ADD COLUMN workflow_node_id UUID,
    ADD CONSTRAINT fk_assignment_workflow_node_task
      FOREIGN KEY (workflow_node_id, task_id) REFERENCES task_workflow_nodes(id, task_id);
DROP INDEX uq_active_task_assignment;
CREATE UNIQUE INDEX uq_active_legacy_task_assignment
    ON task_assignments(task_id)
    WHERE workflow_node_id IS NULL AND status IN ('pending_ack','accepted');
CREATE UNIQUE INDEX uq_active_workflow_node_assignment
    ON task_assignments(workflow_node_id)
    WHERE workflow_node_id IS NOT NULL AND status IN ('pending_ack','accepted');
CREATE INDEX idx_task_assignments_workflow_node
    ON task_assignments(workflow_node_id, assigned_at DESC)
    WHERE workflow_node_id IS NOT NULL;

-- 节点状态迁移使用独立 outbox/inbox；Go 不直接改 TypeScript 权威节点状态机。
CREATE TABLE workflow_node_transition_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assignment_id UUID NOT NULL REFERENCES task_assignments(id),
    task_id UUID NOT NULL REFERENCES tasks(id),
    workflow_node_id UUID NOT NULL REFERENCES task_workflow_nodes(id),
    event_type TEXT NOT NULL CHECK (event_type IN (
      'assignment_locked','agent_accepted','assignment_failed'
    )),
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
      'pending','processing','delivered','dead_letter'
    )),
    attempt_no INTEGER NOT NULL DEFAULT 0 CHECK (attempt_no >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_until TIMESTAMPTZ,
    last_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at TIMESTAMPTZ,
    UNIQUE (assignment_id, event_type)
);
CREATE INDEX idx_workflow_node_transition_outbox_due
    ON workflow_node_transition_outbox(status, next_attempt_at, locked_until)
    WHERE status IN ('pending','processing');

CREATE TABLE workflow_node_transition_inbox (
    event_id UUID PRIMARY KEY,
    assignment_id UUID NOT NULL REFERENCES task_assignments(id),
    task_id UUID NOT NULL REFERENCES tasks(id),
    workflow_node_id UUID NOT NULL REFERENCES task_workflow_nodes(id),
    event_type TEXT NOT NULL CHECK (event_type IN (
      'assignment_locked','agent_accepted','assignment_failed'
    )),
    resulting_status TEXT NOT NULL,
    resulting_version BIGINT NOT NULL CHECK (resulting_version > 0),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workflow_node_execution_state (
    workflow_node_id UUID PRIMARY KEY REFERENCES task_workflow_nodes(id),
    task_id UUID NOT NULL REFERENCES tasks(id),
    assignment_id UUID NOT NULL REFERENCES task_assignments(id),
    progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    execution_state TEXT NOT NULL DEFAULT 'running' CHECK (execution_state IN (
      'running','needs_input','failed'
    )),
    failure_code TEXT,
    attention_message TEXT,
    last_reported_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((execution_state='failed') = (failure_code IS NOT NULL))
);

CREATE TABLE workflow_node_events (
    id BIGSERIAL PRIMARY KEY,
    workflow_node_id UUID NOT NULL REFERENCES task_workflow_nodes(id),
    task_id UUID NOT NULL REFERENCES tasks(id),
    node_version BIGINT NOT NULL CHECK (node_version > 0),
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(workflow_node_id, node_version)
);
CREATE INDEX idx_workflow_node_events_task
    ON workflow_node_events(task_id, id);

CREATE TABLE workflow_node_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_node_id UUID NOT NULL REFERENCES task_workflow_nodes(id),
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
    UNIQUE(workflow_node_id, batch_no, result_index),
    UNIQUE(submission_batch, result_index)
);
CREATE INDEX idx_workflow_node_results_latest
    ON workflow_node_results(workflow_node_id, submitted_at DESC) WHERE is_latest;

CREATE TABLE workflow_node_rework_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_node_id UUID NOT NULL REFERENCES task_workflow_nodes(id),
    task_id UUID NOT NULL REFERENCES tasks(id),
    result_id UUID NOT NULL REFERENCES workflow_node_results(id),
    request_no INTEGER NOT NULL CHECK (request_no > 0),
    reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 10 AND 4000),
    requested_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(workflow_node_id, request_no)
);

CREATE TABLE workflow_node_acceptances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_node_id UUID NOT NULL UNIQUE REFERENCES task_workflow_nodes(id),
    task_id UUID NOT NULL REFERENCES tasks(id),
    result_id UUID NOT NULL REFERENCES workflow_node_results(id),
    assignment_id UUID NOT NULL REFERENCES task_assignments(id),
    accepted_by TEXT NOT NULL,
    gross_amount_minor BIGINT NOT NULL CHECK (gross_amount_minor > 0),
    platform_fee_minor BIGINT NOT NULL CHECK (platform_fee_minor >= 0),
    agent_amount_minor BIGINT NOT NULL CHECK (agent_amount_minor >= 0),
    fee_rule_version TEXT NOT NULL REFERENCES platform_fee_config(version),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (platform_fee_minor + agent_amount_minor = gross_amount_minor)
);

-- 托管账本新增“已释放”余额，链上每个里程碑确认后仍保持任务托管为活动状态。
ALTER TABLE escrow_intents
    ADD COLUMN released_amount_minor NUMERIC(78,0) NOT NULL DEFAULT 0
      CHECK (released_amount_minor >= 0 AND released_amount_minor <= amount_minor);
ALTER TABLE escrow_intents DROP CONSTRAINT escrow_intents_status_check;
ALTER TABLE escrow_intents ADD CONSTRAINT escrow_intents_status_check CHECK (status IN (
  'prepared','submitted','pending_confirmation','confirmed','partially_released',
  'released','refunded','failed','needs_review'
));

ALTER TABLE escrow_execution_jobs DROP CONSTRAINT escrow_execution_jobs_source_check;
ALTER TABLE escrow_execution_jobs ADD CONSTRAINT escrow_execution_jobs_source_check CHECK (
  source IN ('acceptance','workflow_acceptance','arbitration')
);
ALTER TABLE escrow_execution_jobs DROP CONSTRAINT escrow_execution_jobs_action_check;
ALTER TABLE escrow_execution_jobs ADD CONSTRAINT escrow_execution_jobs_action_check CHECK (
  action IN ('release','milestone_release','finalize','refund')
);
ALTER TABLE escrow_execution_jobs DROP CONSTRAINT escrow_execution_jobs_check;
ALTER TABLE escrow_execution_jobs ADD CONSTRAINT escrow_execution_jobs_check CHECK (
  (action IN ('refund','finalize') AND payee IS NULL
    AND agent_gross_amount_minor IS NULL AND fee_amount_minor IS NULL)
  OR
  (action IN ('release','milestone_release') AND payee IS NOT NULL
    AND agent_gross_amount_minor IS NOT NULL AND fee_amount_minor IS NOT NULL
    AND fee_amount_minor <= agent_gross_amount_minor)
);

COMMIT;
