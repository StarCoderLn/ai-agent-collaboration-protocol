-- 独立链上案件是新版裁决权威；旧 dao_arbitration_rounds 不搬迁、不重算历史投票。
-- 行记录在争议冻结事务中建立，后续 worker 只把链上已确认事实投影到此表。
CREATE TABLE dao_chain_cases (
  dispute_id UUID PRIMARY KEY REFERENCES disputes(id),
  chain_id NUMERIC(78,0) NOT NULL CHECK (chain_id > 0),
  contract_address TEXT NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  case_key TEXT NOT NULL CHECK (case_key ~ '^0x[0-9a-f]{64}$'),
  task_key TEXT NOT NULL CHECK (task_key ~ '^0x[0-9a-f]{64}$'),
  initial_evidence_root TEXT NOT NULL CHECK (initial_evidence_root ~ '^0x[0-9a-f]{64}$'),
  parties JSONB NOT NULL CHECK (jsonb_typeof(parties)='array'),
  status TEXT NOT NULL DEFAULT 'pending_registration' CHECK (status IN (
    'pending_registration','evidence','awaiting_panel','awaiting_randomness','randomness_ready',
    'voting','appeal_window','final','stalled'
  )),
  snapshot JSONB,
  synced_block_number NUMERIC(78,0),
  synced_block_hash TEXT,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(chain_id,contract_address,case_key),
  UNIQUE(chain_id,contract_address,task_key)
);

-- 先存签名交易再广播；一个确定性动作只允许一份命令，未知回执不能生成另一份交易。
CREATE TABLE dao_case_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL REFERENCES dao_chain_cases(dispute_id),
  command_key TEXT NOT NULL,
  calldata TEXT NOT NULL CHECK (calldata ~ '^0x[0-9a-f]+$'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','prepared','submitted','confirmed','failed')),
  tx_hash TEXT,
  raw_transaction TEXT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(dispute_id,command_key),
  CHECK ((tx_hash IS NULL) = (raw_transaction IS NULL))
);
CREATE INDEX dao_case_commands_pending ON dao_case_commands(created_at) WHERE status IN ('pending','prepared','submitted');

-- 投票理由正文只存权限数据库，链上存摘要。同一成员可以准备不同草稿，但实际只有链上
-- 唯一的一票有效；不能把“准备了一笔交易”当成已经投票或发放奖励的依据。
CREATE TABLE dao_case_vote_reasons (
  dispute_id UUID NOT NULL REFERENCES dao_chain_cases(dispute_id),
  round SMALLINT NOT NULL CHECK (round IN (1,2)),
  actor_id TEXT NOT NULL CHECK (actor_id ~ '^0x[0-9a-f]{40}$'),
  reasoning_hash TEXT NOT NULL CHECK (reasoning_hash ~ '^0x[0-9a-f]{64}$'),
  reasoning TEXT NOT NULL CHECK (length(reasoning) BETWEEN 10 AND 5000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (dispute_id,round,actor_id,reasoning_hash)
);

-- 证据承诺不回填旧数据，避免把迁移当时计算出的哈希冒充原始提交证明。
ALTER TABLE dispute_evidence ADD COLUMN content_hash TEXT CHECK (content_hash ~ '^0x[0-9a-f]{64}$');
ALTER TABLE dispute_evidence ADD COLUMN anchor_tx_hash TEXT CHECK (anchor_tx_hash ~ '^0x[0-9a-f]{64}$');

-- 应用账号不能修改或删除新版证据正文；追加证据另起一行，链确认仅允许补充锚定字段。
CREATE FUNCTION protect_committed_dispute_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.content_hash IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'COMMITTED_EVIDENCE_IS_APPEND_ONLY'; END IF;
    IF ROW(NEW.id,NEW.dispute_id,NEW.submitted_by,NEW.party,NEW.description,NEW.attachments,NEW.created_at,NEW.content_hash)
       IS DISTINCT FROM ROW(OLD.id,OLD.dispute_id,OLD.submitted_by,OLD.party,OLD.description,OLD.attachments,OLD.created_at,OLD.content_hash)
    THEN RAISE EXCEPTION 'COMMITTED_EVIDENCE_IS_APPEND_ONLY'; END IF;
    IF OLD.anchor_tx_hash IS NOT NULL AND NEW.anchor_tx_hash IS DISTINCT FROM OLD.anchor_tx_hash
    THEN RAISE EXCEPTION 'EVIDENCE_ANCHOR_IS_IMMUTABLE'; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER committed_dispute_evidence_immutable BEFORE UPDATE OR DELETE ON dispute_evidence
FOR EACH ROW EXECUTE FUNCTION protect_committed_dispute_evidence();
