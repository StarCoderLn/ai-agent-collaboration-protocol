BEGIN;

-- 当前命令行只能保存一份签名。出现第二次尝试，或当前指针已与历史分离时，降级会丢失
-- 审计证据，因此明确拒绝；应保留 v43 schema 并回滚应用版本。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dao_case_command_attempts WHERE attempt_no > 1) OR EXISTS (
    SELECT 1
      FROM dao_case_command_attempts attempt
      JOIN dao_case_commands command ON command.id=attempt.command_id
     WHERE attempt.attempt_no=1
       AND (command.tx_hash IS DISTINCT FROM attempt.tx_hash
         OR command.raw_transaction IS DISTINCT FROM attempt.raw_transaction)
  ) THEN
    RAISE EXCEPTION 'DAO_CASE_COMMAND_ATTEMPT_HISTORY_MUST_BE_PRESERVED';
  END IF;
END;
$$;

DROP TABLE dao_case_command_attempts;

COMMIT;
