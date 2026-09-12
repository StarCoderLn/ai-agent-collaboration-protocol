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
