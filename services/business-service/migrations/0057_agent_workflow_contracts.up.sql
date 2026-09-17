-- Agent 的工作流契约能力独立于面向用户的标签。匹配必须验证输入与输出契约的完整
-- 二元组，避免仅因分类或语义相近就把 ResearchArtifact 交给只能读取 DesignArtifact 的 Agent。
BEGIN;
CREATE TABLE agent_workflow_contracts (
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    input_contract TEXT NOT NULL CHECK (length(trim(input_contract)) BETWEEN 1 AND 120),
    output_contract TEXT NOT NULL CHECK (length(trim(output_contract)) BETWEEN 1 AND 120),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(agent_id,input_contract,output_contract)
);
CREATE INDEX idx_agent_workflow_contracts_pair
    ON agent_workflow_contracts(input_contract,output_contract,agent_id);
COMMIT;
