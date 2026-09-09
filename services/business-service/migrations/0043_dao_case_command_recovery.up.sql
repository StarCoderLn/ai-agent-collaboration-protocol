BEGIN;

-- 逻辑推进命令保持唯一；每次已签名交易单独追加为不可覆盖的尝试。这样回滚交易可以
-- 在保留原 nonce、原始字节和哈希的前提下重新签名，不会把历史改写成“从未广播”。
CREATE TABLE dao_case_command_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id UUID NOT NULL REFERENCES dao_case_commands(id),
  attempt_no INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND 5),
  raw_transaction TEXT NOT NULL,
  tx_hash TEXT NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('prepared','submitted','confirmed','reverted')),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(command_id,attempt_no),
  UNIQUE(tx_hash)
);

-- 0041 已保存的当前签名是第一份尝试。失败且仍带签名的命令只可能来自已确认回滚；
-- prepared/submitted 的未知回执继续保留原状态，升级不会触发重签或广播。
INSERT INTO dao_case_command_attempts(command_id,attempt_no,raw_transaction,tx_hash,status,error_code,created_at,updated_at)
SELECT id,1,raw_transaction,tx_hash,
       CASE status WHEN 'failed' THEN 'reverted' ELSE status END,
       error_code,created_at,updated_at
  FROM dao_case_commands
 WHERE tx_hash IS NOT NULL AND raw_transaction IS NOT NULL;

CREATE INDEX dao_case_command_attempts_pending
  ON dao_case_command_attempts(created_at,id)
  WHERE status IN ('prepared','submitted');

COMMIT;
