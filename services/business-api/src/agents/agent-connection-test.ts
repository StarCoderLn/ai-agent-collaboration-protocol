import { z } from "zod";

const inputSchema = z.object({
  serviceEndpoint: z.string().url().regex(/^https?:\/\//),
  credentialSecret: z.string().max(4_096).optional(),
}).strict();

export type AgentConnectionProbeInput = Readonly<{
  serviceEndpoint: string;
  credentialSecret?: string;
}>;

export type AgentConnectionProbeResult = Readonly<{
  latencyMs: number;
}>;

export interface AgentConnectionProbe {
  probe(input: AgentConnectionProbeInput): Promise<AgentConnectionProbeResult>;
}

export class AgentConnectionTestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * 连接测试只验证上架所需的最小公开契约：同域 `/healthz` 可访问且返回
 * `{ "status": "ok" | "up" }`。它不会发送真实任务，因而不会让一次表单操作
 * 意外触发模型调用或产生提供者费用。
 */
export async function testAgentConnection(
  raw: unknown,
  probe: AgentConnectionProbe,
): Promise<AgentConnectionProbeResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentConnectionTestError(422, "VALIDATION_FAILED", "Agent 执行地址或访问密钥格式不正确", false);
  }
  try {
    return await probe.probe({
      serviceEndpoint: parsed.data.serviceEndpoint,
      ...(parsed.data.credentialSecret === undefined || parsed.data.credentialSecret === ""
        ? {}
        : { credentialSecret: parsed.data.credentialSecret }),
    });
  } catch (cause) {
    if (cause instanceof AgentConnectionTestError) throw cause;
    throw new AgentConnectionTestError(502, "AGENT_CONNECTION_FAILED", "无法连接 Agent，请检查地址后重试", true);
  }
}
