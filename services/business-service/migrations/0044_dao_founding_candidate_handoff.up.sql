BEGIN;

-- 每个案件在创建时固化候选来源阶段与创始成员名单。部署配置后续变化只能影响新案件，
-- 不能在证据期、首审或申诉期间悄悄替换已经承诺的仲裁组织来源。
ALTER TABLE dao_chain_cases ADD COLUMN candidate_pool_policy JSONB NOT NULL DEFAULT jsonb_build_object(
  'version','founding-handoff-v1',
  'phase','community',
  'foundingArbitrators','[]'::jsonb,
  'communityEligibleAtOpen',0,
  'mixedThreshold',8,
  'handoffThreshold',12,
  'mixedFoundingLimit',5
);

ALTER TABLE dao_chain_cases ADD CONSTRAINT dao_chain_cases_candidate_pool_policy_shape CHECK (
  jsonb_typeof(candidate_pool_policy)='object'
  AND candidate_pool_policy->>'version'='founding-handoff-v1'
  AND candidate_pool_policy->>'phase' IN ('bootstrap','mixed','community')
  AND jsonb_typeof(candidate_pool_policy->'foundingArbitrators')='array'
  AND (candidate_pool_policy->>'communityEligibleAtOpen') ~ '^[0-9]+$'
  AND candidate_pool_policy->>'mixedThreshold'='8'
  AND candidate_pool_policy->>'handoffThreshold'='12'
  AND candidate_pool_policy->>'mixedFoundingLimit'='5'
);

COMMIT;
