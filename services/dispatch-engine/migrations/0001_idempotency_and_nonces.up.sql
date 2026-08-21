-- Feature 1 (agent-protocol-contract) T-004
-- 幂等键存储 (idempotency_records) 与 nonce 防重放存储 (used_nonces)。
-- 权威定义见 specs/1.agent-protocol-contract/design.md 「数据模型」「模块 2」「模块 4」。
--
-- 表结构一旦被 T-005（幂等中间件）、T-008（沙箱标记）消费，不得在其他 migration
-- 之外的位置重新定义同构表，保持单一权威位置（AGENTS.md 第 9 条）。

BEGIN;

-- idempotency_records：幂等键去重存储。
-- 幂等键格式 `{operation}:{taskId}:{clientGeneratedId}` 由调用方生成，作为主键落库；
-- 命中已存在的 key 时直接返回历史 response_snapshot，不重新执行业务逻辑
-- （design.md 模块 2）。
CREATE TABLE idempotency_records (
    idempotency_key    TEXT        PRIMARY KEY,
    operation_type     TEXT        NOT NULL,
    -- call_type: 沙箱模式标记（design.md 模块 4 / v2 新增）。
    -- 默认 production：调用方未显式声明时一律按正式任务处理，避免遗漏标记导致
    -- 沙箱调用被误计入正式历史（design.md 技术决策：沙箱标记默认值）。
    call_type          TEXT        NOT NULL DEFAULT 'production'
                                    CHECK (call_type IN ('sandbox', 'production')),
    response_snapshot  JSONB       NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- expires_at：默认 TTL 7 天（design.md 模块 2），由定时清理任务按此字段删除过期记录。
    -- 清理任务本身不在本 migration 范围内（属于运维/调度任务，见下方索引说明）。
    expires_at         TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE idempotency_records IS
    '幂等键去重存储，权威定义见 specs/1.agent-protocol-contract/design.md 模块 2、模块 4。';
COMMENT ON COLUMN idempotency_records.call_type IS
    '沙箱模式标记：sandbox | production，默认 production，纳入请求签名基串防篡改（design.md 模块 4）。';
COMMENT ON COLUMN idempotency_records.expires_at IS
    '默认 created_at + 7 天，由定时清理任务依据本字段删除过期记录，不做数据库层自动过期。';

-- 支撑按 expires_at 批量清理过期幂等记录的定时任务（风险点：清理未按时执行会影响查询性能）。
CREATE INDEX idx_idempotency_records_expires_at ON idempotency_records (expires_at);

-- 按 call_type 过滤沙箱调用，供下游消费方（12.scoring-system、15.agent-sandbox-admission）
-- 排除测试调用而不需重复判断（design.md 模块 4）。
CREATE INDEX idx_idempotency_records_call_type ON idempotency_records (call_type);

-- used_nonces：签名防重放存储，配合时间窗口 TTL 清理防止表无限增长
-- （design.md 模块 1、模块 2「安全考虑」）。
CREATE TABLE used_nonces (
    nonce       TEXT        PRIMARY KEY,
    agent_id    TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE used_nonces IS
    '签名防重放 nonce 存储，权威定义见 specs/1.agent-protocol-contract/design.md 模块 1/2。'
    ' 清理策略：保留时长应覆盖签名时间戳窗口（默认 ±5 分钟）之外的合理缓冲，'
    '由定时清理任务依据 created_at 删除超出窗口的记录，具体保留时长由运维配置。';

-- 支撑按 agent_id 查询与按 created_at 批量清理过期 nonce 的定时任务。
CREATE INDEX idx_used_nonces_agent_id ON used_nonces (agent_id);
CREATE INDEX idx_used_nonces_created_at ON used_nonces (created_at);

COMMIT;
