-- 如果已经存在执行重试审计事实，本回滚会由约束校验明确失败；不得为了回滚删除历史记录。
BEGIN;

ALTER TABLE task_transition_inbox
    DROP CONSTRAINT task_transition_inbox_event_type_check;
ALTER TABLE task_transition_inbox
    ADD CONSTRAINT task_transition_inbox_event_type_check
    CHECK (event_type IN ('assignment_locked', 'agent_accepted', 'assignment_failed'));

ALTER TABLE task_transition_outbox
    DROP CONSTRAINT task_transition_outbox_event_type_check;
ALTER TABLE task_transition_outbox
    ADD CONSTRAINT task_transition_outbox_event_type_check
    CHECK (event_type IN ('assignment_locked', 'agent_accepted', 'assignment_failed'));

COMMIT;
