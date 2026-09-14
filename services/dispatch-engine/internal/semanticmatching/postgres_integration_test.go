package semanticmatching

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresTopKUsesSourceHashAndMeetsLocalLatencyTarget(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	rows, err := pool.Query(ctx, `SELECT id::text FROM agents ORDER BY id LIMIT 2`)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if len(ids) < 2 {
		t.Skip("at least two agents are required")
	}
	// 这是可再生缓存，测试前后只清理选中的两行，不修改 Agent、任务或历史分发记录。
	_, err = pool.Exec(ctx, `DELETE FROM agent_matching_embeddings WHERE agent_id=ANY($1::uuid[])`, ids)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM agent_matching_embeddings WHERE agent_id=ANY($1::uuid[])`, ids)
	})

	first := make([]float32, DefaultDimensions)
	second := make([]float32, DefaultDimensions)
	first[0] = 1
	second[1] = 1
	store := PostgresStore{Pool: pool}
	embeddings := []StoredEmbedding{
		{AgentID: ids[0], SourceHash: strings.Repeat("a", 64), Vector: first},
		{AgentID: ids[1], SourceHash: strings.Repeat("b", 64), Vector: second},
	}
	if err = store.Upsert(ctx, embeddings, DefaultModel, DefaultDimensions); err != nil {
		t.Fatal(err)
	}
	sources := []AgentSource{
		{AgentID: ids[0], SourceHash: embeddings[0].SourceHash},
		// 错误哈希必须排除第二个 Agent，证明查询不会在并发档案变化时使用陈旧向量。
		{AgentID: ids[1], SourceHash: strings.Repeat("c", 64)},
	}
	var neighbors []Neighbor
	var duration time.Duration
	var queryErr error
	bestDuration := time.Hour
	for range 3 {
		neighbors, duration, queryErr = store.TopK(ctx, first, sources, DefaultModel, DefaultDimensions, 2)
		if queryErr != nil {
			t.Fatal(queryErr)
		}
		if duration < bestDuration {
			bestDuration = duration
		}
	}
	if len(neighbors) != 1 || neighbors[0].AgentID != ids[0] {
		t.Fatalf("unexpected source-hash constrained Top-k result: %+v", neighbors)
	}
	if bestDuration >= 50*time.Millisecond {
		t.Fatalf("warm Top-k query exceeded 50ms target: %s", bestDuration)
	}
}
