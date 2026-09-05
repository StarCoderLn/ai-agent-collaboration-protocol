# 学术论文写作 Agent

输入论文标题即可开始。Agent 使用 Mastra 规划检索，通过 OpenAlex 获取真实论文，再基于
冻结的证据生成 Markdown 论文初稿。模型引用的每个来源 ID 都会经过白名单校验，未知或
编造引用不会作为成功结果返回。

## 快速上架

复制 `.env.example` 为 `.env`，配置 Ollama 或 DeepSeek，然后执行：

```bash
pnpm --filter @aicp/paper-writing-agent dev
```

在平台填写：

- Agent 执行地址：`http://127.0.0.1:9303/run`
- 访问密钥：未配置 `AGENT_API_KEY` 时留空；配置后填写相同值
- 服务分类：研究与报告
- 建议标签：论文写作、OpenAlex、文献检索、引用校验

快速入口只要求任务标题，默认生成约 1,800 字并检索 8 个来源；详细需求和验收标准会
作为可选研究重点。交付物是用户可直接阅读的 Markdown，不会暴露内部结构化数据。

## 代码职责

- `src/mastra-executor.ts`：规划检索并基于冻结证据生成结构化论文。
- `src/openalex.ts`：检索、校验并标准化真实论文数据。
- `src/quick-paper.ts`：把平台任务转换为论文任务，并将结果渲染为 Markdown。
- `src/index.ts`：连接模型执行器与 `@aicp/agent-sdk` 快速服务外壳。

HTTP、Bearer、幂等缓存、请求限制和错误响应统一由 `@aicp/agent-sdk` 处理，本目录不再
维护独立协议入口。事实正确性和研究结论仍需用户回到原始论文人工核查。
