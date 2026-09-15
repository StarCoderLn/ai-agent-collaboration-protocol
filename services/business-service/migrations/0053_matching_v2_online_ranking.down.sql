BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM job_distribution_records WHERE matching_mode='learned_v2') THEN
    RAISE EXCEPTION 'cannot remove Matching V2 online schema while learned_v2 records exist';
  END IF;
END $$;

ALTER TABLE job_distribution_records
    DROP CONSTRAINT job_distribution_semantic_evidence_check,
    DROP CONSTRAINT job_distribution_records_matching_mode_check,
    DROP COLUMN matching_model_version,
    ADD CONSTRAINT job_distribution_records_matching_mode_check
      CHECK (matching_mode IN ('rules_v0','semantic_v1','rules_v0_fallback')),
    ADD CONSTRAINT job_distribution_semantic_evidence_check CHECK (
      (matching_mode='rules_v0' AND semantic_model IS NULL AND semantic_query_ms IS NULL AND fallback_reason IS NULL)
      OR (matching_mode='semantic_v1' AND semantic_model IS NOT NULL AND semantic_query_ms IS NOT NULL AND fallback_reason IS NULL)
      OR (matching_mode='rules_v0_fallback' AND semantic_model IS NOT NULL AND semantic_query_ms IS NULL AND fallback_reason IS NOT NULL)
    );

COMMIT;
