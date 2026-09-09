-- 创世激励把业务资格、链上分配和最终付款拆成三个可恢复阶段。
-- 本表只保存已经由平台权威事实证明的奖励命令，不读取或占用任务托管资金。
BEGIN;

CREATE TABLE platform_verified_wallets (
  wallet_address TEXT PRIMARY KEY CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  first_verified_at TIMESTAMPTZ NOT NULL
);

-- 已存在的成功 SIWE 会话也是验证证据；迁移只补权威索引，不直接发币。
INSERT INTO platform_verified_wallets(wallet_address,first_verified_at)
SELECT lower(wallet_address),min(created_at) FROM auth_sessions GROUP BY lower(wallet_address)
ON CONFLICT DO NOTHING;

CREATE FUNCTION remember_verified_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO platform_verified_wallets(wallet_address,first_verified_at)
  VALUES(lower(NEW.wallet_address),NEW.created_at)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER auth_session_remembers_verified_wallet AFTER INSERT ON auth_sessions
FOR EACH ROW EXECUTE FUNCTION remember_verified_wallet();

CREATE TABLE dao_reward_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id NUMERIC(78,0) NOT NULL CHECK (chain_id > 0),
  pool_address TEXT NOT NULL CHECK (pool_address ~ '^0x[0-9a-f]{40}$'),
  campaign_id TEXT NOT NULL CHECK (campaign_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  program_code TEXT NOT NULL CHECK (program_code IN (
    'verified_user','funded_task','completed_task_publisher','agent_admission',
    'agent_first_delivery','agent_delivery','arbitration_vote'
  )),
  fact_id TEXT NOT NULL CHECK (length(fact_id) BETWEEN 1 AND 200),
  source_id TEXT NOT NULL CHECK (source_id ~ '^0x[0-9a-f]{64}$'),
  recipient TEXT NOT NULL CHECK (recipient ~ '^0x[0-9a-f]{40}$'),
  reward_kind TEXT NOT NULL CHECK (reward_kind IN ('arbitration','task','activity')),
  amount_minor NUMERIC(78,0) NOT NULL CHECK (amount_minor > 0),
  occurred_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','prepared','submitted','confirmed','skipped_wallet_cap','needs_review'
  )),
  last_error_code TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(chain_id,pool_address,campaign_id,program_code,fact_id,recipient),
  UNIQUE(chain_id,pool_address,source_id)
);
CREATE INDEX dao_reward_grants_due ON dao_reward_grants(status,next_attempt_at,created_at)
WHERE status IN ('pending','prepared','submitted');
CREATE INDEX dao_reward_grants_recipient ON dao_reward_grants(campaign_id,recipient,status);

-- 原始签名先于广播持久化；响应丢失时只能重播相同字节，不能另签相同 nonce。
CREATE TABLE dao_reward_grant_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id UUID NOT NULL REFERENCES dao_reward_grants(id),
  attempt_no INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND 5),
  raw_transaction TEXT NOT NULL,
  tx_hash TEXT NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('prepared','submitted','confirmed','reverted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(grant_id,attempt_no),
  UNIQUE(tx_hash)
);

COMMIT;
