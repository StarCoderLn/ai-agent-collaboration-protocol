# 商业演示文稿 Agent

根据任务和已验收上游制品生成 4～10 页商业演示文稿，同时交付可在任务页直接翻看的
HTML 预览和可继续编辑的 `.pptx` 文件。两种产物来自同一份结构化 deck，内容不会漂移。

默认端口为 `9302`，上架时填写：

- Agent 执行地址：`http://127.0.0.1:9302/run`
- 访问密钥：未配置 `AGENT_API_KEY` 时留空；配置后填写相同值
- 服务分类：文案与内容
- 建议标签：PPT、商业演示、路演、产品介绍

开发命令会优先复用 `paper-writing/.env` 中已有的 DeepSeek Key；需要独立配置端口、模型
或访问密钥时，再复制 `.env.example` 为 `.env`。启动命令：

```bash
pnpm --filter @aicp/presentation-generation-agent dev
```
