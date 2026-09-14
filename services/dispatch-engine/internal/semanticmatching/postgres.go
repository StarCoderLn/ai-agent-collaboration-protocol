package semanticmatching

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresStore 使用现有业务 PostgreSQL 的 pgvector 扩展，避免为当前规模增加独立服务。
type PostgresStore struct {
	Pool *pgxpool.Pool
}

// ExistingSourceHashes 只读取同一模型和维度的缓存，避免跨模型误判为无需更新。
func (s *PostgresStore) ExistingSourceHashes(ctx context.Context, agentIDs []string, model string, dimensions int) (map[string]string, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("semantic store requires pool")
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT agent_id::text,source_hash
		  FROM agent_matching_embeddings
		 WHERE agent_id=ANY($1::uuid[]) AND model=$2 AND dimensions=$3`, agentIDs, model, dimensions)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hashes := make(map[string]string, len(agentIDs))
	for rows.Next() {
		var agentID, sourceHash string
		if err = rows.Scan(&agentID, &sourceHash); err != nil {
			return nil, err
		}
		hashes[agentID] = sourceHash
	}
	return hashes, rows.Err()
}

// Upsert 在一个事务内更新本批缺失向量；内容、模型和维度均未变化时不刷新时间戳。
func (s *PostgresStore) Upsert(ctx context.Context, embeddings []StoredEmbedding, model string, dimensions int) error {
	if s == nil || s.Pool == nil {
		return errors.New("semantic store requires pool")
	}
	if len(embeddings) == 0 {
		return nil
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, embedding := range embeddings {
		_, err = tx.Exec(ctx, `
			INSERT INTO agent_matching_embeddings(agent_id,source_hash,model,dimensions,embedding)
			VALUES($1,$2,$3,$4,$5::vector)
			ON CONFLICT(agent_id) DO UPDATE SET
			  source_hash=EXCLUDED.source_hash,model=EXCLUDED.model,
			  dimensions=EXCLUDED.dimensions,embedding=EXCLUDED.embedding,updated_at=now()
			WHERE ROW(agent_matching_embeddings.source_hash,agent_matching_embeddings.model,agent_matching_embeddings.dimensions)
			      IS DISTINCT FROM ROW(EXCLUDED.source_hash,EXCLUDED.model,EXCLUDED.dimensions)`,
			embedding.AgentID, embedding.SourceHash, model, dimensions, vectorLiteral(embedding.Vector))
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// TopK 将本次 REPEATABLE READ 输入中的 agent_id 与 source_hash 一起连接。并发编辑
// Agent 时，旧请求不会误用新文本的向量，新请求也不会读到旧文本的向量。
func (s *PostgresStore) TopK(ctx context.Context, query []float32, sources []AgentSource, model string, dimensions, limit int) ([]Neighbor, time.Duration, error) {
	if s == nil || s.Pool == nil {
		return nil, 0, errors.New("semantic store requires pool")
	}
	ids := make([]string, 0, len(sources))
	hashes := make([]string, 0, len(sources))
	for _, source := range sources {
		ids = append(ids, source.AgentID)
		hashes = append(hashes, source.SourceHash)
	}
	started := time.Now()
	rows, err := s.Pool.Query(ctx, `
		WITH eligible(agent_id,source_hash) AS (
		  SELECT * FROM unnest($2::uuid[],$3::text[])
		)
		SELECT embedding.agent_id::text,
		       GREATEST(-1,LEAST(1,1-(embedding.embedding <=> $1::vector))) AS similarity
		  FROM agent_matching_embeddings embedding
		  JOIN eligible ON eligible.agent_id=embedding.agent_id
		               AND eligible.source_hash=embedding.source_hash
		 WHERE embedding.model=$4 AND embedding.dimensions=$5
		 ORDER BY embedding.embedding <=> $1::vector,embedding.agent_id
		 LIMIT $6`, vectorLiteral(query), ids, hashes, model, dimensions, limit)
	queryDuration := time.Since(started)
	if err != nil {
		return nil, queryDuration, err
	}
	defer rows.Close()
	neighbors := make([]Neighbor, 0, limit)
	for rows.Next() {
		var neighbor Neighbor
		if err = rows.Scan(&neighbor.AgentID, &neighbor.Similarity); err != nil {
			return nil, queryDuration, err
		}
		neighbors = append(neighbors, neighbor)
	}
	return neighbors, queryDuration, rows.Err()
}

func vectorLiteral(vector []float32) string {
	var builder strings.Builder
	builder.WriteByte('[')
	for index, value := range vector {
		if index > 0 {
			builder.WriteByte(',')
		}
		builder.WriteString(strconv.FormatFloat(float64(value), 'g', -1, 32))
	}
	builder.WriteByte(']')
	return builder.String()
}
