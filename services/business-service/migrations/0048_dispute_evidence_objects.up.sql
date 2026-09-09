BEGIN;

-- 证据文件正文由数据库保存不可变字节，storage_ref 只引用这里的内容寻址对象。
-- 这样本机 Sepolia 验收不依赖 AWS，同时下载时仍能重新计算摘要验证字节没有变化。
CREATE TABLE dispute_evidence_objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL REFERENCES disputes(id),
  uploaded_by TEXT NOT NULL CHECK (uploaded_by ~ '^0x[0-9a-f]{40}$'),
  original_name TEXT NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
  mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 120),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content BYTEA NOT NULL,
  evidence_id UUID REFERENCES dispute_evidence(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at TIMESTAMPTZ,
  UNIQUE(dispute_id,id),
  CHECK (octet_length(content)=size_bytes),
  CHECK ((evidence_id IS NULL)=(committed_at IS NULL))
);

CREATE INDEX dispute_evidence_objects_staged
  ON dispute_evidence_objects(dispute_id,uploaded_by,created_at)
  WHERE evidence_id IS NULL;

CREATE FUNCTION protect_dispute_evidence_object() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EVIDENCE_OBJECT_IS_IMMUTABLE';
  END IF;
  IF ROW(NEW.id,NEW.dispute_id,NEW.uploaded_by,NEW.original_name,NEW.mime_type,
         NEW.size_bytes,NEW.sha256,NEW.content,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.dispute_id,OLD.uploaded_by,OLD.original_name,OLD.mime_type,
         OLD.size_bytes,OLD.sha256,OLD.content,OLD.created_at)
  THEN
    RAISE EXCEPTION 'EVIDENCE_OBJECT_IS_IMMUTABLE';
  END IF;
  IF OLD.evidence_id IS NOT NULL AND
     ROW(NEW.evidence_id,NEW.committed_at) IS DISTINCT FROM ROW(OLD.evidence_id,OLD.committed_at)
  THEN
    RAISE EXCEPTION 'COMMITTED_EVIDENCE_OBJECT_IS_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dispute_evidence_object_immutable
BEFORE UPDATE OR DELETE ON dispute_evidence_objects
FOR EACH ROW EXECUTE FUNCTION protect_dispute_evidence_object();

COMMIT;
