BEGIN;

-- V1 语义匹配只在该缓存表保存 Agent 的公开能力文本向量。任务文本按请求生成，
-- 不落库，避免私有需求内容进入长期向量资产；source_hash 保证档案变化后不会误用旧向量。
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE agent_matching_embeddings (
    agent_id UUID PRIMARY KEY REFERENCES agents(id),
    source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
    model TEXT NOT NULL CHECK (length(trim(model)) > 0),
    dimensions INTEGER NOT NULL CHECK (dimensions > 0),
    embedding vector(1536) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- cosine 距离与 OpenAI Embedding 的语义相似度定义一致。HNSW 无需先训练，适合
-- Agent 目录持续增量更新；索引只负责召回，健康、币种和截止时间仍由领域层校验。
CREATE INDEX idx_agent_matching_embeddings_cosine
    ON agent_matching_embeddings USING hnsw (embedding vector_cosine_ops);

-- 分发记录直接保存运行模式和向量查询耗时，前端与排障工具无需解析私有输入快照。
-- 历史记录统一标为 rules_v0；fallback 只保存稳定错误类别，不保存第三方响应正文。
ALTER TABLE job_distribution_records
    ADD COLUMN matching_mode TEXT NOT NULL DEFAULT 'rules_v0'
      CHECK (matching_mode IN ('rules_v0','semantic_v1','rules_v0_fallback')),
    ADD COLUMN semantic_model TEXT,
    ADD COLUMN semantic_query_ms DOUBLE PRECISION
      CHECK (semantic_query_ms IS NULL OR semantic_query_ms >= 0),
    ADD COLUMN fallback_reason TEXT,
    ADD CONSTRAINT job_distribution_semantic_evidence_check CHECK (
      (matching_mode='rules_v0' AND semantic_model IS NULL AND semantic_query_ms IS NULL AND fallback_reason IS NULL)
      OR (matching_mode='semantic_v1' AND semantic_model IS NOT NULL AND semantic_query_ms IS NOT NULL AND fallback_reason IS NULL)
      OR (matching_mode='rules_v0_fallback' AND semantic_model IS NOT NULL AND semantic_query_ms IS NULL AND fallback_reason IS NOT NULL)
    );

COMMIT;
