-- 执行失败后允许发布者保留原托管资金并重新进入候选匹配。分发服务只写入“旧分配已取消”
-- 事实，Business API 仍是目标任务状态的唯一解释者，避免两个服务复制状态迁移表。
BEGIN;

ALTER TABLE task_transition_outbox
    DROP CONSTRAINT task_transition_outbox_event_type_check;
ALTER TABLE task_transition_outbox
    ADD CONSTRAINT task_transition_outbox_event_type_check
    CHECK (event_type IN (
        'assignment_locked',
        'agent_accepted',
        'assignment_failed',
        'execution_retry_requested'
    ));

ALTER TABLE task_transition_inbox
    DROP CONSTRAINT task_transition_inbox_event_type_check;
ALTER TABLE task_transition_inbox
    ADD CONSTRAINT task_transition_inbox_event_type_check
    CHECK (event_type IN (
        'assignment_locked',
        'agent_accepted',
        'assignment_failed',
        'execution_retry_requested'
    ));

COMMIT;
