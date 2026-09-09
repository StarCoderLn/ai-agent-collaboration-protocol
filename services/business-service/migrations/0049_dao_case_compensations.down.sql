DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dao_case_compensations LIMIT 1) THEN
    RAISE EXCEPTION 'refusing to delete DAO compensation audit evidence';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS dao_case_compensation_immutable ON dao_case_compensations;
DROP FUNCTION IF EXISTS protect_dao_case_compensation();
DROP TABLE dao_case_compensations;
