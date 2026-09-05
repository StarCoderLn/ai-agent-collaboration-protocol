-- 回滚只撤销本版本新增的同义词配置，不反向改写已规范化的 Agent 和案例标签。
-- canonical 数据仍然是合法业务数据；强行恢复旧别名既无法知道原始写法，也会重新
-- 制造任务与 Agent 语义一致却无法匹配的问题。
BEGIN;

UPDATE tags
   SET synonyms = ARRAY(
     SELECT alias
       FROM unnest(synonyms) AS alias
      WHERE lower(regexp_replace(btrim(alias), '\s+', ' ', 'g')) <> ALL(ARRAY[
        '学术研究',
        '文献检索',
        '论文写作',
        'academic research',
        'literature search',
        'paper writing'
      ]::TEXT[])
      ORDER BY alias
   )
 WHERE canonical_name = 'research';

COMMIT;
