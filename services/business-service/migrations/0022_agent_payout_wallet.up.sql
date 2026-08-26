-- Agent 所有权身份与结算收款地址拆分。
--
-- provider_wallet_address 继续作为 SIWE 登录、Agent 归属和管理权限的唯一依据；
-- payout_wallet_address 只用于生成链上结算收款人。两者可以相同，也允许提供者把收入
-- 汇入独立的运营钱包。不能复用一个字段，否则开放“修改收款地址”会同时改掉所有者，
-- 破坏 Agent 的认证与权限边界。

BEGIN;

ALTER TABLE agents
    ADD COLUMN payout_wallet_address TEXT;

-- 对已有 Agent 使用原所有者钱包回填，保证升级前后的结算对象保持不变。
UPDATE agents
   SET payout_wallet_address = provider_wallet_address;

ALTER TABLE agents
    ALTER COLUMN payout_wallet_address SET NOT NULL,
    ADD CONSTRAINT agents_payout_wallet_address_format
        CHECK (payout_wallet_address ~ '^0x[a-fA-F0-9]{40}$');

COMMENT ON COLUMN agents.payout_wallet_address IS
    'Agent 结算收款钱包；可与 provider_wallet_address 不同，不参与所有权或管理权限判断。';

COMMIT;
