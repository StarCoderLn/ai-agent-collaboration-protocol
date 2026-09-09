/**
 * 本机两种运行入口共享同一体验数据库和内部 worker token。它们只允许通过 loopback
 * 使用；调用方仍需分别校验数据库、HTTP 端口和链配置，不能把本机默认值带入部署产物。
 */
export const LOCAL_DATABASE_URL =
	"postgres://aicp_test:aicp_test_password@127.0.0.1:55432/aicp_test";
export const LOCAL_INTERNAL_TOKEN = "aicp-local-internal-token-2026";
