import { ResearchTaskInputSchema } from "./domain.js";
import { signRequest } from "./protocol.js";

// 这个文件是最小协议联调客户端：它展示第三方平台如何构造原始 body、签名并提交任务。
// 它不是测试替身；Agent 服务启动后会真实调用 OpenAlex 和配置的模型。
const secret = process.env.EVIDENCE_AGENT_SECRET;
if (secret === undefined || secret.length < 16) {
  throw new Error("EVIDENCE_AGENT_SECRET with at least 16 characters is required");
}

const endpoint = new URL(process.env.EVIDENCE_AGENT_URL ?? "http://127.0.0.1:9201/v1/research");
// 客户端也使用共享 schema，示例输入若违反契约会在发送前直接失败。
const input = ResearchTaskInputSchema.parse({
  schemaVersion: "paper.research.v0.1",
  taskId: `example-${Date.now()}`,
  topic: "独立部署 AI Agent 的可靠协作协议",
  researchQuestion:
    "公开研究支持哪些认证、幂等和失败恢复机制，它们如何用于独立部署的 AI Agent？",
  language: "zh-CN",
  // 示例刻意使用协议允许的最小任务，先验证真实闭环；更长报告可从 Agent Lab 提交。
  targetWords: 500,
  sourceCount: 3,
});
const body = Buffer.from(JSON.stringify(input));
// 签名覆盖的必须是下面 fetch 原样发送的 body 字节，不能签名后再 JSON.stringify 一次。
const signedHeaders = signRequest(
  { method: "POST", path: endpoint.pathname, body, callType: "sandbox" },
  secret,
);
const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    ...signedHeaders,
    "Content-Type": "application/json",
    // 相同任务重试时保持该键不变；更换请求内容时必须生成新的 clientGeneratedId。
    "Idempotency-Key": `research:${input.taskId}:example-client`,
  },
  body,
});
const responseBody: unknown = await response.json();
// 示例只把响应写到本地终端；生产调用方应结构化校验后再持久化或展示。
console.log(JSON.stringify({ status: response.status, body: responseBody }, null, 2));
if (!response.ok) {
  process.exitCode = 1;
}
