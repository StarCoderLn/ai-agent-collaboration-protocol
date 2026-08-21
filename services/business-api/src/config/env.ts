/**
 * 环境变量读取（2.agent-registration T-003）。
 *
 * 所有密钥/连接串一律经此模块读取，禁止在业务代码中裸读 `process.env`
 * （AGENTS.md 安全规则 12、13）。缺失必需变量时在启动/请求路径尽早失败并给出
 * 明确变量名，不静默使用空字符串或猜测默认值。
 */

export function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`缺少必需的环境变量: ${name}`);
  }
  return value;
}

export function getOptionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}
