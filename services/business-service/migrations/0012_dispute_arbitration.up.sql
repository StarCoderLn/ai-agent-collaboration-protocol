-- Feature 13: 争议证据、两阶段仲裁决定与链上执行确认。
BEGIN;
CREATE TABLE platform_actor_roles (
    actor_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('arbitrator')),
    granted_by TEXT NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(actor_id, role)
);

CREATE TABLE dispute_config (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    evidence_window_seconds INTEGER NOT NULL DEFAULT 604800 CHECK (evidence_window_seconds > 0),
    partial_release_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO dispute_config(id) VALUES (TRUE);

CREATE TABLE disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL UNIQUE REFERENCES tasks(id),
    opened_by TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('evidence_collection','decided','executed','cancelled')),
    evidence_deadline TIMESTAMPTZ NOT NULL,
    funds_frozen BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dispute_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dispute_id UUID NOT NULL REFERENCES disputes(id),
    submitted_by TEXT NOT NULL,
    party TEXT NOT NULL CHECK (party IN ('publisher','agent')),
    description TEXT NOT NULL,
    attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE arbitration_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dispute_id UUID NOT NULL UNIQUE REFERENCES disputes(id),
    arbitrator_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('release','partial_release','refund')),
    release_amount_minor BIGINT CHECK (release_amount_minor >= 0),
    refund_amount_minor BIGINT CHECK (refund_amount_minor >= 0),
    platform_fee_minor BIGINT CHECK (platform_fee_minor IS NULL OR platform_fee_minor >= 0),
    agent_amount_minor BIGINT CHECK (agent_amount_minor IS NULL OR agent_amount_minor >= 0),
    agent_responsibility TEXT NOT NULL CHECK (agent_responsibility IN (
      'agent_at_fault','agent_not_at_fault','shared','not_determined'
    )),
    reason TEXT NOT NULL,
    execution_status TEXT NOT NULL DEFAULT 'decided' CHECK (execution_status IN ('decided','submitted','executed','failed')),
    execution_tx_hash TEXT,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    executed_at TIMESTAMPTZ,
    CHECK (
      (decision='refund' AND platform_fee_minor IS NULL AND agent_amount_minor IS NULL)
      OR
      (decision IN ('release','partial_release') AND platform_fee_minor IS NOT NULL
       AND agent_amount_minor IS NOT NULL
       AND platform_fee_minor + agent_amount_minor = release_amount_minor)
    )
);
COMMIT;
