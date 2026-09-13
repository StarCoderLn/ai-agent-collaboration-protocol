# 网页调研助手

这是平台内置的“网页调研助手”，底层使用 Stagehand Browser Agent。用户在任务描述或验收标准中给出公开网页 URL，
Agent 使用独立无登录浏览器逐页读取，并交付 Markdown 报告与结构化 JSON。默认执行地址为：

- `http://127.0.0.1:9304/run`

平台上架信息由 `src/catalog.ts` 集中定义：稳定 ID `browser-research`、平台 UUID
`91000000-0000-4000-8000-000000000011`、分类“研究分析”，固定价格 1.5 USDC。

## 能力与边界

- Stagehand 4.1 使用自然语言理解页面，并按 Zod Schema 提取摘要、关键事实和原文摘录。
- 通过 Stagehand 官方 `ClientLLM` 接口复用项目现有 DeepSeek，不需要 OpenAI、Anthropic 或 Google Key。
- LangGraph 显式推进逐页研究；单页失败会记录到报告并继续后续来源。
- 一次最多 20 个页面、5 个域名，只访问任务正文中明确给出的 HTTP(S) URL。
- 每个任务启动独立临时浏览器，默认无 Cookie、禁止下载，并由域名策略限制重定向。
- 拒绝本机、私网、非标准端口和解析到非公网地址的目标。
- 不登录、不填写或提交表单、不购买、不删除，也不把网页内容当成平台指令。

应用层 DNS 检查不能单独解决 DNS 重绑定。线上部署前必须再通过出站代理或网络策略阻止
Browser Agent 访问实例元数据、私网和其他内部服务。

## 输入示例

快速 Agent 协议保持不变，URL 放在任务描述、验收标准或交付格式中：

```json
{
  "task": {
    "id": "research-001",
    "title": "比较两个 Browser Agent 框架的定位",
    "description": "研究 https://docs.stagehand.dev/ 和 https://playwright.dev/ ，给出有来源的差异。"
  }
}
```

请求需携带 8～200 字符的 `Idempotency-Key`。结果包含一份 Markdown 文档和一份
`aicp.browser-research.v1` JSON；每条成功来源保存最终 URL、页面标题和访问时间，失败来源
保存稳定错误码。

## 本地运行

```bash
cd agents
# 默认直接读取 paper-writing/.env 中现有的 DEEPSEEK_* 配置。
pnpm --filter @aicp/browser-research-agent dev
```

启动脚本先读取 `paper-writing/.env`，再读取 Browser Agent 自己的 `.env`。默认使用
`DEEPSEEK_MODEL`（未配置时为 `deepseek-chat`）；`STAGEHAND_DEEPSEEK_MODEL` 可以只覆盖
Browser Agent 的模型。只有需要使用另一套配置时，才从 `.env.example` 创建本目录 `.env`
并填写有效 Key；空的本地 Key 会覆盖共享配置。适配器把 Stagehand 消息、工具和结构化输出转换为 DeepSeek
`/chat/completions` 协议，供应商响应仍会经过运行时校验。当前研究流程关闭截图，若未来启用
视觉输入，需要先选择支持图片的模型并扩展适配契约。

默认只允许一个 Browser 任务同时运行，避免多个 Chromium 会话快速占满本机内存。
真实研究会访问外部网站并产生模型费用；自动化测试使用注入的固定浏览器替身，不联网、
不调用模型。

本机 Anvil 与 Sepolia 启动器会先把“网页调研助手”幂等同步到平台目录，再以 9304 端口启动
服务。同步记录使用平台稳定 UUID，并将调用凭证保存为本机解密器标记；真实共享密钥只在
进程环境中传递。2026-09-13 已在 3011 Agent 市场核对名称、研究分析分类、1.5 USDC 报价与
详情页，并确认 9304 健康接口返回正常；同日完成平台匹配、Sepolia 托管、派发、真实
DeepSeek 执行、Markdown/JSON 交付、人工验收和链上结算闭环。

## 自然语言页面验收

`qa:smoke` 是对现有确定性测试的补充。它只允许本机 AICP 页面，使用 `observe()` 查找
“发布任务”入口，再用 `extract()` 读取页面标题、任务卡数量和入口可见性；不会点击、
连接钱包或提交数据。默认目标跟随当前 Sepolia 演示环境，为
`http://127.0.0.1:3011/tasks`。只有显式设置 `STAGEHAND_QA_URL` 时才检查其他本机实例。

```bash
cd agents
pnpm --filter @aicp/browser-research-agent qa:smoke
```

该命令需要 Web 服务和现有 DeepSeek Key，`observe()` 与 `extract()` 各产生一次真实模型
请求，因此只在单独授权后运行。2026-09-13 的真实验收在当时临时启动的 3001 页面完成：
`observe()` 返回 3 个候选控件，`extract()` 确认发布入口可见；命令退出时 Stagehand 与底层
Chromium 均已释放。此后 QA 默认地址已恢复为当前 Sepolia 演示端口 3011。
