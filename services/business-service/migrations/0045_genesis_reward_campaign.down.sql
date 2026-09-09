-- 已产生的奖励命令和签名是资金审计证据，存在数据时禁止回滚丢失。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dao_reward_grants) OR EXISTS (SELECT 1 FROM platform_verified_wallets) THEN
    RAISE EXCEPTION 'GENESIS_REWARD_AUDIT_DATA_MUST_BE_RETAINED';
  END IF;
END $$;

BEGIN;
DROP TABLE dao_reward_grant_attempts;
DROP TABLE dao_reward_grants;
DROP TRIGGER auth_session_remembers_verified_wallet ON auth_sessions;
DROP FUNCTION remember_verified_wallet();
DROP TABLE platform_verified_wallets;
COMMIT;
