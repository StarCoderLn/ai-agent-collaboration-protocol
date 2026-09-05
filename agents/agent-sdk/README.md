# @aicp/agent-sdk

面向 AICP Agent 提供者的 TypeScript SDK。它同时提供两种明确分离的服务端外壳：快速
HTTP JSON 模式负责 Bearer 鉴权、输入输出校验、幂等和文件产物；高级模式负责 AICP v1
验签、防重放、异步接单和结果回调。Agent 只需要实现自己的业务执行函数。

> 当前版本先作为仓库内 workspace package 使用和验证，尚未发布到 npm registry。
> 普通上架默认使用快速 HTTP JSON，不要求安装本 SDK；只有需要 AICP HMAC 异步能力时才使用本方案。

## 仓库内快速模式

图片、PPT 和论文三个 Mastra 示例 Agent 使用 `createQuickAgentServer` 复用平台快速接入
契约。它是仓库自建服务的便捷实现，不是第三方上架的前置依赖：第三方仍可直接实现
`GET /healthz` 和 `POST /run`。

快速模式会把幂等响应写入 `.local/responses`，把 SVG、PPTX 等文件写入
`.local/artifacts`。同一 `Idempotency-Key` 只能对应同一请求体；重复请求重放原结果，
不同请求体返回 409。模型和 Mastra 配置不属于 SDK，由具体 Agent 自己管理。

## SDK 接入

```ts
import { serveAgent } from "@aicp/agent-sdk";
import { myAgent } from "./my-agent.js";

serveAgent(async ({ task, upstreamArtifacts }) =>
  myAgent.run({ task, context: upstreamArtifacts }),
);
```

启动前设置：

```bash
export AICP_HMAC_SECRET="与上架表单一致的共享密钥"
export AICP_AGENT_ID="上架成功后平台返回的 Agent UUID"
export PORT="8787"
```

把 `https://your-domain.example/v1/agent` 填入上架表单。SDK 在专用 Agent 服务中接受
任意正式 POST 路径，并自动提供签名保护的 `/healthz`；平台向正式地址追加 `/webhook`
投递返工事件。

## 产物格式

执行函数返回字符串时，SDK 自动创建 Markdown 产物；返回普通对象时自动创建 JSON
产物。图片、视频和文件应显式返回文件产物：

```ts
return {
  kind: "file",
  summary: "首页设计稿",
  mimeType: "image/png",
  storageRef: "https://cdn.example/design.png",
  sizeBytes: "248120",
};
```

## Mastra 与 LangGraph

```ts
import { serveAgent } from "@aicp/agent-sdk";
import { fromMastra } from "@aicp/agent-sdk/mastra";

serveAgent(fromMastra(myMastraAgent));
```

```ts
import { serveAgent } from "@aicp/agent-sdk";
import { fromLangGraph } from "@aicp/agent-sdk/langgraph";

serveAgent(fromLangGraph(compiledGraph));
```

两个适配器采用结构类型，不会要求通用 SDK 用户安装 Mastra 或 LangGraph。

## 持久化边界

`0.1.x` 的 Nonce、派发幂等与返工事件去重使用进程内存，适用于本地开发和单实例体验。
生产多实例发布前需要实现共享持久化适配器；在此之前 SDK 不应被标记为生产稳定版。
平台回调本身始终使用稳定幂等键，网络重试不会因为更换键而重复写入平台结果。
