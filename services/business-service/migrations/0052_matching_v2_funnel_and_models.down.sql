BEGIN;

-- 曝光、训练与影子分数属于审计和模型发布证据。存在任何记录时拒绝破坏性回滚，
-- 应通过前向 migration 修正结构；空表仅用于尚未投入使用的开发环境回滚。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM matching_candidate_exposures)
     OR EXISTS (SELECT 1 FROM matching_v2_training_runs)
     OR EXISTS (SELECT 1 FROM matching_v2_model_versions)
     OR EXISTS (SELECT 1 FROM matching_v2_shadow_jobs)
     OR EXISTS (SELECT 1 FROM matching_v2_shadow_scores) THEN
    RAISE EXCEPTION 'cannot remove matching V2 tables while audit or model evidence exists';
  END IF;
END $$;

DROP TABLE matching_v2_shadow_scores;
DROP TABLE matching_v2_shadow_jobs;
DROP TABLE matching_v2_model_versions;
DROP TABLE matching_v2_training_runs;
DROP TABLE matching_candidate_exposures;

COMMIT;
