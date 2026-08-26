-- Feature 8: 每次匹配结果及规则版本都持久化，支持复现与无候选解释。
BEGIN;
ALTER TABLE agents
    ADD COLUMN estimated_duration_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (estimated_duration_seconds > 0),
    ADD COLUMN response_minutes INTEGER NOT NULL DEFAULT 5 CHECK (response_minutes >= 0);

CREATE TABLE ranking_rule_versions (
    version TEXT PRIMARY KEY,
    rules JSONB NOT NULL,
    active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_ranking_rule_versions_active ON ranking_rule_versions(active) WHERE active;
INSERT INTO ranking_rule_versions(version, rules, active) VALUES (
  'ranking-v1',
  '{"tagMatchWeight":30,"qualityWeight":30,"priceWeight":15,"responseSpeedWeight":10,"loadWeight":5,"completedWeight":10}'::jsonb,
  TRUE
);

CREATE TABLE job_distribution_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id),
    rule_version TEXT NOT NULL REFERENCES ranking_rule_versions(version),
    input_fingerprint TEXT NOT NULL,
    input_snapshot JSONB NOT NULL,
    candidates JSONB NOT NULL,
    filter_reasons JSONB NOT NULL,
    final_selection_agent_id UUID REFERENCES agents(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_distribution_task_time ON job_distribution_records(task_id, created_at DESC);
CREATE UNIQUE INDEX uq_distribution_task_input ON job_distribution_records(task_id, input_fingerprint);
COMMIT;
