BEGIN;

-- 候选生成只是服务端计算，只有浏览器确认候选卡进入可视区域后才形成曝光事实。
-- event_key 由客户端会话、候选快照和 Agent 共同派生，网络重试不能重复增加训练权重。
CREATE TABLE matching_candidate_exposures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_key TEXT NOT NULL UNIQUE CHECK (char_length(event_key) BETWEEN 16 AND 200),
    view_session_id UUID NOT NULL,
    distribution_record_id UUID NOT NULL REFERENCES job_distribution_records(id),
    task_id UUID NOT NULL REFERENCES tasks(id),
    workflow_node_id UUID REFERENCES task_workflow_nodes(id),
    agent_id UUID NOT NULL REFERENCES agents(id),
    actor_id TEXT NOT NULL CHECK (char_length(trim(actor_id)) > 0),
    position SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 100),
    visible_millis INTEGER NOT NULL CHECK (visible_millis BETWEEN 1000 AND 600000),
    data_origin TEXT NOT NULL DEFAULT 'real' CHECK (data_origin IN ('real','synthetic')),
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (distribution_record_id, agent_id, view_session_id, position)
);
CREATE INDEX idx_matching_exposures_window
    ON matching_candidate_exposures(occurred_at, distribution_record_id);
CREATE INDEX idx_matching_exposures_agent
    ON matching_candidate_exposures(agent_id, occurred_at DESC);

-- 训练运行和模型版本分开：一次失败训练没有可发布模型，但仍须保留可恢复的 Temporal
-- 身份与稳定错误类别。request_fingerprint 使调度重放不会重复训练同一数据窗口。
CREATE TABLE matching_v2_training_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id TEXT NOT NULL UNIQUE CHECK (char_length(workflow_id) BETWEEN 8 AND 200),
    request_fingerprint TEXT NOT NULL UNIQUE CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','skipped')),
    data_origin TEXT NOT NULL CHECK (data_origin IN ('real','synthetic','mixed')),
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL CHECK (window_end > window_start),
    feature_schema_version TEXT NOT NULL,
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    CHECK ((status IN ('succeeded','failed','skipped')) = (completed_at IS NOT NULL)),
    CHECK (status <> 'failed' OR error_code IS NOT NULL)
);

CREATE TABLE matching_v2_model_versions (
    version TEXT PRIMARY KEY CHECK (version ~ '^matching-v2-[0-9]{8,14}-[0-9a-f]{8}$'),
    training_run_id UUID NOT NULL UNIQUE REFERENCES matching_v2_training_runs(id),
    state TEXT NOT NULL CHECK (state IN ('candidate','shadow','active','rejected','rolled_back')),
    feature_schema_version TEXT NOT NULL,
    artifact_uri TEXT NOT NULL CHECK (char_length(trim(artifact_uri)) > 0),
    artifact_sha256 TEXT NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
    training_data_origin TEXT NOT NULL CHECK (training_data_origin IN ('real','synthetic','mixed')),
    sample_count INTEGER NOT NULL CHECK (sample_count > 0),
    metrics JSONB NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ,
    CHECK (state NOT IN ('shadow','active') OR published_at IS NOT NULL),
    -- 仿真数据只能验证工程闭环，禁止被误切为真实线上排序。
    CHECK (state <> 'active' OR training_data_origin = 'real')
);
CREATE UNIQUE INDEX uq_matching_v2_active_model
    ON matching_v2_model_versions((state)) WHERE state = 'active';
CREATE UNIQUE INDEX uq_matching_v2_shadow_model
    ON matching_v2_model_versions((state)) WHERE state = 'shadow';

-- 正式 Top-3 与 V2 的 20～50 个召回池必须分开保存。匹配事务只把完整召回池写入
-- 私有影子任务；后台 Worker 失败、超时或尚无模型时都不能扩大用户可选候选或阻塞派发。
CREATE TABLE matching_v2_shadow_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    distribution_record_id UUID NOT NULL UNIQUE REFERENCES job_distribution_records(id),
    feature_schema_version TEXT NOT NULL,
    request_payload JSONB NOT NULL CHECK (
      jsonb_typeof(request_payload)='object'
      AND jsonb_typeof(request_payload->'candidates')='array'
      AND jsonb_array_length(request_payload->'candidates') BETWEEN 1 AND 50
    ),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','scored','failed')),
    attempt_no INTEGER NOT NULL DEFAULT 0 CHECK (attempt_no BETWEEN 0 AND 5),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lock_token UUID,
    locked_until TIMESTAMPTZ,
    model_version TEXT REFERENCES matching_v2_model_versions(version),
    last_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    CHECK ((status='running')=(lock_token IS NOT NULL AND locked_until IS NOT NULL)),
    CHECK ((status IN ('scored','failed'))=(completed_at IS NOT NULL)),
    CHECK (status<>'scored' OR model_version IS NOT NULL)
);
CREATE INDEX idx_matching_v2_shadow_job_claim
    ON matching_v2_shadow_jobs(status,next_attempt_at,locked_until,created_at)
    WHERE status IN ('pending','running');

-- 影子分数与正式候选快照并列保存，不覆盖 candidates，也不参与托管选人事务。
CREATE TABLE matching_v2_shadow_scores (
    distribution_record_id UUID NOT NULL REFERENCES job_distribution_records(id),
    model_version TEXT NOT NULL REFERENCES matching_v2_model_versions(version),
    agent_id UUID NOT NULL REFERENCES agents(id),
    pctr DOUBLE PRECISION NOT NULL CHECK (pctr BETWEEN 0 AND 1),
    pcvr DOUBLE PRECISION NOT NULL CHECK (pcvr BETWEEN 0 AND 1),
    pctcvr DOUBLE PRECISION NOT NULL CHECK (pctcvr BETWEEN 0 AND 1),
    shadow_rank SMALLINT NOT NULL CHECK (shadow_rank BETWEEN 1 AND 100),
    scored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (distribution_record_id, model_version, agent_id),
    UNIQUE (distribution_record_id, model_version, shadow_rank)
);

COMMIT;
