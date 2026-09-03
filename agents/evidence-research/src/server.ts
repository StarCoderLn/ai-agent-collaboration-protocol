import { createAgentHttpServer, listeningAddress } from "@aicp/agent-sdk";
import type { ResearchApi } from "./api.js";

/**
 * 论文 Agent 的 HTTP 外壳复用 SDK，业务 API 仍负责自己的同步研究输入和模型执行。
 * 自定义错误文本保持旧接口可观察行为不变，避免重构意外改变既有调用方判断。
 */
export function createResearchServer(api: ResearchApi) {
  return createAgentHttpServer((request) => api.handle(request), {
    maxBodyBytes: 1 << 20,
    bodyTooLargeMessage: "request body exceeds 1 MiB limit",
    internalErrorMessage: "internal server error",
  });
}

export { listeningAddress };
