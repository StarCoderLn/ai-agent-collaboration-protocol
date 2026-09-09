-- 支付回执、原始交易和已读记录都是审计事实。回滚应用保留表，不删除奖励记录。
DO $$ BEGIN RAISE EXCEPTION 'DAO_REWARD_AUDIT_DATA_MUST_BE_RETAINED'; END $$;
