-- 回滚只移除独立收款字段；调用方必须先恢复为读取 provider_wallet_address，避免在旧
-- schema 上继续查询已删除的列。已有 Agent 的所有者地址和其他业务数据不受影响。

BEGIN;

ALTER TABLE agents
    DROP COLUMN payout_wallet_address;

COMMIT;
