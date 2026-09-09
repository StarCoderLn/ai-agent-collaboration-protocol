DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dispute_evidence_objects LIMIT 1) THEN
    RAISE EXCEPTION 'refusing to delete immutable dispute evidence objects';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS dispute_evidence_object_immutable ON dispute_evidence_objects;
DROP FUNCTION IF EXISTS protect_dispute_evidence_object();
DROP TABLE dispute_evidence_objects;
