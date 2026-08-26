-- Product Workflow 9-Agent 正式目录使用的三个稳定能力分类。
-- 这里只增加受控分类，不写本地 Agent；本地 Agent 由显式 bootstrap 脚本创建。
BEGIN;
INSERT INTO categories(id, parent_id, name, slug, version) VALUES
  ('40000000-0000-4000-8000-000000000021', '40000000-0000-4000-8000-000000000001', '产品需求与 PRD', 'product-requirements', 1),
  ('40000000-0000-4000-8000-000000000022', '40000000-0000-4000-8000-000000000003', '产品界面设计', 'product-interface-design', 1),
  ('40000000-0000-4000-8000-000000000023', '40000000-0000-4000-8000-000000000001', '软件开发', 'software-development', 1)
ON CONFLICT (id) DO NOTHING;
COMMIT;
