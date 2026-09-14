package store

import (
	"context"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/matching"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/semanticmatching"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	semanticLiveTaskID   = "80510000-0000-4000-8000-000000000001"
	semanticLiveAgentAID = "80510000-0000-4000-8000-000000000002"
	semanticLiveAgentBID = "80510000-0000-4000-8000-000000000003"
	semanticLiveCategory = "80510000-0000-4000-8000-000000000004"
)

func TestSemanticMatchingPostgresOpenAILive(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	openAIKey := os.Getenv("OPENAI_API_KEY")
	if databaseURL == "" || openAIKey == "" {
		t.Skip("DATABASE_URL and OPENAI_API_KEY are required")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	cleanup := func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM job_distribution_records WHERE task_id=$1`, semanticLiveTaskID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM tasks WHERE id=$1`, semanticLiveTaskID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM agent_matching_embeddings WHERE agent_id=ANY($1::uuid[])`, []string{semanticLiveAgentAID, semanticLiveAgentBID})
		_, _ = pool.Exec(context.Background(), `DELETE FROM agents WHERE id=ANY($1::uuid[])`, []string{semanticLiveAgentAID, semanticLiveAgentBID})
		_, _ = pool.Exec(context.Background(), `DELETE FROM categories WHERE id=$1`, semanticLiveCategory)
	}
	cleanup()
	t.Cleanup(cleanup)

	_, err = pool.Exec(ctx, `INSERT INTO categories(id,name,slug) VALUES($1,'语义测试隔离分类','semantic-live-fixture')`, semanticLiveCategory)
	if err != nil {
		t.Fatal(err)
	}
	for _, fixture := range []struct {
		id, name, description string
		tags                  []string
	}{
		{semanticLiveAgentAID, "合成研究助手", "整理公开资料并生成结构化中文摘要。", []string{"research", "summary"}},
		{semanticLiveAgentBID, "合成代码助手", "实现 Go API 并编写自动化测试。", []string{"go", "testing"}},
	} {
		_, err = pool.Exec(ctx, `
			INSERT INTO agents(
			 id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,
			 pricing_type,price_amount,price_currency,service_endpoint,email,status,
			 estimated_duration_seconds,response_minutes
			) VALUES($1,'0x1111111111111111111111111111111111111111','0x1111111111111111111111111111111111111111',
			 $2,$3,$4,$5,'fixed',1000000,'USDC','http://127.0.0.1:3999/agent','fixture@example.com',
			 'active',60,1)`, fixture.id, fixture.name, semanticLiveCategory, fixture.description, fixture.tags)
		if err != nil {
			t.Fatal(err)
		}
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO tasks(
		 id,publisher_id,title,description,category_id,category_version,acceptance_criteria,
		 deliverable_format,pricing_type,tag_names,visibility,budget_min_minor,budget_max_minor,
		 currency,deadline,required_capability,attachments,status,assignment_mode_config,
		 acceptance_mode,acceptor_config
		) VALUES(
		 $1,'semantic-live-test','语义匹配真实验收','根据自然语言需求召回最相关的 Agent。',
		 $2,1,'返回可审计候选','JSON','fixed',ARRAY['research'],'private',12000000,12000000,
		 'USDC',now()+interval '24 hours','资料研究与内容总结','[]'::jsonb,'matching',
		 '{"mode":"manual"}'::jsonb,'manual','{}'::jsonb
		)`, semanticLiveTaskID, semanticLiveCategory)
	if err != nil {
		t.Fatal(err)
	}
	semanticConfig := semanticmatching.Config{
		Model: semanticmatching.DefaultModel, Dimensions: semanticmatching.DefaultDimensions, TopK: 3,
	}
	service := matching.Service{
		Repository: &MatchingRepository{Pool: pool},
		Semantic: &semanticmatching.Service{
			Embedder: &semanticmatching.OpenAIEmbedder{
				Client: &http.Client{Timeout: 15 * time.Second}, BaseURL: "https://api.openai.com/v1",
				APIKey: openAIKey, Model: semanticConfig.Model, Dimensions: semanticConfig.Dimensions,
			},
			Store: &semanticmatching.PostgresStore{Pool: pool}, Config: semanticConfig,
		},
		Now: time.Now,
	}
	record, err := service.RunMatching(ctx, semanticLiveTaskID)
	if err != nil {
		t.Fatal(err)
	}
	if record.MatchingMode != "semantic_v1" || record.SemanticModel != semanticmatching.DefaultModel {
		t.Fatalf("semantic mode evidence missing: %+v", record)
	}
	if len(record.Candidates) == 0 || len(record.Candidates) > semanticConfig.TopK {
		t.Fatalf("unexpected Top-k candidates: %+v", record.Candidates)
	}
	if record.SemanticQueryMS >= 50 {
		t.Fatalf("pgvector query exceeded 50ms target: %.3fms", record.SemanticQueryMS)
	}
	t.Logf("semantic candidates=%d pgvector_query=%.3fms", len(record.Candidates), record.SemanticQueryMS)
	for _, candidate := range record.Candidates {
		if candidate.SemanticSimilarity == nil {
			t.Fatalf("candidate lacks semantic evidence: %+v", candidate)
		}
	}
}
