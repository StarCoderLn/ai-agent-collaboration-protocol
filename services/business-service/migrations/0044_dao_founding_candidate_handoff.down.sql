-- 候选来源快照属于案件裁决审计证据。回退应用可以停止创建新案，但不得删除既有案件
-- 使用创始、混合或社区候选池的历史事实。
DO $$ BEGIN RAISE EXCEPTION 'DAO_CANDIDATE_POOL_HISTORY_MUST_BE_RETAINED'; END $$;
