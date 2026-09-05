-- Agent 冷启动风险门禁不再复用评分系统的贝叶斯先验权重。
--
-- 评分样本用于表达分数置信度；真实结算任务用于证明 Agent 已在资金闭环中完成交付。
-- 两种事实增长速度不同，因此把解除门槛独立配置为 3 个真实结算任务。字段落在既有
-- agent_status_config 中，匹配引擎和目录 API 可以读取同一权威值，避免跨服务硬编码。
BEGIN;

ALTER TABLE agent_status_config
    ADD COLUMN probation_completed_task_threshold INTEGER NOT NULL DEFAULT 3
        CHECK (probation_completed_task_threshold > 0);

COMMENT ON COLUMN agent_status_config.probation_completed_task_threshold IS
    '解除 Agent 冷启动单次报价限制所需的已验收并结算真实任务数；不含沙箱调用、仅接单或失败任务。';

COMMIT;
