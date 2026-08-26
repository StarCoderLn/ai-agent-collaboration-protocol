-- Feature 6: 托管意图、链上事件游标、幂等镜像、对账与退款恢复。
BEGIN;

-- task_key 是 keccak256(task UUID 文本)；先建立明确映射，链上 bytes32 事件才能安全地
-- 找回链下任务。业务金额在 currency='ETH' 时以 wei 存储，禁止在同步器里做浮点换算。
CREATE TABLE escrow_intents (
    task_id UUID PRIMARY KEY REFERENCES tasks(id),
    chain_id BIGINT NOT NULL CHECK (chain_id > 0),
    contract_address TEXT NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
    task_key TEXT NOT NULL CHECK (task_key ~ '^0x[0-9a-f]{64}$'),
    payer_wallet TEXT NOT NULL CHECK (payer_wallet ~ '^0x[0-9a-f]{40}$'),
    amount_wei NUMERIC(78,0) NOT NULL CHECK (amount_wei > 0),
    status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN (
      'prepared','submitted','pending_confirmation','confirmed','released','refunded','failed','needs_review'
    )),
    deposit_tx_hash TEXT CHECK (deposit_tx_hash IS NULL OR deposit_tx_hash ~ '^0x[0-9a-f]{64}$'),
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(chain_id, contract_address, task_key)
);
CREATE INDEX idx_escrow_intents_status ON escrow_intents(status, updated_at);
CREATE UNIQUE INDEX uq_escrow_intents_deposit_tx
    ON escrow_intents(chain_id, deposit_tx_hash) WHERE deposit_tx_hash IS NOT NULL;

CREATE TABLE escrow_sync (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES tasks(id),
    chain_id BIGINT NOT NULL CHECK (chain_id > 0),
    contract_address TEXT NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
    task_key TEXT NOT NULL CHECK (task_key ~ '^0x[0-9a-f]{64}$'),
    tx_hash TEXT NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
    log_index INTEGER NOT NULL CHECK (log_index >= 0),
    event_type TEXT NOT NULL CHECK (event_type IN ('Deposited','Released','Refunded')),
    amount_wei NUMERIC(78,0) NOT NULL CHECK (amount_wei >= 0),
    event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL CHECK (status IN ('pending_confirmation','confirmed','failed','orphaned','needs_review')),
    block_number BIGINT NOT NULL CHECK (block_number >= 0),
    block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
    confirmations INTEGER NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
    task_transitioned BOOLEAN NOT NULL DEFAULT FALSE,
    resulting_status_version BIGINT CHECK (resulting_status_version IS NULL OR resulting_status_version >= 0),
    failure_reason TEXT,
    canonical_checked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(chain_id, tx_hash, log_index),
    CHECK (jsonb_typeof(event_payload) = 'object')
);
CREATE INDEX idx_escrow_sync_task ON escrow_sync(task_id, created_at DESC);
CREATE INDEX idx_escrow_sync_confirmation ON escrow_sync(status, block_number) WHERE status IN ('pending_confirmation','confirmed');

CREATE TABLE chain_event_cursor (
    chain_id BIGINT NOT NULL CHECK (chain_id > 0),
    contract_address TEXT NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
    next_block BIGINT NOT NULL CHECK (next_block >= 0),
    last_processed_block_hash TEXT CHECK (last_processed_block_hash IS NULL OR last_processed_block_hash ~ '^0x[0-9a-f]{64}$'),
    lease_owner TEXT,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(chain_id, contract_address)
);

CREATE TABLE reconciliation_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id),
    discrepancy_summary JSONB NOT NULL,
    operations_frozen BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_reconciliation_alert_open_task ON reconciliation_alerts(task_id) WHERE resolved_at IS NULL;

CREATE TABLE refund_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id),
    attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
    status TEXT NOT NULL CHECK (status IN ('retry_pending','submitted','confirmed','manual_review')),
    idempotency_key TEXT NOT NULL UNIQUE,
    tx_hash TEXT CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
    error_message TEXT,
    next_attempt_at TIMESTAMPTZ,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(task_id, attempt_no)
);

-- 所有 operator 资金操作先进入同一个 outbox。普通验收与仲裁不得各自直连链节点，
-- worker 在持有任务行锁时再次校验 task.status，消除“争议已冻结但旧结算仍发送”的竞态。
CREATE TABLE escrow_execution_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id),
    source TEXT NOT NULL CHECK (source IN ('acceptance','arbitration')),
    source_ref UUID NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('release','refund')),
    payee TEXT CHECK (payee IS NULL OR payee ~ '^0x[0-9a-f]{40}$'),
    agent_gross_amount_wei NUMERIC(78,0) CHECK (agent_gross_amount_wei IS NULL OR agent_gross_amount_wei >= 0),
    fee_amount_wei NUMERIC(78,0) CHECK (fee_amount_wei IS NULL OR fee_amount_wei >= 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
      'pending','processing','prepared','submitted','failed','dead_letter','executed','cancelled'
    )),
    attempt_no INTEGER NOT NULL DEFAULT 0 CHECK (attempt_no >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lock_token UUID,
    lock_expires_at TIMESTAMPTZ,
    tx_hash TEXT CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
    raw_transaction TEXT CHECK (raw_transaction IS NULL OR raw_transaction ~ '^0x[0-9a-f]+$'),
    last_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(source, source_ref),
    CHECK (
      (action='refund' AND payee IS NULL AND agent_gross_amount_wei IS NULL AND fee_amount_wei IS NULL)
      OR
      (action='release' AND payee IS NOT NULL AND agent_gross_amount_wei IS NOT NULL
       AND fee_amount_wei IS NOT NULL AND fee_amount_wei <= agent_gross_amount_wei)
    )
);
CREATE INDEX idx_escrow_execution_jobs_due
    ON escrow_execution_jobs(status,next_attempt_at) WHERE status IN ('pending','prepared','failed','processing');

COMMIT;
