-- 仅恢复 0047 定义的平台目录报价；历史候选和已冻结报价从未被本迁移改写。
BEGIN;

UPDATE agents
   SET price_amount = CASE id
         WHEN '91000000-0000-4000-8000-000000000004' THEN 2000000
         WHEN '91000000-0000-4000-8000-000000000007' THEN 3000000
         ELSE price_amount
       END,
       updated_at = now()
 WHERE id IN (
   '91000000-0000-4000-8000-000000000004',
   '91000000-0000-4000-8000-000000000007'
 );

COMMIT;
