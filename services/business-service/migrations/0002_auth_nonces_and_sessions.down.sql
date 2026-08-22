-- Feature 2 (agent-registration) T-010 — down migration for 0002_auth_nonces_and_sessions.
-- 仅允许用于尚无共享会话/nonce 数据的本地/测试环境（database.md 第 5 条）；
-- 生产环境回滚一律使用前向修复 migration。

BEGIN;

DROP TABLE IF EXISTS auth_sessions;
DROP TABLE IF EXISTS auth_nonces;

COMMIT;
