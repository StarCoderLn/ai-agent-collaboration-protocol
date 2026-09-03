-- 正式多 Agent 工作流按阶段收集交付反馈；原始事实与未来向量/训练派生数据分离。
BEGIN;

CREATE TABLE workflow_node_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id),
    workflow_node_id UUID NOT NULL REFERENCES task_workflow_nodes(id),
    assignment_id UUID NOT NULL REFERENCES task_assignments(id),
    agent_id UUID NOT NULL REFERENCES agents(id),
    publisher_id TEXT NOT NULL,
    quality SMALLINT NOT NULL CHECK (quality BETWEEN 1 AND 5),
    communication SMALLINT NOT NULL CHECK (communication BETWEEN 1 AND 5),
    feedback_text TEXT CHECK (feedback_text IS NULL OR char_length(feedback_text) BETWEEN 4 AND 2000),
    strengths TEXT[] NOT NULL DEFAULT '{}',
    improvement_text TEXT CHECK (improvement_text IS NULL OR char_length(improvement_text) BETWEEN 4 AND 1000),
    allow_model_training BOOLEAN NOT NULL DEFAULT FALSE,
    schema_version TEXT NOT NULL DEFAULT 'workflow-feedback.v1'
        CHECK (schema_version = 'workflow-feedback.v1'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 一个工作流节点只属于一个发布者；直接对节点唯一可从数据库层阻止同一钱包仅靠
    -- 地址大小写变化重复评价，避免把身份归一化责任泄漏给每个调用入口。
    UNIQUE (workflow_node_id),
    CHECK (cardinality(strengths) <= 4),
    CHECK (NOT allow_model_training OR feedback_text IS NOT NULL)
);

CREATE INDEX idx_workflow_node_feedback_agent_created
    ON workflow_node_feedback(agent_id, created_at DESC);
CREATE INDEX idx_workflow_node_feedback_task
    ON workflow_node_feedback(task_id, workflow_node_id);

COMMENT ON TABLE workflow_node_feedback IS
  '发布者对正式工作流中单个已验收 Agent 交付的原始反馈事实；向量和训练样本必须由脱敏派生任务生成。';
COMMENT ON COLUMN workflow_node_feedback.allow_model_training IS
  '仅表示发布者同意将该条已脱敏文字反馈用于模型改进；不授权使用任务正文、附件或密钥。';

COMMIT;
