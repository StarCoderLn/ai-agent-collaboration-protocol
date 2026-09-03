-- 失败节点此前只能展示一个恒为 10 的“失败时进度”：Agent 只上报开始/产出两个里程碑，
-- 任何模型执行中的失败都记录在同一个数值上，无法区分“页面结构就没生成出来”和
-- “页面已通过验收、样式步骤失败”。Agent 侧已经计算出该阶段（ModelOutputValidationStage），
-- 但此前只写入服务端日志。这里把它固化为节点执行状态的一部分，取代无信息量的百分比。
-- 该枚举只描述平台自己的校验阶段，不包含模型正文、提示词或供应商响应。
ALTER TABLE workflow_node_execution_state
  ADD COLUMN failure_stage TEXT,
  ADD CONSTRAINT workflow_node_execution_state_failure_stage_valid CHECK (
    failure_stage IS NULL OR (
      execution_state = 'failed' AND failure_stage IN (
        'analysis','requirements_draft','design_draft','code_page','code_styles'
      )
    )
  );
