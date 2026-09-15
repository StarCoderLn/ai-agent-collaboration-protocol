package main

import "testing"

func TestBooleanEnvOrDefaultAcceptsOnlyExplicitBooleanValues(t *testing.T) {
	t.Setenv("ADMISSION_BOOLEAN_TEST", "")
	value, err := booleanEnvOrDefault("ADMISSION_BOOLEAN_TEST", true)
	if err != nil || !value {
		t.Fatalf("空值应使用默认配置：value=%t err=%v", value, err)
	}

	t.Setenv("ADMISSION_BOOLEAN_TEST", " FALSE ")
	value, err = booleanEnvOrDefault("ADMISSION_BOOLEAN_TEST", true)
	if err != nil || value {
		t.Fatalf("显式 false 应关闭 Worker：value=%t err=%v", value, err)
	}

	t.Setenv("ADMISSION_BOOLEAN_TEST", "disabled")
	if _, err = booleanEnvOrDefault("ADMISSION_BOOLEAN_TEST", true); err == nil {
		t.Fatal("拼写错误的布尔配置不能被静默解释为关闭")
	}
}

func TestAdmissionEngineUsesOneExplicitRuntime(t *testing.T) {
	t.Setenv("AGENT_ADMISSION_ENGINE", "")
	if engine, err := admissionEngineFromEnvironment(true); err != nil || engine != "postgres" {
		t.Fatalf("默认应保留 PostgreSQL Worker：engine=%s err=%v", engine, err)
	}
	t.Setenv("AGENT_ADMISSION_ENGINE", "temporal")
	if engine, err := admissionEngineFromEnvironment(true); err != nil || engine != "temporal" {
		t.Fatalf("显式 Temporal 模式应生效：engine=%s err=%v", engine, err)
	}
	if engine, err := admissionEngineFromEnvironment(false); err != nil || engine != "disabled" {
		t.Fatalf("总开关关闭时不得启动任一 Worker：engine=%s err=%v", engine, err)
	}
	t.Setenv("AGENT_ADMISSION_ENGINE", "both")
	if _, err := admissionEngineFromEnvironment(true); err == nil {
		t.Fatal("双 Worker 或未知模式必须被拒绝")
	}
}

func TestMatchingV2ModeKeepsShadowAndOnlineReleaseRulesSeparate(t *testing.T) {
	t.Setenv("MATCHING_V2_SHADOW_ENABLED", "true")
	t.Setenv("MATCHING_V2_ONLINE_ENABLED", "false")
	mode, err := matchingV2ModeFromEnvironment(false)
	if err != nil || mode != "shadow" {
		t.Fatalf("shadow 不改变正式 Top-3，应允许在未启用语义召回时做合成模型评估：mode=%s err=%v", mode, err)
	}

	t.Setenv("MATCHING_V2_SHADOW_ENABLED", "false")
	t.Setenv("MATCHING_V2_ONLINE_ENABLED", "true")
	if _, err = matchingV2ModeFromEnvironment(false); err == nil {
		t.Fatal("online 必须使用 pgvector 语义召回，不得退回到旧候选集")
	}
	mode, err = matchingV2ModeFromEnvironment(true)
	if err != nil || mode != "online" {
		t.Fatalf("启用语义召回后应进入 online 分支，后续由该分支执行 active + real 门禁：mode=%s err=%v", mode, err)
	}
}

func TestMatchingV2ModeRejectsShadowAndOnlineAtTheSameTime(t *testing.T) {
	t.Setenv("MATCHING_V2_SHADOW_ENABLED", "true")
	t.Setenv("MATCHING_V2_ONLINE_ENABLED", "true")
	if _, err := matchingV2ModeFromEnvironment(true); err == nil {
		t.Fatal("同一进程不得同时运行 shadow 和 online")
	}
}

func TestAWSConfigUsesAnExplicitLocalStackEndpointWithoutChangingProductionDefault(t *testing.T) {
	t.Setenv("AWS_ENDPOINT_URL", "")
	config, err := awsConfigFromEnvironment("ap-southeast-1")
	if err != nil || config.Endpoint != nil {
		t.Fatalf("生产默认应由 AWS SDK 根据 region 解析端点：config=%v err=%v", config, err)
	}

	t.Setenv("AWS_ENDPOINT_URL", "http://127.0.0.1:4566/")
	config, err = awsConfigFromEnvironment("us-east-1")
	if err != nil || config.Endpoint == nil || *config.Endpoint != "http://127.0.0.1:4566" {
		t.Fatalf("LocalStack 端点应经过校验和归一化：config=%v err=%v", config, err)
	}

	t.Setenv("AWS_ENDPOINT_URL", "127.0.0.1:4566")
	if _, err = awsConfigFromEnvironment("us-east-1"); err == nil {
		t.Fatal("缺少协议的 LocalStack 端点不得传入 AWS SDK")
	}
}
