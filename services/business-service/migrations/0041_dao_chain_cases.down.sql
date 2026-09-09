-- 新增链上案件包含审计与签名交易，禁止通过 down 抹掉既有资金操作记录。
-- 需要回退应用时停用新案入口，已创建案件继续使用本迁移中的兼容表完成恢复。
DO $$ BEGIN RAISE EXCEPTION 'DAO_CHAIN_CASES_REQUIRE_FORWARD_ONLY_MIGRATION'; END $$;
