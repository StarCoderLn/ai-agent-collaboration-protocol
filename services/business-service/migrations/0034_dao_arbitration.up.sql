-- YD 链上质押资格与链下可审计分案/投票共同组成 DAO 仲裁 V1。
BEGIN;

CREATE TABLE dao_memberships (
    actor_id TEXT PRIMARY KEY CHECK (actor_id ~ '^0x[0-9a-f]{40}$'),
    chain_id BIGINT NOT NULL CHECK (chain_id > 0),
    contract_address TEXT NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
    staked_amount_minor NUMERIC(78,0) NOT NULL CHECK (staked_amount_minor >= 0),
    eligible BOOLEAN NOT NULL,
    exit_available_at TIMESTAMPTZ,
    sync_tx_hash TEXT NOT NULL CHECK (sync_tx_hash ~ '^0x[0-9a-f]{64}$'),
    sync_block_number BIGINT NOT NULL CHECK (sync_block_number >= 0),
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dao_memberships_eligible
    ON dao_memberships(synced_at DESC, actor_id) WHERE eligible=TRUE;

-- 分案参数集中在一个单例配置中，避免 API、迁移和页面分别写死 3 人/2 票/72 小时。
CREATE TABLE dao_arbitration_config (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    panel_size SMALLINT NOT NULL DEFAULT 3 CHECK (panel_size IN (3,5)),
    quorum SMALLINT NOT NULL DEFAULT 2 CHECK (quorum >= 2 AND quorum <= panel_size),
    voting_window_seconds INTEGER NOT NULL DEFAULT 259200 CHECK (voting_window_seconds > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO dao_arbitration_config(id) VALUES (TRUE);

CREATE TABLE dao_arbitration_rounds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dispute_id UUID NOT NULL UNIQUE REFERENCES disputes(id),
    selection_seed TEXT NOT NULL CHECK (selection_seed ~ '^0x[0-9a-f]{64}$'),
    panel_size SMALLINT NOT NULL DEFAULT 3 CHECK (panel_size IN (3,5)),
    quorum SMALLINT NOT NULL DEFAULT 2 CHECK (quorum >= 2 AND quorum <= panel_size),
    evidence_root TEXT CHECK (evidence_root IS NULL OR evidence_root ~ '^0x[0-9a-f]{64}$'),
    voting_deadline TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('awaiting_panel','voting','decided','cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ
);

CREATE TABLE dao_arbitration_panel_members (
    round_id UUID NOT NULL REFERENCES dao_arbitration_rounds(id),
    actor_id TEXT NOT NULL REFERENCES dao_memberships(actor_id),
    selection_order SMALLINT NOT NULL CHECK (selection_order > 0),
    selected_stake_minor NUMERIC(78,0) NOT NULL CHECK (selected_stake_minor > 0),
    selected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(round_id, actor_id),
    UNIQUE(round_id, selection_order)
);

CREATE TABLE dao_arbitration_votes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    round_id UUID NOT NULL REFERENCES dao_arbitration_rounds(id),
    actor_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('release','partial_release','refund')),
    release_basis_points SMALLINT NOT NULL CHECK (release_basis_points BETWEEN 0 AND 10000),
    agent_responsibility TEXT NOT NULL CHECK (agent_responsibility IN (
      'agent_at_fault','agent_not_at_fault','shared','not_determined'
    )),
    reasoning TEXT NOT NULL CHECK (char_length(trim(reasoning)) BETWEEN 10 AND 5000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(round_id, actor_id),
    FOREIGN KEY(round_id, actor_id) REFERENCES dao_arbitration_panel_members(round_id, actor_id),
    CHECK (
      (decision='refund' AND release_basis_points=0)
      OR (decision='release' AND release_basis_points=10000)
      OR (decision='partial_release' AND release_basis_points BETWEEN 1 AND 9999)
    )
);

ALTER TABLE arbitration_decisions
  ADD COLUMN decision_source TEXT NOT NULL DEFAULT 'platform'
    CHECK (decision_source IN ('platform','dao')),
  ADD COLUMN release_basis_points SMALLINT
    CHECK (release_basis_points IS NULL OR release_basis_points BETWEEN 0 AND 10000),
  ADD COLUMN decision_hash TEXT
    CHECK (decision_hash IS NULL OR decision_hash ~ '^0x[0-9a-f]{64}$'),
  ADD COLUMN evidence_root TEXT
    CHECK (evidence_root IS NULL OR evidence_root ~ '^0x[0-9a-f]{64}$');

ALTER TABLE escrow_execution_jobs
  ADD COLUMN decision_hash TEXT
    CHECK (decision_hash IS NULL OR decision_hash ~ '^0x[0-9a-f]{64}$');
ALTER TABLE escrow_execution_jobs DROP CONSTRAINT escrow_execution_jobs_action_check;
ALTER TABLE escrow_execution_jobs ADD CONSTRAINT escrow_execution_jobs_action_check CHECK (
  action IN ('release','milestone_release','finalize','workflow_settle','refund','dispute_refund')
);
ALTER TABLE escrow_execution_jobs DROP CONSTRAINT escrow_execution_jobs_check;
ALTER TABLE escrow_execution_jobs ADD CONSTRAINT escrow_execution_jobs_check CHECK (
  (
    action IN ('refund','finalize')
    AND payee IS NULL AND agent_gross_amount_minor IS NULL AND fee_amount_minor IS NULL
    AND workflow_payouts IS NULL AND settlement_manifest_hash IS NULL
    AND evidence_root IS NULL AND decision_hash IS NULL
  )
  OR
  (
    action IN ('release','milestone_release')
    AND payee IS NOT NULL AND agent_gross_amount_minor IS NOT NULL AND fee_amount_minor IS NOT NULL
    AND fee_amount_minor <= agent_gross_amount_minor
    AND workflow_payouts IS NULL AND settlement_manifest_hash IS NULL
    AND evidence_root IS NULL AND decision_hash IS NULL
  )
  OR
  (
    action='workflow_settle'
    AND payee IS NULL AND agent_gross_amount_minor IS NULL AND fee_amount_minor IS NULL
    AND jsonb_typeof(workflow_payouts)='array' AND jsonb_array_length(workflow_payouts) BETWEEN 1 AND 32
    AND settlement_manifest_hash IS NOT NULL AND evidence_root IS NOT NULL
  )
  OR
  (
    action='dispute_refund'
    AND payee IS NULL AND agent_gross_amount_minor IS NULL AND fee_amount_minor IS NULL
    AND workflow_payouts IS NULL AND settlement_manifest_hash IS NULL
    AND evidence_root IS NOT NULL AND decision_hash IS NOT NULL
  )
);

ALTER TABLE escrow_sync DROP CONSTRAINT escrow_sync_event_type_check;
ALTER TABLE escrow_sync ADD CONSTRAINT escrow_sync_event_type_check CHECK (
  event_type IN ('Deposited','Released','MilestoneReleased','Finalized','WorkflowSettled','Refunded','DisputeRefunded')
);

COMMENT ON TABLE dao_memberships IS
  'ArbitrationDAO 链上成员状态的可查询镜像；资格仍以指定区块的合约读取结果为准。';
COMMENT ON TABLE dao_arbitration_rounds IS
  '争议的 DAO 分案与法定人数快照；证据正文不进入该表。';
COMMENT ON TABLE dao_arbitration_config IS
  'DAO 分案规模、法定多数与投票窗口的单一权威配置。';

COMMIT;
