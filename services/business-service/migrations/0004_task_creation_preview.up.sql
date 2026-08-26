-- Feature 4: 任务创建、分类标签与发布预览。
BEGIN;

CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id UUID REFERENCES categories(id),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_name TEXT NOT NULL UNIQUE,
    synonyms TEXT[] NOT NULL DEFAULT '{}',
    forbidden BOOLEAN NOT NULL DEFAULT FALSE
);

-- MVP 先提供一组稳定 UUID 的受控分类与标签，前端和测试可引用 ID 而不依赖插入顺序。
-- 后续运营调整只更新 active/version 或新增记录，不重写历史任务的 category_version 快照。
INSERT INTO categories(id, parent_id, name, slug, version) VALUES
  ('40000000-0000-4000-8000-000000000001', NULL, '产品与开发', 'product-development', 1),
  ('40000000-0000-4000-8000-000000000002', NULL, '研究分析', 'research-analysis', 1),
  ('40000000-0000-4000-8000-000000000003', NULL, '内容与设计', 'content-design', 1),
  ('40000000-0000-4000-8000-000000000004', NULL, '数据处理', 'data-processing', 1),
  ('40000000-0000-4000-8000-000000000011', '40000000-0000-4000-8000-000000000003', '文档内容', 'document-content', 1),
  ('40000000-0000-4000-8000-000000000012', '40000000-0000-4000-8000-000000000003', '图片设计', 'image-design', 1),
  ('40000000-0000-4000-8000-000000000013', '40000000-0000-4000-8000-000000000003', '视频制作', 'video-production', 1);

INSERT INTO tags(canonical_name, synonyms) VALUES
  ('agent', ARRAY['ai agent', '智能体']),
  ('next.js', ARRAY['nextjs', 'next js']),
  ('typescript', ARRAY['ts']),
  ('prd', ARRAY['产品需求文档', '需求文档']),
  ('ui/ux', ARRAY['ui', 'ux', '界面设计']),
  ('mastra', ARRAY[]::TEXT[]),
  ('research', ARRAY['论文', '文献综述']),
  ('data-analysis', ARRAY['数据分析']);

CREATE TABLE attachment_category_limits (
    category_id UUID PRIMARY KEY REFERENCES categories(id),
    max_files INTEGER NOT NULL DEFAULT 10 CHECK (max_files > 0),
    max_file_size_bytes BIGINT NOT NULL CHECK (max_file_size_bytes > 0),
    allowed_mime_types TEXT[] NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO attachment_category_limits(category_id, max_files, max_file_size_bytes, allowed_mime_types) VALUES
  ('40000000-0000-4000-8000-000000000011', 10, 52428800, ARRAY['application/pdf','text/plain','text/markdown','application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  ('40000000-0000-4000-8000-000000000012', 10, 20971520, ARRAY['image/png','image/jpeg','image/webp']),
  ('40000000-0000-4000-8000-000000000013', 5, 1073741824, ARRAY['video/mp4','video/webm','video/quicktime']);

CREATE TABLE platform_fee_config (
    version TEXT PRIMARY KEY,
    fee_basis_points INTEGER NOT NULL DEFAULT 40 CHECK (fee_basis_points BETWEEN 0 AND 10000),
    gas_fallback_minor BIGINT NOT NULL DEFAULT 50 CHECK (gas_fallback_minor >= 0),
    active BOOLEAN NOT NULL DEFAULT FALSE,
    effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_to TIMESTAMPTZ,
    CHECK (effective_to IS NULL OR effective_to > effective_from),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_platform_fee_config_active ON platform_fee_config(active) WHERE active;
INSERT INTO platform_fee_config(version, fee_basis_points, gas_fallback_minor, active)
VALUES ('fee-v1', 40, 50, TRUE);

CREATE TABLE task_timing_config (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    min_execution_period_seconds INTEGER NOT NULL DEFAULT 1800 CHECK (min_execution_period_seconds > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO task_timing_config(id) VALUES (TRUE);

CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    publisher_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category_id UUID REFERENCES categories(id),
    category_version INTEGER CHECK (category_version IS NULL OR category_version > 0),
    acceptance_criteria TEXT NOT NULL DEFAULT '',
    deliverable_format TEXT NOT NULL DEFAULT '',
    pricing_type TEXT CHECK (pricing_type IN ('fixed','range')),
    tag_names TEXT[] NOT NULL DEFAULT '{}',
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
    budget_min_minor BIGINT CHECK (budget_min_minor IS NULL OR budget_min_minor > 0),
    budget_max_minor BIGINT CHECK (budget_max_minor IS NULL OR budget_max_minor > 0),
    currency TEXT NOT NULL DEFAULT 'USDC',
    deadline TIMESTAMPTZ,
    required_capability TEXT NOT NULL DEFAULT '',
    attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
      'draft','awaiting_escrow','matching','awaiting_agent_acceptance','executing',
      'awaiting_review','rework','pending_settlement','settled','disputed','refunded','timed_out'
    )),
    status_version BIGINT NOT NULL DEFAULT 0 CHECK (status_version >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((category_id IS NULL) = (category_version IS NULL)),
    CHECK (
      (pricing_type IS NULL AND budget_min_minor IS NULL AND budget_max_minor IS NULL)
      OR
      (pricing_type IS NOT NULL AND budget_min_minor IS NOT NULL AND budget_max_minor IS NOT NULL
       AND budget_min_minor <= budget_max_minor
       AND (pricing_type <> 'fixed' OR budget_min_minor = budget_max_minor))
    ),
    CHECK (jsonb_typeof(attachments) = 'array'),
    -- 数据库也保证草稿之外的状态具备发布所需的结构；即使未来出现新的写入入口，
    -- 也无法绕过服务层把半成品推进交易状态。
    CHECK (status = 'draft' OR (
      category_id IS NOT NULL AND category_version IS NOT NULL
      AND pricing_type IS NOT NULL AND deadline IS NOT NULL
      AND length(trim(title)) > 0 AND length(trim(description)) > 0
      AND length(trim(acceptance_criteria)) > 0
      AND length(trim(deliverable_format)) > 0
      AND length(trim(required_capability)) > 0
    ))
);
CREATE INDEX idx_tasks_market ON tasks(visibility, status, created_at DESC);
CREATE INDEX idx_tasks_publisher ON tasks(publisher_id, updated_at DESC);
CREATE TRIGGER trg_tasks_set_updated_at BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
