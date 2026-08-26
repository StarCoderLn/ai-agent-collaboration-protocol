package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type CredentialDecryptor interface {
	DecryptCredential(ctx context.Context, encrypted string) (string, error)
}

type CredentialKeyResolver struct {
	Pool      *pgxpool.Pool
	Decryptor CredentialDecryptor
}

/**
 * ActiveSigningKeys 是凭证密文唯一读取入口。它只向协议验签调用栈返回当前明文，既不
 * 暴露 HTTP API，也不缓存或记录该值。凭证历史轮换表落地后可在本方法内部返回双 key，
 * 不需要调用方理解存储格式。
 */
func (r CredentialKeyResolver) ActiveSigningKeys(ctx context.Context, agentID string) ([]string, error) {
	if r.Pool == nil || r.Decryptor == nil {
		return nil, errors.New("credential resolver requires pool and decryptor")
	}
	var encrypted string
	err := r.Pool.QueryRow(ctx, `
		SELECT credential.encrypted_secret
		  FROM agent_credentials credential
		  JOIN agents agent ON agent.id=credential.agent_id
		 WHERE credential.agent_id=$1 AND agent.status IN ('active','paused')`, agentID).Scan(&encrypted)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	secret, err := r.Decryptor.DecryptCredential(ctx, encrypted)
	if err != nil {
		return nil, errors.New("agent signing credential is unavailable")
	}
	return []string{secret}, nil
}

type NonceRepository struct{ Pool *pgxpool.Pool }

func (r NonceRepository) ReserveNonce(ctx context.Context, agentID, nonce string, observedAt time.Time) (bool, error) {
	result, err := r.Pool.Exec(ctx, `
		INSERT INTO used_nonces(nonce,agent_id,created_at) VALUES ($1,$2,$3)
		ON CONFLICT (nonce) DO NOTHING`, nonce, agentID, observedAt)
	return err == nil && result.RowsAffected() == 1, err
}

type IdempotencyRepository struct{ Pool *pgxpool.Pool }

func (r IdempotencyRepository) Reserve(
	ctx context.Context,
	key, operationType string,
	callType protocol.CallType,
	expiresAt time.Time,
) (protocol.StoredRecord, bool, error) {
	result, err := r.Pool.Exec(ctx, `
		INSERT INTO idempotency_records(
		 idempotency_key,operation_type,call_type,response_snapshot,expires_at
		) VALUES ($1,$2,$3,'null'::jsonb,$4)
		ON CONFLICT (idempotency_key) DO NOTHING`, key, operationType, callType, expiresAt)
	if err != nil {
		return protocol.StoredRecord{}, false, err
	}
	if result.RowsAffected() == 1 {
		return protocol.StoredRecord{}, true, nil
	}
	var storedOperation, storedCallType string
	var snapshotJSON []byte
	err = r.Pool.QueryRow(ctx, `
		SELECT operation_type,call_type,response_snapshot
		  FROM idempotency_records WHERE idempotency_key=$1`, key).Scan(&storedOperation, &storedCallType, &snapshotJSON)
	if err != nil {
		return protocol.StoredRecord{}, false, err
	}
	if storedOperation != operationType || storedCallType != string(callType) {
		return protocol.StoredRecord{}, false, fmt.Errorf("idempotency key reused for a different operation")
	}
	if bytes.Equal(bytes.TrimSpace(snapshotJSON), []byte("null")) {
		return protocol.StoredRecord{Committed: false}, false, nil
	}
	var snapshot protocol.ResponseSnapshot
	if err = json.Unmarshal(snapshotJSON, &snapshot); err != nil {
		return protocol.StoredRecord{}, false, fmt.Errorf("decode idempotency response snapshot: %w", err)
	}
	return protocol.StoredRecord{Committed: true, Snapshot: snapshot}, false, nil
}

func (r IdempotencyRepository) CommitResponse(ctx context.Context, key string, snapshot protocol.ResponseSnapshot) error {
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	result, err := r.Pool.Exec(ctx, `
		UPDATE idempotency_records SET response_snapshot=$2::jsonb
		 WHERE idempotency_key=$1 AND response_snapshot='null'::jsonb`, key, encoded)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return protocol.ErrIdempotencyKeyMissing
	}
	return nil
}
