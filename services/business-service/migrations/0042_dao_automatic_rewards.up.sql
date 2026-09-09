BEGIN;
-- 独立奖励账本不引用任务余额；唯一业务凭证 + 固定受益人同时承担支付与到账通知去重键。
CREATE TABLE dao_reward_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id NUMERIC(78,0) NOT NULL CHECK (chain_id > 0),
  pool_address TEXT NOT NULL CHECK (pool_address ~ '^0x[0-9a-f]{40}$'),
  source_id TEXT NOT NULL CHECK (source_id ~ '^0x[0-9a-f]{64}$'),
  recipient TEXT NOT NULL CHECK (recipient ~ '^0x[0-9a-f]{40}$'),
  reward_kind TEXT NOT NULL CHECK (reward_kind IN ('arbitration','task','activity')),
  amount_minor NUMERIC(78,0) NOT NULL CHECK (amount_minor > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitted','paid','needs_review')),
  allocated_block NUMERIC(78,0) NOT NULL,
  paid_tx_hash TEXT CHECK (paid_tx_hash ~ '^0x[0-9a-f]{64}$'),
  paid_block NUMERIC(78,0),
  paid_block_hash TEXT,
  paid_at TIMESTAMPTZ,
  seen_at TIMESTAMPTZ,
  last_error_code TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(chain_id,pool_address,source_id,recipient),
  CHECK ((status='paid') = (paid_tx_hash IS NOT NULL AND paid_block IS NOT NULL AND paid_at IS NOT NULL)),
  CHECK (seen_at IS NULL OR status='paid')
);
CREATE INDEX dao_rewards_recipient ON dao_reward_transfers(recipient,created_at DESC,id);
-- 每次失败回执允许新的尝试，但旧原始签名与哈希永远保留，不以覆盖历史冒充“未广播”。
CREATE TABLE dao_reward_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reward_id UUID NOT NULL REFERENCES dao_reward_transfers(id),
  attempt_no INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND 5),
  raw_transaction TEXT NOT NULL,
  tx_hash TEXT NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('prepared','submitted','confirmed','reverted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(reward_id,attempt_no),
  UNIQUE(tx_hash)
);
CREATE TABLE dao_reward_sync_cursors (
  chain_id NUMERIC(78,0) NOT NULL,
  pool_address TEXT NOT NULL,
  next_block NUMERIC(78,0) NOT NULL CHECK (next_block >= 0),
  last_block_hash TEXT,
  halted BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY(chain_id,pool_address)
);
COMMIT;
