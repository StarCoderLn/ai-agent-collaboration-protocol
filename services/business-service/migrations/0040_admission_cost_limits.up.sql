-- 将内部故障恢复次数持久化，避免 Worker 重启后重新获得无限次付费评审机会。
-- 历史轮次与原测试模板不改写；v3 只供尚未创建测试记录的新轮次选择。
BEGIN;
ALTER TABLE sandbox_admission_rounds
    ADD COLUMN IF NOT EXISTS worker_attempts INTEGER NOT NULL DEFAULT 0 CHECK (worker_attempts >= 0);

INSERT INTO sandbox_test_templates(id, category_id, test_input, checklist_items, version)
SELECT '15000000-0000-4000-8000-000000000003', category_id,
    jsonb_build_object('cases', (
        SELECT jsonb_agg(item || jsonb_build_object(
            'description', item->>'description' || E'\n测试范围：只需一个最小可查看示例，不要求完整商业项目。文档正文不超过 2000 字；图片最多 1 张，优先低分辨率；视频最多 5 秒；演示文稿最多 4 页。禁止购买商品、部署线上服务或转移资金。提供者须在服务端限制必要的模型调用及费用；无法在限制内完成时应明确返回原因。'
        ) ORDER BY ordinal)
        FROM jsonb_array_elements(test_input->'cases') WITH ORDINALITY AS cases(item, ordinal)
    )), checklist_items, 3
FROM sandbox_test_templates WHERE id='15000000-0000-4000-8000-000000000002'
ON CONFLICT (id) DO NOTHING;
COMMIT;
