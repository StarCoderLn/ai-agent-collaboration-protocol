-- Feature 2 (agent-registration) T-010
-- auth_nonces / auth_sessions 两张表，承载提供者钱包认证（SIWE / EIP-4361）。
-- 权威设计见 specs/2.agent-registration/design.md 「模块 5：提供者钱包认证」「数据模型」。
--
-- 两张表均为平台级共享表：任何未来 feature 需要「当前操作者是哪个钱包地址」都复用
-- 同一张 auth_sessions，不得各自实现会话解析或另建同构表（design.md 模块 5）。

BEGIN;

-- auth_nonces：SIWE 消息签发的一次性 nonce（design.md 模块 5）。
-- nonce 本身作为主键：由 `siwe` 库生成的随机字母数字串（至少 8 位，EIP-4361 约束），
-- 碰撞概率可忽略，不再额外引入代理主键。
CREATE TABLE auth_nonces (
    nonce        TEXT        PRIMARY KEY,
    expires_at   TIMESTAMPTZ NOT NULL,
    -- consumed_at 为 NULL 表示尚未使用；签名校验成功后立即置为 now()，
    -- 防止同一 nonce 被重放（design.md 模块 5：nonce 单次使用）。
    consumed_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE auth_nonces IS
    'SIWE 一次性 nonce，权威定义见 specs/2.agent-registration/design.md 模块 5。短 TTL（应用层 5 分钟），单次使用。';
COMMENT ON COLUMN auth_nonces.consumed_at IS
    'NULL 表示未使用；签名校验通过后原子置为 now()，防重放。';

CREATE INDEX idx_auth_nonces_expires_at ON auth_nonces (expires_at);

-- auth_sessions：SIWE 校验成功后签发的会话（design.md 模块 5）。
-- session_id 直接作为主键与 Cookie 承载的不透明值：Cookie 只放 session_id，
-- 不是自解释 JWT，服务端必须持有本表才能校验/吊销（design.md 模块 5）。
CREATE TABLE auth_sessions (
    session_id      TEXT        PRIMARY KEY,
    -- 结构性校验与 agents.provider_wallet_address 一致（0x + 40 位十六进制），
    -- EIP-55 校验和层面的归一化由应用层负责（与 ethereum-address.ts 保持单一权威）。
    wallet_address  TEXT        NOT NULL
                                 CHECK (wallet_address ~ '^0x[a-fA-F0-9]{40}$'),
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE auth_sessions IS
    '平台级共享会话表，权威定义见 specs/2.agent-registration/design.md 模块 5。任何 feature 需要解析「当前操作者钱包地址」均应复用本表，通过 resolveActorId 单一权威入口，不得各自实现。';
COMMENT ON COLUMN auth_sessions.session_id IS
    '不透明会话标识，与 httpOnly+Secure+SameSite=Lax 的 session cookie 值一致；不是自解释 JWT。';

CREATE INDEX idx_auth_sessions_wallet_address ON auth_sessions (wallet_address);
CREATE INDEX idx_auth_sessions_expires_at ON auth_sessions (expires_at);

COMMIT;
