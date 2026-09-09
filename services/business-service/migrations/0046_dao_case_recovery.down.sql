-- 存在恢复中案件时禁止降级，否则旧服务无法解释该状态并可能停止资金恢复。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dao_chain_cases WHERE status='recovery') THEN
    RAISE EXCEPTION 'DAO_CASE_RECOVERY_STATE_MUST_BE_RETAINED';
  END IF;
END $$;

BEGIN;
ALTER TABLE dao_chain_cases DROP CONSTRAINT dao_chain_cases_status_check;
ALTER TABLE dao_chain_cases ADD CONSTRAINT dao_chain_cases_status_check CHECK (status IN (
  'pending_registration','evidence','awaiting_panel','awaiting_randomness','randomness_ready',
  'voting','appeal_window','final','stalled'
));
COMMIT;
