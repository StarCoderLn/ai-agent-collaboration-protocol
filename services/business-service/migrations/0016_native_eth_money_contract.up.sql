-- Feature 5 的 Escrow 合约只接收原生 ETH。本迁移让之后创建的任务和活动费率配置
-- 与链上契约一致；历史 USDC 任务不自动换算，避免凭空假设汇率并改变既有金额语义。
BEGIN;

ALTER TABLE tasks ALTER COLUMN currency SET DEFAULT 'ETH';

UPDATE platform_fee_config SET active = FALSE WHERE active = TRUE;
INSERT INTO platform_fee_config(version, fee_basis_points, gas_fallback_minor, active)
VALUES ('fee-v2-native-eth', 40, 50000000000000, TRUE);

-- 只修正平台自带的 9 个本地工作流 Agent。用户自行注册的历史报价不做隐式换币。
UPDATE agents
   SET price_currency = 'ETH'
 WHERE id IN (
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000002',
  '91000000-0000-4000-8000-000000000003',
  '91000000-0000-4000-8000-000000000004',
  '91000000-0000-4000-8000-000000000005',
  '91000000-0000-4000-8000-000000000006',
  '91000000-0000-4000-8000-000000000007',
  '91000000-0000-4000-8000-000000000008',
  '91000000-0000-4000-8000-000000000009'
 );

COMMIT;
