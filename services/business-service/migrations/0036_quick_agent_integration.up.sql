-- Agent 快速接入：旧 Agent 保持 AICP HMAC 协议，新上架 Agent 可选择由平台
-- 代管任务生命周期的同步 HTTP 接入。默认值必须是 aicp_hmac，确保迁移执行后
-- 所有历史数据的派发、回调和健康检查行为完全不变。
BEGIN;

ALTER TABLE agents
    ADD COLUMN integration_mode TEXT NOT NULL DEFAULT 'aicp_hmac'
        CHECK (integration_mode IN ('aicp_hmac', 'http_json'));

COMMENT ON COLUMN agents.integration_mode IS
    'Agent 接入模式：aicp_hmac 为历史双向回调协议；http_json 为平台代管生命周期的快速 HTTP 接入。';

-- 快速 HTTP Agent 会在首次请求中同步返回交付结果。平台必须先持久化结果再确认
-- 接单，避免接单状态已经成立、但进程退出导致唯一交付丢失。delivered_at 为空表示
-- 仍需转交 Business API；同一 dispatch_attempt 因而天然具备幂等恢复标识。
ALTER TABLE dispatch_attempts
    ADD COLUMN quick_result_payload JSONB,
    ADD COLUMN quick_result_delivered_at TIMESTAMPTZ,
    ADD CONSTRAINT ck_dispatch_quick_result_delivery
        CHECK (quick_result_delivered_at IS NULL OR quick_result_payload IS NOT NULL);

CREATE INDEX idx_dispatch_attempts_quick_result_pending
    ON dispatch_attempts(updated_at, id)
    WHERE quick_result_payload IS NOT NULL AND quick_result_delivered_at IS NULL;

COMMIT;
