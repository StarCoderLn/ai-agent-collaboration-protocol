BEGIN;

-- 每次补偿签名先追加保存，再广播同一 raw transaction；进程重启不得换 nonce 重签。
CREATE TABLE dao_case_compensation_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  compensation_id UUID NOT NULL REFERENCES dao_case_compensations(id),
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  source_address TEXT NOT NULL CHECK (source_address ~ '^0x[0-9a-f]{40}$'),
  raw_transaction TEXT NOT NULL CHECK (raw_transaction ~ '^0x[0-9a-f]+$'),
  tx_hash TEXT NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared','submitted','confirmed','failed')),
  error_code TEXT,
  confirmed_block_number NUMERIC(78,0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(compensation_id,attempt_no),
  UNIQUE(tx_hash),
  CHECK ((status='confirmed')=(confirmed_block_number IS NOT NULL))
);

CREATE FUNCTION protect_dao_case_compensation_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DAO_COMPENSATION_ATTEMPT_IS_AUDIT_EVIDENCE'; END IF;
  IF ROW(NEW.id,NEW.compensation_id,NEW.attempt_no,NEW.source_address,NEW.raw_transaction,NEW.tx_hash,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.compensation_id,OLD.attempt_no,OLD.source_address,OLD.raw_transaction,OLD.tx_hash,OLD.created_at)
  THEN RAISE EXCEPTION 'DAO_COMPENSATION_ATTEMPT_IS_IMMUTABLE'; END IF;
  IF OLD.status='confirmed' THEN RAISE EXCEPTION 'DAO_COMPENSATION_ATTEMPT_IS_FINAL'; END IF;
  IF NOT (
    NEW.status=OLD.status
    OR (OLD.status='prepared' AND NEW.status IN ('submitted','failed'))
    OR (OLD.status='submitted' AND NEW.status IN ('confirmed','failed'))
  ) THEN RAISE EXCEPTION 'DAO_COMPENSATION_ATTEMPT_TRANSITION_INVALID'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dao_case_compensation_attempt_immutable
BEFORE UPDATE OR DELETE ON dao_case_compensation_attempts
FOR EACH ROW EXECUTE FUNCTION protect_dao_case_compensation_attempt();

CREATE OR REPLACE FUNCTION protect_dao_case_compensation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DAO_COMPENSATION_IS_AUDIT_EVIDENCE'; END IF;
  IF ROW(NEW.id,NEW.dispute_id,NEW.chain_id,NEW.original_escrow_contract,NEW.beneficiary,
         NEW.amount_minor,NEW.currency,NEW.reason,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.dispute_id,OLD.chain_id,OLD.original_escrow_contract,OLD.beneficiary,
         OLD.amount_minor,OLD.currency,OLD.reason,OLD.created_at)
  THEN RAISE EXCEPTION 'DAO_COMPENSATION_TERMS_ARE_IMMUTABLE'; END IF;
  IF OLD.status='confirmed' THEN RAISE EXCEPTION 'DAO_COMPENSATION_IS_FINAL'; END IF;
  IF NOT (
    NEW.status=OLD.status
    OR (OLD.status='awaiting_funding' AND NEW.status='submitted')
    OR (OLD.status='submitted' AND NEW.status IN ('confirmed','failed'))
    OR (OLD.status='failed' AND NEW.status='submitted')
  ) THEN RAISE EXCEPTION 'DAO_COMPENSATION_TRANSITION_INVALID'; END IF;
  IF OLD.payment_tx_hash IS NOT NULL AND OLD.status<>'failed'
     AND NEW.payment_tx_hash IS DISTINCT FROM OLD.payment_tx_hash
  THEN RAISE EXCEPTION 'DAO_COMPENSATION_TX_IS_IMMUTABLE'; END IF;
  RETURN NEW;
END;
$$;

COMMIT;
