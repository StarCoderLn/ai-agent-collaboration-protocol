import { createAgentHttpServer } from "@aicp/agent-sdk";
import type { WorkflowApi } from "./api.js";

/**
 * 工作流服务只保留自己的组合名称；原始 body、请求头归一化、上传上限和安全错误响应
 * 已由 SDK 的 Node HTTP 适配器统一处理。
 */
export function createWorkflowServer(api: WorkflowApi) {
  return createAgentHttpServer((request) => api.handle(request), {
    maxBodyBytes: 4 << 20,
    bodyTooLargeMessage: "body too large",
    internalErrorMessage: "internal error",
  });
}
