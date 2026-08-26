-- Feature 3: Agent 健康检查与生命周期。
BEGIN;

CREATE TABLE agent_health_checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    result_code TEXT NOT NULL,
    counted_toward_failure BOOLEAN NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_health_checks_agent_time ON agent_health_checks(agent_id, checked_at DESC);

CREATE TABLE agent_status_config (
    agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    consecutive_failure_threshold INTEGER NOT NULL DEFAULT 3 CHECK (consecutive_failure_threshold > 0),
    health_check_interval_seconds INTEGER NOT NULL DEFAULT 300 CHECK (health_check_interval_seconds > 0),
    resume_success_threshold INTEGER NOT NULL DEFAULT 2 CHECK (resume_success_threshold > 0),
    probation_budget_cap_percentile NUMERIC(5,4) NOT NULL DEFAULT 0.3000 CHECK (probation_budget_cap_percentile > 0 AND probation_budget_cap_percentile <= 1),
    consecutive_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failure_count >= 0),
    consecutive_success_count INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_success_count >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_agent_status_config_set_updated_at BEFORE UPDATE ON agent_status_config
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
