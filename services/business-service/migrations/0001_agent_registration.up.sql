-- Feature 2 (agent-registration) T-001
-- agents / agent_credentials / audit_logs 三张表。
-- 权威定义见 specs/2.agent-registration/design.md 「数据模型」「模块 1」「模块 2」。
--
-- agents.status / agents.pause_reason 两列物理定义随本表创建，但语义权威归属
-- specs/3.agent-health-lifecycle/design.md 「模块 1」——该 feature 不再为这两列
-- 单独发起 ALTER TABLE，避免同一张表的结构定义分散在两个 migration 里
-- （AGENTS.md 第 9 条：单一权威位置）。
--
-- audit_logs 是平台级共享表，后续 feature（3/7/9/12/13/15/16）复用同一张表，
-- 不得在其他 migration 中重新定义同构表。

BEGIN;

-- agents：Agent 档案主表（specs/2.agent-registration/design.md 模块 1）。
CREATE TABLE agents (
    id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Ethereum 地址结构性校验（0x + 40 位十六进制）；EIP-55 大小写校验和格式
    -- 属于业务语义校验，留给应用层（tasks.md 风险点已注明），DB 层只做基础格式防御。
    provider_wallet_address  TEXT        NOT NULL
                                          CHECK (provider_wallet_address ~ '^0x[a-fA-F0-9]{40}$'),
    name                     TEXT        NOT NULL,
    -- category_id：逻辑引用 [[4.task-creation-and-preview]] 的 categories.id（4.T-001 建表）。
    -- 不加 DB 级 FK 约束：两个 feature 的 migration 按各自节奏独立推进，
    -- 加 FK 会引入迁移执行顺序的强耦合（4 必须先于 2 跑完），与 PLAN.md 中
    -- 「1→2→3 与 4 可并行」的排期结论矛盾。校验在应用层做（创建/编辑 Agent 时
    -- 查询 categories 表确认存在）。
    category_id              UUID        NOT NULL,
    capability_desc          TEXT        NOT NULL,
    tags                     TEXT[]      NOT NULL DEFAULT '{}',
    -- pricing_type 的具体枚举取值未在 requirements.md/design.md 中给出权威列表
    -- （PRD 与本 feature 均只写「计价方式」，未列举 fixed/hourly 等具体值），
    -- 暂不加 CHECK 约束枚举，避免臆造未经确认的业务取值；由应用层校验，
    -- 待权威取值确认后再补 CHECK（不属于本 task 范围）。
    pricing_type             TEXT        NOT NULL,
    -- 金额禁止浮点类型（AGENTS.md 安全规则 5 / .claude/rules/security.md 第 5 条），
    -- 使用最小单位整数，与 [[5.escrow-contract-ethereum]] 的精度约定保持一致。
    price_amount             BIGINT      NOT NULL CHECK (price_amount >= 0),
    price_currency           TEXT        NOT NULL,
    service_endpoint         TEXT        NOT NULL CHECK (service_endpoint ~ '^https?://'),
    -- email：站外通知渠道，非登录凭证。格式校验只做基础结构防御，不做真实性校验
    -- （design.md 模块 1：不发验证邮件阻断注册流程）。
    email                    TEXT        NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    -- 状态机权威实现在 Go 分发引擎（specs/3.agent-health-lifecycle/design.md 模块 1），
    -- 本表只承载物理列。pending_review：待审核/试运行（沙箱准入中）。
    status                   TEXT        NOT NULL DEFAULT 'pending_review'
                                          CHECK (status IN ('pending_review', 'active', 'paused', 'delisted')),
    -- pause_reason 仅在 status = paused 时有意义；health_check（自动恢复路径）与
    -- manual（提供者手动恢复路径）互不跨越，语义见 3.agent-health-lifecycle 模块 1。
    pause_reason              TEXT        CHECK (pause_reason IN ('health_check', 'manual')),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE agents IS
    'Agent 档案主表，权威定义见 specs/2.agent-registration/design.md 模块 1；'
    'status/pause_reason 语义权威归属 specs/3.agent-health-lifecycle/design.md 模块 1。';
COMMENT ON COLUMN agents.category_id IS
    '逻辑引用 4.task-creation-and-preview 的 categories.id，无 DB 级 FK（跨 feature migration 顺序解耦），应用层校验存在性。';
COMMENT ON COLUMN agents.price_amount IS
    '最小单位整数金额，禁止浮点，见 AGENTS.md 安全规则第 5 条。';
COMMENT ON COLUMN agents.status IS
    '状态机权威实现在 Go 分发引擎，见 specs/3.agent-health-lifecycle/design.md 模块 1。';
COMMENT ON COLUMN agents.pause_reason IS
    '仅 status=paused 时有意义；health_check 走自动恢复路径，manual 走提供者手动恢复路径，互不跨越。';

CREATE INDEX idx_agents_status ON agents (status);
CREATE INDEX idx_agents_provider_wallet_address ON agents (provider_wallet_address);
CREATE INDEX idx_agents_category_id ON agents (category_id);

-- updated_at 自动维护：agents 表会被本 feature（编辑）、3（状态迁移）、16（换绑）
-- 多个 feature 的写路径更新，用触发器把“更新时间戳”这条规则收敛到单一权威位置，
-- 避免每个写路径各自记得手动 SET updated_at = now()（AGENTS.md 第 9 条）。
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agents_set_updated_at
    BEFORE UPDATE ON agents
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- agent_credentials：凭证密文表，与 agents 物理分离（design.md 模块 1）。
-- 任何对 agents 的 `SELECT *` 都不会带出凭证密文；本表不提供解密读取接口，
-- 契约层面直接不存在“读明文”这个操作（design.md 模块 2）。
CREATE TABLE agent_credentials (
    agent_id          UUID        PRIMARY KEY,
    -- 应用层信封加密后的密文（AWS KMS 数据密钥加密），非数据库层加密。
    encrypted_secret  TEXT        NOT NULL,
    key_version       INTEGER     NOT NULL DEFAULT 1,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- CASCADE：本表是 agents 的严格 1:1 从属数据，脱离 agent 的密文记录没有独立
    -- 存在意义，留下孤儿密文反而是安全隐患；不同于「删列/删业务数据」场景，
    -- 这里级联删除的是同一个聚合根内部的从属行（.claude/rules/database.md 常见坑：
    -- 默认 RESTRICT，仅明确需要时用 CASCADE——此处满足该例外条件）。
    CONSTRAINT fk_agent_credentials_agent
        FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE
);

COMMENT ON TABLE agent_credentials IS
    'Agent 调用凭证密文存储，权威定义见 specs/2.agent-registration/design.md 模块 2。不提供解密读取接口。';
COMMENT ON COLUMN agent_credentials.encrypted_secret IS
    '应用层信封加密密文（AWS KMS 数据密钥），禁止存明文，禁止出现在日志。';
COMMENT ON COLUMN agent_credentials.key_version IS
    '凭证每次覆盖写时递增，供密钥轮换与审计追溯使用。';

CREATE TRIGGER trg_agent_credentials_set_updated_at
    BEFORE UPDATE ON agent_credentials
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- audit_logs：平台级共享审计表（design.md 模块 1）。首次在此定义，后续 feature
-- （3/7/9/12/13/15/16）复用同一张表，不得另建同构表。
CREATE TABLE audit_logs (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- actor_id：操作者标识（钱包地址/运营账户 ID/系统账户标识），跨 feature 取值
    -- 空间不同，不建 FK，保持表的平台级通用性。
    actor_id        TEXT        NOT NULL,
    actor_type      TEXT        NOT NULL CHECK (actor_type IN ('provider', 'publisher', 'admin', 'system')),
    action          TEXT        NOT NULL,
    -- target_type/target_id：被操作对象的类型与标识，跨 feature 复用（agent/task/
    -- dispute/...），取值空间由各消费方自行约定，不在此建 FK。
    target_type     TEXT        NOT NULL,
    target_id       TEXT        NOT NULL,
    -- 凭证类字段禁止写入 before/after summary，由应用层生成 summary 时显式排除
    -- （design.md 安全考虑：显式排除而非事后脱敏）。
    before_summary  JSONB,
    after_summary   JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE audit_logs IS
    '平台级共享审计日志表，首次定义见 specs/2.agent-registration/design.md 模块 1，后续 feature 复用同一张表，禁止另建同构表。';
COMMENT ON COLUMN audit_logs.before_summary IS
    '变更前摘要，禁止包含凭证明文/密文片段或完整钱包签名，由应用层生成时显式排除。';
COMMENT ON COLUMN audit_logs.after_summary IS
    '变更后摘要，禁止包含凭证明文/密文片段或完整钱包签名，由应用层生成时显式排除。';

CREATE INDEX idx_audit_logs_target ON audit_logs (target_type, target_id);
CREATE INDEX idx_audit_logs_actor_id ON audit_logs (actor_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs (created_at);

COMMIT;
