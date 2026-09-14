BEGIN;

ALTER TABLE job_distribution_records
    DROP CONSTRAINT job_distribution_semantic_evidence_check,
    DROP COLUMN fallback_reason,
    DROP COLUMN semantic_query_ms,
    DROP COLUMN semantic_model,
    DROP COLUMN matching_mode;

DROP TABLE agent_matching_embeddings;

-- vector 是数据库共享能力。回滚 V1 只删除本功能拥有的表，不移除可能已被其他模块
-- 使用的扩展，避免一个局部 down migration 破坏无关数据。
COMMIT;
