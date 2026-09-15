package store

import (
	"testing"
	"time"
)

func TestProductionMatchingModelRequiresAnActivePublishedRealRelease(t *testing.T) {
	publishedAt := time.Now().UTC()
	tests := []struct {
		name          string
		loadedVersion string
		feature       string
		state         string
		origin        string
		publishedAt   *time.Time
		want          bool
	}{
		{
			name: "已发布的真实 active 模型可以上线", loadedVersion: "model-1",
			feature: "matching-v2.features.v1", state: "active", origin: "real", publishedAt: &publishedAt, want: true,
		},
		{
			name: "合成数据模型只能用于影子评估", loadedVersion: "model-1",
			feature: "matching-v2.features.v1", state: "active", origin: "synthetic", publishedAt: &publishedAt,
		},
		{
			name: "candidate 模型尚未获得正式流量授权", loadedVersion: "model-1",
			feature: "matching-v2.features.v1", state: "candidate", origin: "real", publishedAt: &publishedAt,
		},
		{
			name: "特征契约不一致时不得运行", loadedVersion: "model-1",
			feature: "matching-v2.features.v0", state: "active", origin: "real", publishedAt: &publishedAt,
		},
		{
			name: "进程加载的制品必须与注册版本一致", loadedVersion: "model-2",
			feature: "matching-v2.features.v1", state: "active", origin: "real", publishedAt: &publishedAt,
		},
		{
			name: "未记录发布时间的模型不得运行", loadedVersion: "model-1",
			feature: "matching-v2.features.v1", state: "active", origin: "real",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			release := matchingModelRelease{
				version: "model-1", featureSchemaVersion: "matching-v2.features.v1",
				state: test.state, dataOrigin: test.origin, publishedAt: test.publishedAt,
			}
			got := isProductionMatchingModel(release, test.loadedVersion, test.feature)
			if got != test.want {
				t.Fatalf("发布资格判断错误：got=%t want=%t", got, test.want)
			}
		})
	}
}
