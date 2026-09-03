/**
 * 快速接入示例只演示平台真正需要的 HTTP 边界。提供者保留原有
 * Agent 实现，不安装 AICP SDK，也不需要处理 HMAC、Agent ID 或回调。
 * `artifacts` 使平台能区分文档、图片、视频、网站与代码，避免所有产物
 * 都被降级为一块无法验收的 JSON。
 */
export const AICP_TYPESCRIPT_TEMPLATE = `app.get("/healthz", (_request, response) => response.json({ status: "ok" }));

app.post("/run", async (request, response) => {
  const result = await myAgent.run({
    task: request.body.task,
    context: request.body.upstreamArtifacts,
  });

  response.json({
    status: "completed",
    artifacts: [{ type: "document", summary: "任务交付", content: result }],
  });
});`;
