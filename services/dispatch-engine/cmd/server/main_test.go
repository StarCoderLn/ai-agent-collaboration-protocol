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
