-- 新版合约用独立 Recovery 状态表示有硬截止的异常恢复期；旧 Stalled 仍保留，
-- 防止后台把新版 finalizeRecovery 调用错误发送给不支持该入口的历史合约。
BEGIN;

ALTER TABLE dao_chain_cases DROP CONSTRAINT dao_chain_cases_status_check;
ALTER TABLE dao_chain_cases ADD CONSTRAINT dao_chain_cases_status_check CHECK (status IN (
  'pending_registration','evidence','awaiting_panel','awaiting_randomness','randomness_ready',
  'voting','appeal_window','final','stalled','recovery'
));

COMMIT;
