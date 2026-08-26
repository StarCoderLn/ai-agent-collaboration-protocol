-- 回滚只恢复默认值和旧费率版本；历史任务/用户 Agent 的币种仍不做隐式换算。
BEGIN;

ALTER TABLE tasks ALTER COLUMN currency SET DEFAULT 'USDC';
UPDATE platform_fee_config SET active = FALSE WHERE active = TRUE;
UPDATE platform_fee_config SET active = TRUE WHERE version = 'fee-v1';
DELETE FROM platform_fee_config WHERE version = 'fee-v2-native-eth';

COMMIT;
