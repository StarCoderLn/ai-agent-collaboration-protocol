-- Feature 12: 一次性发布者评分与可追溯规则快照。
BEGIN;
CREATE TABLE scoring_rule_versions (
    version TEXT PRIMARY KEY,
    weights JSONB NOT NULL,
    bayesian_prior JSONB NOT NULL,
    half_life_seconds BIGINT NOT NULL CHECK (half_life_seconds > 0),
    active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_scoring_rule_active ON scoring_rule_versions(active) WHERE active;
INSERT INTO scoring_rule_versions(version, weights, bayesian_prior, half_life_seconds, active) VALUES (
  'score-v1',
  '{"completionStrength":25,"qualityFeedback":30,"communicationExperience":15,"disputeReliability":20,"completedHistory":10}'::jsonb,
  '{"priorMean":3.5,"priorWeight":20,"recentWindowDays":90,"historySaturationScale":3}'::jsonb,
  7776000,
  TRUE
);

CREATE TABLE task_ratings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL UNIQUE REFERENCES tasks(id),
    agent_id UUID NOT NULL REFERENCES agents(id),
    publisher_id TEXT NOT NULL,
    quality SMALLINT NOT NULL CHECK (quality BETWEEN 1 AND 5),
    timeliness SMALLINT NOT NULL CHECK (timeliness BETWEEN 1 AND 5),
    communication SMALLINT NOT NULL CHECK (communication BETWEEN 1 AND 5),
    requirement_fit SMALLINT NOT NULL CHECK (requirement_fit BETWEEN 1 AND 5),
    compliance SMALLINT NOT NULL CHECK (compliance BETWEEN 1 AND 5),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_score_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    rule_version TEXT NOT NULL REFERENCES scoring_rule_versions(version),
    score NUMERIC(4,3) NOT NULL CHECK (score BETWEEN 0 AND 5),
    sample_size INTEGER NOT NULL CHECK (sample_size >= 0),
    dispute_rate NUMERIC(7,6) NOT NULL CHECK (dispute_rate BETWEEN 0 AND 1),
    completed_scale NUMERIC NOT NULL CHECK (completed_scale >= 0),
    dimensions JSONB NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_score_latest ON agent_score_snapshots(agent_id, computed_at DESC);
COMMIT;
