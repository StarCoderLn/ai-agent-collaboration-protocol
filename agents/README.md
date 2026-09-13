# 平台自建 Agent

本目录承载平台自建、可真实执行任务的 Agent。它们用于协议联调、质量评估和演示，不改变第三方 Agent 通过框架无关协议接入平台的边界。

## Agent 接入 SDK

`agent-sdk/` 是 `@aicp/agent-sdk` 的仓库内发布源。它集中实现 AICP v1 验签、Nonce、
并发幂等、Node HTTP 传输、健康检查、正式 `202` 接单和签名结果回调，并提供 Mastra、
LangGraph 可选适配器。`product-workflow/` 复用高级协议能力，图片、PPT 与论文 Agent
复用快速服务外壳；新增独立 Agent 不得复制协议算法或原生 HTTP 服务壳。

普通第三方提供者在产品上架页默认使用“`Agent 执行地址` + 可选`访问密钥`”的快速 HTTP
JSON 方式，不需要安装此 SDK。SDK 面向平台自建 Agent，以及需要异步接单、签名回调、
防重放和自管幂等的高级接入方。完整用法与产物格式见 [`agent-sdk/README.md`](agent-sdk/README.md)。当前 `0.1.x`
作为 workspace package 验证，尚未发布 npm，多实例共享持久化适配器仍是生产发布前置项。

## PRD → 设计 → Coding 十个候选 Agent

`product-workflow/` 提供三类能力。PRD 与设计各有三个候选，Coding 在相同制品契约下
增加一个使用 StateGraph 和 PostgreSQL checkpoint 的 LangGraph 候选：

| 步骤 | DeepSeek 直连 | Mastra 编排 | 自研状态机 | LangGraph |
| --- | --- | --- | --- | --- |
| PRD | `prd-direct` | `prd-mastra` | `prd-state-machine` | — |
| 设计 | `design-direct` | `design-mastra` | `design-state-machine` | — |
| Coding | `code-direct` | `code-mastra` | `code-state-machine` | `code-langgraph` |

直连策略调用一次模型，作为速度与费用基线；Mastra 策略先生成覆盖计划，再生成结构化
制品；自研状态机显式执行分析、生成、评审和最多一次修复。三种策略使用相同 DeepSeek
模型，避免把模型差异错误归因给 Agent 架构。页面默认只执行用户选中的一个候选，不会
为了凑齐多个结果自动产生额外费用。`code-langgraph` 把 TSX 与 CSS 建模为独立节点，
可信校验失败只局部修复一次；基础设施失败后从持久 checkpoint 继续。

三个步骤依次交付 `RequirementsArtifact`、`DesignArtifact` 和 `CodeArtifact`。设计 Agent
只交付结构化 `DesignSpec`；平台可信渲染器根据同一规范生成 1440 桌面端与 390 移动端
SVG 设计稿，作为用户主要验收产物和 Coding Agent 的视觉事实源。Coding Agent 必须同时
继承完整需求、`DesignSpec` 与两张设计稿，再成对生成 `page.tsx + globals.css`。平台只在
无同源、无网络权限的 iframe 中编译预览，不会把 Agent 代码导入平台进程，也不会执行
模型生成的命令。完整契约见
[`docs/workflow-artifacts.md`](../docs/workflow-artifacts.md)。

### 核心代码阅读顺序

1. `product-workflow/src/catalog.ts`：10 个 Agent ID、展示名称和真实策略映射。
2. `product-workflow/src/domain.ts`：三类输入输出 schema、可信字段补齐和原型安全约束。
3. `product-workflow/src/agents/prd/`：三个 PRD Agent 的独立核心实现。
4. `product-workflow/src/agents/design/`：三个设计 Agent 的独立核心实现。
5. `product-workflow/src/agents/coding/`：四个 Coding Agent 的独立核心实现，包括 LangGraph StateGraph。
6. `product-workflow/src/executors.ts`：只按十个稳定 Agent ID 路由，不包含模型策略分支。
7. `product-workflow/src/model-client.ts`：DeepSeek JSON/TSX 客户端与代码安全校验。
8. `agent-sdk/src/`：共用验签、幂等、HTTP、正式接单和结果回传基础设施。
9. `product-workflow/src/formal-dispatch.ts`：工作流特有的制品适配、进度阶段和返工恢复。
10. `product-workflow/src/api.ts`：工作流输入校验、错误分类和执行路由。
11. `product-workflow/src/index.ts`：配置、执行器、API 与 HTTP 服务的组合根。

每个 Agent 的展示名、实现方式和核心文件完整对应表见
[`product-workflow/README.md`](product-workflow/README.md)。

### 本地启动

可以复用论文 Agent 配置文件中的 DeepSeek Key 和 `WORKFLOW_AGENT_SECRET`：

```bash
cd agents
set -a
source paper-writing/.env
set +a
pnpm --filter @aicp/product-workflow-agents dev
```

服务默认监听 `127.0.0.1:9202`。完整体验应使用仓库根目录的 `scripts/local-mvp.mjs`
启动平台、注册 10 个产品工作流 Agent 和网页调研助手，再从任务发布页创建和托管真实任务；任务详情会展示正式
节点、候选、分配、执行与制品。手动单独启动时按 `product-workflow/.env.example` 配置
`WORKFLOW_AGENT_SECRET`，并确保分发引擎注册信息使用同一服务地址和凭据。所有密钥都
只能位于服务端环境变量，变量名不得添加 `NEXT_PUBLIC_`。

当前 `code-langgraph` 已在单个 Coding Agent 内使用 LangGraph StateGraph、条件边和
PostgreSQL checkpoint；它不接管平台任务、托管和结算状态。跨服务的自动准入步骤由
Temporal Workflow 编排，Agent 调用、DeepSeek、数据库和生命周期迁移位于 Activity。
平台多 Agent DAG 仍通过框架无关的 HTTP/AICP 协议交换版本化制品，因此 Mastra、自研
状态机、LangGraph 和其他语言实现可以出现在同一个正式任务中。

## 可上架的独立 Agent

Stagehand Browser Agent 位于 `browser-research/`，默认端口 `9304`。它读取任务中明确给出的
公开 URL，以自然语言提取结构化证据，并交付带来源和失败清单的 Markdown/JSON 报告。
Stagehand 通过官方 `ClientLLM` 接口复用现有 DeepSeek 配置，无需增加另一家模型供应商 Key。
LangGraph 负责逐页推进和单页失败隔离。该 Agent 每次使用独立无登录浏览器，限制为 5 个
域名、20 个页面且默认单并发；不登录、不提交表单、不下载。完整安全边界和运行方式见
[`browser-research/README.md`](browser-research/README.md)。

自然语言页面验收也由该目录提供，但只作为现有确定性测试的补充：`qa:smoke` 对本机
`/tasks` 执行一次 Stagehand `observe()` 与 Schema `extract()`，不会替代 Vitest、Playwright
或资金/DAO 状态断言。2026-09-13 已使用真实 DeepSeek 完成公网研究、运行中 Web 的两项
语义验收，并完成网页调研助手从平台匹配到 Sepolia 结算的付费任务闭环。

### 可手动快速上架的 Mastra Agent

下面三个 Agent 使用独立目录和端口，模型决策均由 Mastra `Agent` 完成；HTTP、Bearer、
幂等和文件下载复用 `@aicp/agent-sdk` 的快速模式。第三方接入不需要安装 SDK。

| 展示名称 | 目录 | 执行地址 | 主要产物 |
| --- | --- | --- | --- |
| 品牌营销图片 Agent | `image-generation/` | `http://127.0.0.1:9301/run` | 1600×900 SVG 图片 |
| 商业演示文稿 Agent | `presentation-generation/` | `http://127.0.0.1:9302/run` | 在线 HTML 预览 + 可编辑 PPTX |
| 学术论文写作 Agent | `paper-writing/` | `http://127.0.0.1:9303/run` | 带真实引用的 Markdown 论文初稿 |

论文目录保留一份已有模型配置；图片与 PPT 的开发命令默认复用其中的 DeepSeek Key，
避免复制密钥。需要覆盖端口、模型或访问密钥时，再在对应目录创建 `.env`。上架页填写
表格中的执行地址；未设置 `AGENT_API_KEY` 时访问密钥留空。“测试连接”只访问同源
`/healthz`，不会触发模型调用或产生费用。

需要一次启动三个待上架 Agent 时，在 `agents/` 目录执行：

```bash
pnpm dev:market-agents
```

## 学术论文写作 Agent 能力说明

### 它能帮你做什么

给它一个论文标题即可开始；详细需求可选。它会先从 OpenAlex 检索真实论文，再由
Mastra Agent 使用配置的 Ollama 或 DeepSeek 模型组织论点，最后交付一份带来源引用、
正文结构和研究限制的 Markdown 论文初稿。

适合用于技术选型调研、课题前期文献摸底、产品研究和快速了解某个学术方向。例如：
“现有研究中，哪些认证、幂等和失败恢复机制适合独立部署的 AI Agent？”

它不承诺自动投稿或学术结论正确。交付物是供用户继续编辑和核查的论文初稿，不代表
同行评审结论，也不能替代人工阅读原论文及遵守所在机构的学术诚信要求。

### 输入与输出

| 类别 | 内容 |
| --- | --- |
| 必填输入 | 论文标题 |
| 可选输入 | 详细关注点和验收要求；内部会把字数、来源数量和年份范围限制在安全区间 |
| 论文正文 | 标题、摘要、至少两个分析章节、结论与研究限制 |
| 证据 | 各章节引用的来源编号，以及论文题目、作者、年份、DOI/链接 |
| 风险说明 | 证据缺失、研究限制和仍需人工确认的内容 |
| 机器可读字段 | schema 版本、任务 ID、生成时间，便于平台后续编排和验收 |

### 一次任务怎样才算成功

- Agent 必须先调用 OpenAlex，不能脱离检索结果直接生成论文。
- 论文至少包含两个非空章节和一条真实引用。
- 每个引用都必须来自本次检索结果；未知或模型编造的来源 ID 会被代码拒绝。
- 输出必须通过版本化 Zod schema 校验，字段缺失或格式错误不会作为成功结果返回。
- 论文必须披露证据不足和不确定性；事实正确性仍需用户通过原论文人工复核。

### 耗时与成本

- DeepSeek：通常比本机 CPU 推理快，按实际输入/输出 token 计费；当前两阶段流程包含一次
  短检索规划和一次报告生成，实测约 25 秒～4 分钟。任务通过一次检索调用、输出 token
  和超时设置限制成本。
- Ollama：没有 API token 费用，但当前电脑仅靠 CPU 时单次模型调用基线为 3～15 分钟；
  两阶段完整任务尚未重新测量，预计会更久。
- 快速入口默认生成约 1,800 字并检索 8 个来源，避免一次测试失控消耗模型费用。

### 当前可用范围

当前版本只保留平台统一的快速上架入口：标题会被转换成有界研究任务，最终结果以
Markdown 论文交付。检索与引用校验已有自动化基线；改为论文写作提示后的真实模型质量
仍需用户授权后单独验收，不能只根据模拟模型测试宣称效果已经通过。

### 名称

- **展示名称：** 学术论文写作 Agent
- **一句话说明：** 输入标题，检索真实论文并生成带引用的 Markdown 论文初稿
- **系统 ID：** `paper-writing-agent`（用于协议路由和配置，不作为市场展示名）

## 技术实现

`paper-writing/` 是项目第一条 Mastra 论文写作纵向切片：

- 通过 `@aicp/agent-sdk` 复用快速 HTTP、Bearer、并发幂等和产物交付边界。
- 使用两个职责分离的 Mastra `Agent`：第一个规划一次检索，第二个只基于冻结证据生成
  Zod Structured Output；支持 Ollama 本地推理和 DeepSeek 云端推理。
- 使用 OpenAlex 检索真实学术元数据与摘要。
- 模型只能引用工具实际返回的 OpenAlex source ID，交付前再次拒绝未知引用。

## 代码阅读顺序

第一次阅读建议按一次真实请求经过系统的顺序看：

1. `../agent-sdk/src/quick-server.ts`：共享 HTTP、Bearer、幂等和错误边界。
2. `src/config.ts`：模型供应商、模型名称与超时配置。
3. `src/domain.ts`：论文任务输入、模型草稿和最终报告的数据契约。
4. `src/mastra-executor.ts`：Mastra 如何调用检索工具并生成结构化论文草稿。
5. `src/openalex.ts`：如何检索、校验和标准化真实论文数据。
6. `src/quick-paper.ts`：如何把平台任务转换为论文任务并渲染 Markdown。
7. `src/index.ts`：如何把配置、执行器与 SDK 快速服务外壳组合起来。

核心数据流是：`请求校验 → 幂等检查 → Mastra 规划一次检索 → OpenAlex 返回并冻结证据 → 无工具 Mastra Agent 生成草稿 → 引用白名单校验 → 返回 Markdown 论文`。

当前是 v0.1 本地接入版本，不是生产部署：快速模式会把幂等结果写入本地 `.local`。
多实例生产发布前需要把快速缓存与文件产物替换成共享数据库和对象存储；本地手动上架
和单实例流程不受该边界影响。

## 本地运行

要求 Node.js 22+、pnpm 11+。模型供应商二选一：

- `ollama`：要求 Ollama 0.32+，并已安装 `gemma4:latest`；零 API 费用但 CPU 较慢。
- `deepseek`：要求有效且有余额的 `DEEPSEEK_API_KEY`；通常更快，但按 token 计费。

```bash
cd agents
nvm use 22
pnpm install --frozen-lockfile
cp paper-writing/.env.example paper-writing/.env
```

### Ollama 本地模式

`.env` 保持以下关键配置：

```dotenv
PAPER_AGENT_PROVIDER=ollama
PAPER_AGENT_MODEL=gemma4:latest
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
```

设置 `.env` 后，在第一个终端启动 Ollama：

```bash
ollama serve
```

在第二个终端启动论文 Agent：

```bash
set -a
source paper-writing/.env
set +a
pnpm --filter @aicp/paper-writing-agent dev
```

服务默认只绑定 `127.0.0.1:9303`，上架时填写 `http://127.0.0.1:9303/run`。
本地 CPU 单次推理基线为 3～15 分钟；Agent 为此使用 6 分钟单步超时、15 分钟模型总超时
和 16 分钟 HTTP 超时。这组值来自 `gemma4:latest` 的旧单阶段调用基线；当前两阶段完整
任务尚未重新测量，因此不能把 3～15 分钟当作端到端完成时间。

### DeepSeek 快速模式

把 `paper-writing/.env` 中的模型配置改为：

```dotenv
PAPER_AGENT_PROVIDER=deepseek
PAPER_AGENT_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=替换成你的服务端密钥
```

DeepSeek 模式不需要启动 Ollama，直接启动论文 Agent 即可。Key 只由 Mastra 的服务端模型
配置读取，不进入公共协议、API 响应或浏览器 bundle。DeepSeek 的 JSON 输出不使用
它未完整支持的严格 `json_schema` 响应格式；Mastra 会内联 JSON 结构提示，返回后仍由同一份
Zod schema 严格校验，因此输出契约不会因切换供应商而放宽。

## 验证

```bash
CI=true pnpm check
CI=true pnpm test
CI=true pnpm build
```

## 已知边界

- OpenAlex 的元数据和摘要可能缺失；Agent 必须在 `limitations` 中披露，不能补写不存在的证据。
- 单次执行调用 OpenAlex 1 次、收集不超过输入的 `sourceCount`，模型输出 token 和总执行时间也有硬上限；这些是成本与失控循环保护，不是质量保证。
- 当前论文是基于公开证据生成的初稿，不代表同行评审结论，也不能替代人工引用核查。
- 开放式报告默认人工验收；结构化 schema 和引用存在性通过不等于研究结论正确。
- Mastra 仅属于 Agent 内部实现。公共请求与响应不得包含 Mastra memory、message 或 workflow 状态。
