BEGIN;

-- 平台补偿是独立付款事实，不能修改旧 Escrow 或把外部转账标记成原托管退款。
CREATE TABLE dao_case_compensations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL UNIQUE REFERENCES disputes(id),
  chain_id NUMERIC(78,0) NOT NULL CHECK (chain_id > 0),
  original_escrow_contract TEXT NOT NULL CHECK (original_escrow_contract ~ '^0x[0-9a-f]{40}$'),
  beneficiary TEXT NOT NULL CHECK (beneficiary ~ '^0x[0-9a-f]{40}$'),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency='USDC'),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 2000),
  status TEXT NOT NULL DEFAULT 'awaiting_funding'
    CHECK (status IN ('awaiting_funding','submitted','confirmed','failed')),
  payment_tx_hash TEXT CHECK (payment_tx_hash ~ '^0x[0-9a-f]{64}$'),
  confirmed_block_number NUMERIC(78,0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (status='awaiting_funding' AND payment_tx_hash IS NULL AND confirmed_block_number IS NULL)
    OR (status IN ('submitted','failed') AND payment_tx_hash IS NOT NULL AND confirmed_block_number IS NULL)
    OR (status='confirmed' AND payment_tx_hash IS NOT NULL AND confirmed_block_number IS NOT NULL)
  )
);

CREATE FUNCTION protect_dao_case_compensation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DAO_COMPENSATION_IS_AUDIT_EVIDENCE'; END IF;
  IF ROW(NEW.id,NEW.dispute_id,NEW.chain_id,NEW.original_escrow_contract,NEW.beneficiary,
         NEW.amount_minor,NEW.currency,NEW.reason,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.dispute_id,OLD.chain_id,OLD.original_escrow_contract,OLD.beneficiary,
         OLD.amount_minor,OLD.currency,OLD.reason,OLD.created_at)
  THEN RAISE EXCEPTION 'DAO_COMPENSATION_TERMS_ARE_IMMUTABLE'; END IF;
  IF OLD.status='confirmed' THEN RAISE EXCEPTION 'DAO_COMPENSATION_IS_FINAL'; END IF;
  IF OLD.payment_tx_hash IS NOT NULL AND NEW.payment_tx_hash IS DISTINCT FROM OLD.payment_tx_hash
  THEN RAISE EXCEPTION 'DAO_COMPENSATION_TX_IS_IMMUTABLE'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dao_case_compensation_immutable
BEFORE UPDATE OR DELETE ON dao_case_compensations
FOR EACH ROW EXECUTE FUNCTION protect_dao_case_compensation();

COMMIT;
