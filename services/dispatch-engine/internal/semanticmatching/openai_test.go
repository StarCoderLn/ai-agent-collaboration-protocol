package semanticmatching

import (
	"context"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestOpenAIEmbedderLive(t *testing.T) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		t.Skip("OPENAI_API_KEY is not configured")
	}
	embedder := OpenAIEmbedder{
		Client: &http.Client{}, BaseURL: "https://api.openai.com/v1", APIKey: apiKey,
		Model: DefaultModel, Dimensions: DefaultDimensions,
	}
	vectors, err := embedder.Embed(context.Background(), []string{"语义匹配真实连通性验证"})
	if err != nil {
		t.Fatal(err)
	}
	if len(vectors) != 1 || len(vectors[0]) != DefaultDimensions {
		t.Fatalf("unexpected live embedding shape: vectors=%d dimensions=%d", len(vectors), len(vectors[0]))
	}
}

func TestOpenAIEmbedderPreservesResponseIndexOrderAndDoesNotExposeKey(t *testing.T) {
	const secret = "sk-test-secret"
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Header.Get("Authorization") != "Bearer "+secret || request.URL.Path != "/v1/embeddings" {
			t.Fatalf("unexpected OpenAI request")
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(
			`{"data":[{"index":1,"embedding":[0,1,0]},{"index":0,"embedding":[1,0,0]}]}`,
		))}, nil
	})}
	embedder := OpenAIEmbedder{Client: client, BaseURL: "https://example.test/v1", APIKey: secret, Model: DefaultModel, Dimensions: 3}

	vectors, err := embedder.Embed(context.Background(), []string{"first", "second"})
	if err != nil {
		t.Fatal(err)
	}
	if vectors[0][0] != 1 || vectors[1][1] != 1 {
		t.Fatalf("response indexes were ignored: %+v", vectors)
	}

	embedder.Client = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusUnauthorized, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(
			`{"error":{"message":"request used ` + secret + `","type":"invalid_api_key"}}`,
		))}, nil
	})}
	_, err = embedder.Embed(context.Background(), []string{"input"})
	if err == nil || strings.Contains(err.Error(), secret) {
		t.Fatalf("credential leaked through error: %v", err)
	}
}
