-- 统一任务与 Agent 的匹配标签词表。
--
-- 匹配引擎按 canonical 标签做精确交集，因此“research”和“学术研究”即使语义相同，
-- 在未归一化时也会得到零标签匹配。本迁移扩充权威同义词，并只回填 Agent 档案与
-- 提供者案例；历史候选记录属于审计快照，必须保持生成当时的事实，不能静默重写。
BEGIN;

UPDATE tags
   SET synonyms = ARRAY(
     SELECT DISTINCT alias
       FROM unnest(
         synonyms || ARRAY[
           '学术研究',
           '文献检索',
           '论文写作',
           'academic research',
           'literature search',
           'paper writing'
         ]::TEXT[]
       ) AS alias
      ORDER BY alias
   )
 WHERE canonical_name = 'research';

-- 只把已确认属于 research 的同义词替换为 canonical 值。其他自定义标签原样保留，
-- 避免一次词表修复顺带改变尚未确认的业务含义；去重和稳定排序则使后续快照可复现。
UPDATE agents AS agent
   SET tags = ARRAY(
     SELECT DISTINCT
            CASE
              WHEN lower(regexp_replace(btrim(tag), '\s+', ' ', 'g')) = ANY(ARRAY[
                'research',
                '论文',
                '文献综述',
                '学术研究',
                '文献检索',
                '论文写作',
                'academic research',
                'literature search',
                'paper writing'
              ]::TEXT[])
                THEN 'research'
              ELSE tag
            END AS normalized_tag
       FROM unnest(agent.tags) AS tag
      ORDER BY normalized_tag
   )
 WHERE EXISTS (
   SELECT 1
     FROM unnest(agent.tags) AS tag
    WHERE lower(regexp_replace(btrim(tag), '\s+', ' ', 'g')) = ANY(ARRAY[
      'research',
      '论文',
      '文献综述',
      '学术研究',
      '文献检索',
      '论文写作',
      'academic research',
      'literature search',
      'paper writing'
    ]::TEXT[])
 );

-- 案例标签参与候选证据展示，必须和所属 Agent 使用同一 canonical 语义。
UPDATE agent_portfolio_cases AS portfolio
   SET tags = ARRAY(
     SELECT DISTINCT
            CASE
              WHEN lower(regexp_replace(btrim(tag), '\s+', ' ', 'g')) = ANY(ARRAY[
                'research',
                '论文',
                '文献综述',
                '学术研究',
                '文献检索',
                '论文写作',
                'academic research',
                'literature search',
                'paper writing'
              ]::TEXT[])
                THEN 'research'
              ELSE tag
            END AS normalized_tag
       FROM unnest(portfolio.tags) AS tag
      ORDER BY normalized_tag
   )
 WHERE EXISTS (
   SELECT 1
     FROM unnest(portfolio.tags) AS tag
    WHERE lower(regexp_replace(btrim(tag), '\s+', ' ', 'g')) = ANY(ARRAY[
      'research',
      '论文',
      '文献综述',
      '学术研究',
      '文献检索',
      '论文写作',
      'academic research',
      'literature search',
      'paper writing'
    ]::TEXT[])
 );

COMMIT;
