# Stagehand Browser Agent — 设计

## 高影响决策

- **触发条件：** 新增 Stagehand 依赖、浏览器进程、外部网页访问和 Agent 模块。
- **目标与不变量：** 提供有来源的网页研究；PostgreSQL、智能合约和现有测试仍是业务与资金事实源。
- **范围：** 独立 `agents/browser-research`、公开 URL 策略、LangGraph 逐页流、快速协议和只读 QA 命令。
- **非目标：** 登录网站、表单操作、下载、自动搜索、平台状态写入、云端浏览器部署。
- **验证结果：** 真实 DeepSeek 公网提取、运行中 Web 的只读语义冒烟，以及平台任务到 Sepolia 结算的付费闭环均已通过；CI 浏览器兼容性在接入 CI 时再验证。

## 方案选择

### 将 Stagehand 放进 Web E2E 主套件

接入表面简单，但会让固定回归依赖模型输出、外部网络和费用，失败定位也会变差。

### 独立 Browser Agent + 少量只读语义验收（采用）

Stagehand 作为网页执行与理解层，LangGraph 只表达逐页推进和失败隔离；Web 主回归保持确定性。
这一边界让浏览器成本、会话权限和外部失败集中在独立进程内，也可以直接通过现有 Agent
协议上架。

模型边界使用 Stagehand 4.1 官方 `ClientLLM`，由单一适配器完成 Stagehand 消息、工具调用、
工具结果和结构化输出与 DeepSeek OpenAI 兼容接口之间的转换。DeepSeek 的 JSON Object 模式
不直接执行调用方 JSON Schema，因此适配器把 Schema 写入系统提示并解析 JSON，Stagehand
继续用原始 Schema 做最终校验。这样无需修改 Stagehand 包，也不要求第二套模型密钥。

## 数据流

```text
AICP Quick Request
  → 提取明确 URL
  → 协议/端口/主机/DNS 公网校验
  → 独立 Stagehand 本地浏览器 + 域名白名单 + DeepSeek ClientLLM
  → LangGraph 逐页导航与 Zod extract
  → Markdown 报告 + aicp.browser-research.v1 JSON
  → 关闭浏览器
```

单页失败进入报告的 `failures`，不会把供应商原始错误或网页内容写入错误消息。完成响应仍由
SDK 幂等缓存保护。应用层 DNS 检查是第一道边界，线上必须增加网络出站策略作为最终边界。
