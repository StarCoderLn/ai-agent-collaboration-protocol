-- Feature 7: 分配与验收模式。接单后的锁定规则由领域层执行并写 audit_logs。
BEGIN;
ALTER TABLE tasks
    ADD COLUMN assignment_mode_config JSONB NOT NULL DEFAULT '{"mode":"manual"}'::jsonb,
    ADD COLUMN acceptance_mode TEXT NOT NULL DEFAULT 'manual' CHECK (acceptance_mode IN ('manual','automatic')),
    ADD COLUMN acceptor_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD CONSTRAINT chk_task_assignment_mode_shape CHECK (
      jsonb_typeof(assignment_mode_config) = 'object'
      AND assignment_mode_config->>'mode' IN ('manual','automatic')
      AND (
        assignment_mode_config->>'mode' = 'manual'
        OR (
          COALESCE((assignment_mode_config->>'priceCapMinor') ~ '^[1-9][0-9]*$', FALSE)
          AND COALESCE(length(trim(assignment_mode_config->>'rankingBasis')), 0) > 0
          AND assignment_mode_config->>'fallbackOnFail' IN ('manual','cancel')
        )
      )
    ),
    ADD CONSTRAINT chk_task_acceptor_shape CHECK (
      jsonb_typeof(acceptor_config) = 'object'
      AND (
        (acceptance_mode = 'manual' AND acceptor_config = '{}'::jsonb)
        OR (
          acceptance_mode = 'automatic'
          AND COALESCE(length(trim(acceptor_config->>'acceptorId')), 0) > 0
          AND COALESCE(length(trim(acceptor_config->>'ruleVersion')), 0) > 0
        )
      )
    );
COMMIT;
