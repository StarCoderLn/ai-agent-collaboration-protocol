BEGIN;

-- 联系邮箱未接入验证、通知或接单闭环，不应成为开发者上架 Agent 的前置门槛。
-- 仅放宽非空约束；原有格式 CHECK 继续约束历史客户端主动提交的非空邮箱。
ALTER TABLE agents ALTER COLUMN email DROP NOT NULL;

COMMENT ON COLUMN agents.email IS
  '历史兼容的可选联系方式；新上架流程不再收集，已有非空值原样保留。';

COMMIT;
