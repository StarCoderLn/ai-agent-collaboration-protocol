BEGIN;
-- 回滚前显式拒绝仍存在审核员角色的数据，避免静默删除授权审计。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_actor_roles WHERE role='agent_reviewer') THEN
    RAISE EXCEPTION 'cannot remove agent_reviewer role while assignments still exist';
  END IF;
END $$;
ALTER TABLE platform_actor_roles DROP CONSTRAINT platform_actor_roles_role_check;
ALTER TABLE platform_actor_roles ADD CONSTRAINT platform_actor_roles_role_check
    CHECK (role IN ('arbitrator'));
COMMIT;
