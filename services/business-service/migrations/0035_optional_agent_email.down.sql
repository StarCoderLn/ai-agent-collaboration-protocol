BEGIN;

-- 回滚不能静默删除新版本产生的 NULL，也不能伪造占位邮箱。存在 NULL 时明确拒绝，
-- 由操作者先决定真实的数据恢复策略，再重新执行 down migration。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agents WHERE email IS NULL) THEN
    RAISE EXCEPTION 'cannot restore required agent email while NULL values exist';
  END IF;
END $$;

ALTER TABLE agents ALTER COLUMN email SET NOT NULL;

COMMENT ON COLUMN agents.email IS
  '站外通知渠道，非登录凭证；格式仅做基础结构校验。';

COMMIT;
