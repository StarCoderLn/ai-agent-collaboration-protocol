BEGIN;

-- V0/V1 取值只用于保留历史分发记录；新正式请求使用 learned_v2，并记录精确模型版本。
-- 语义召回仍是 V2 内部阶段，不再作为独立的生产算法身份。
ALTER TABLE job_distribution_records
    DROP CONSTRAINT job_distribution_semantic_evidence_check,
    DROP CONSTRAINT job_distribution_records_matching_mode_check,
    ADD COLUMN matching_model_version TEXT REFERENCES matching_v2_model_versions(version),
    ADD CONSTRAINT job_distribution_records_matching_mode_check
      CHECK (matching_mode IN ('rules_v0','semantic_v1','rules_v0_fallback','learned_v2')),
    ADD CONSTRAINT job_distribution_semantic_evidence_check CHECK (
      (matching_mode='rules_v0' AND semantic_model IS NULL AND semantic_query_ms IS NULL
        AND fallback_reason IS NULL AND matching_model_version IS NULL)
      OR (matching_mode='semantic_v1' AND semantic_model IS NOT NULL AND semantic_query_ms IS NOT NULL
        AND fallback_reason IS NULL AND matching_model_version IS NULL)
      OR (matching_mode='rules_v0_fallback' AND semantic_model IS NOT NULL AND semantic_query_ms IS NULL
        AND fallback_reason IS NOT NULL AND matching_model_version IS NULL)
      OR (matching_mode='learned_v2' AND semantic_model IS NOT NULL AND semantic_query_ms IS NOT NULL
        AND fallback_reason IS NULL AND matching_model_version IS NOT NULL)
    );

COMMIT;
