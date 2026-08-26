-- Feature 3: 复用统一平台角色表增加 Agent 审核权限，不另建平行管理员名单。
BEGIN;
ALTER TABLE platform_actor_roles DROP CONSTRAINT platform_actor_roles_role_check;
ALTER TABLE platform_actor_roles ADD CONSTRAINT platform_actor_roles_role_check
    CHECK (role IN ('arbitrator','agent_reviewer'));
COMMIT;
