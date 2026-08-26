BEGIN;
ALTER TABLE agent_score_snapshots
  DROP CONSTRAINT IF EXISTS ck_agent_score_snapshot_input_evidence,
  DROP COLUMN IF EXISTS input_evidence;
COMMIT;
