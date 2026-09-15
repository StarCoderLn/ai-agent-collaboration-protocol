package store

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestRequireActiveRealModelRejectsSyntheticRelease 用真实 PostgreSQL 证明应用层门禁不会只
// 依赖 migration 的 CHECK。即使 synthetic 模型已经注册且 HTTP 服务可用，它也不能通过
// Dispatch Engine 的正式发布校验；测试全程只读，不改写共享开发库。
func TestRequireActiveRealModelRejectsSyntheticRelease(t *testing.T) {
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
	var version string
	err = pool.QueryRow(ctx, `
		SELECT version
		  FROM matching_v2_model_versions
		 WHERE training_data_origin='synthetic'
		 ORDER BY created_at DESC
		 LIMIT 1`).Scan(&version)
	if err != nil {
		t.Skip("database has no synthetic model fixture")
	}
	err = (&MatchingTrainingRepository{Pool: pool}).RequireActiveRealModel(
		ctx,
		version,
		"matching-v2.features.v1",
	)
	if err == nil {
		t.Fatalf("synthetic model %s unexpectedly passed the production release gate", version)
	}
}
