DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dao_case_compensation_attempts LIMIT 1) THEN
    RAISE EXCEPTION 'refusing to delete DAO compensation payment attempts';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS dao_case_compensation_attempt_immutable ON dao_case_compensation_attempts;
DROP FUNCTION IF EXISTS protect_dao_case_compensation_attempt();
DROP TABLE dao_case_compensation_attempts;

-- 恢复 0049 的单次付款保护函数；仅在尚无 attempt 的安全 down 路径执行。
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
  IF OLD.payment_tx_hash IS NOT NULL AND NEW.payment_tx_hash IS DISTINCT FROM OLD.payment_tx_hash
  THEN RAISE EXCEPTION 'DAO_COMPENSATION_TX_IS_IMMUTABLE'; END IF;
  RETURN NEW;
END;
$$;
