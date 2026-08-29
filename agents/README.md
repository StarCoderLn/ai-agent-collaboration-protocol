# 平台自建 Agent

本目录承载平台自建、可真实执行任务的 Agent。它们用于协议联调、质量评估和演示，不改变第三方 Agent 通过框架无关协议接入平台的边界。

## PRD → 设计 → Coding 九个候选 Agent

`product-workflow/` 提供三类能力，每类恰好三个真实执行策略：

| 步骤 | DeepSeek 直连 | Mastra 编排 | 自研状态机 |
| --- | --- | --- | --- |
| PRD | `prd-direct` | `prd-mastra` | `prd-state-machine` |
| 设计 | `design-direct` | `design-mastra` | `design-state-machine` |
| Coding | `code-direct` | `code-mastra` | `code-state-machine` |

直连策略调用一次模型，作为速度与费用基线；Mastra 策略先生成覆盖计划，再生成结构化
制品；自研状态机显式执行分析、生成、评审和最多一次修复。三种策略使用相同 DeepSeek
模型，避免把模型差异错误归因给 Agent 架构。页面默认只执行用户选中的一个候选，不会
为了凑齐三个结果自动产生三倍费用。

三个步骤依次交付 `RequirementsArtifact`、`DesignArtifact` 和 `CodeArtifact`。设计 Agent
交付受约束的 `page.tsx + globals.css` 可运行原型；Coding Agent 必须继承完整原型、设计
锚点和需求制品，再增量实现交互。平台只在无同源、无网络权限的 iframe 中编译预览，
不会把 Agent 代码导入平台进程，也不会执行模型生成的命令。完整契约见
[`docs/workflow-artifacts.md`](../docs/workflow-artifacts.md)。

### 核心代码阅读顺序

1. `product-workflow/src/catalog.ts`：9 个 Agent ID、展示名称和真实策略映射。
2. `product-workflow/src/domain.ts`：三类输入输出 schema、可信字段补齐和原型安全约束。
3. `product-workflow/src/agents/prd/`：三个 PRD Agent 的独立核心实现。
4. `product-workflow/src/agents/design/`：三个设计 Agent 的独立核心实现。
5. `product-workflow/src/agents/coding/`：三个 Coding Agent 的独立核心实现。
6. `product-workflow/src/executors.ts`：只按九个稳定 Agent ID 路由，不包含模型策略分支。
7. `product-workflow/src/model-client.ts`：DeepSeek JSON/TSX 客户端与代码安全校验。
8. `product-workflow/src/formal-dispatch.ts`：正式接单、进度、结果和返工回调。
9. `product-workflow/src/api.ts`：协议验签、幂等、输入校验、超时和执行路由。
10. `product-workflow/src/index.ts`：配置、执行器、API 与 HTTP 服务的组合根。

每个 Agent 的展示名、实现方式和核心文件完整对应表见
[`product-workflow/README.md`](product-workflow/README.md)。

### 本地启动

可以复用已经配置好的论文 Agent DeepSeek Key 和 HMAC secret，无需读取或复制密钥：

```bash
cd agents
set -a
source evidence-research/.env
set +a
pnpm --filter @aicp/product-workflow-agents dev
```

服务默认监听 `127.0.0.1:9202`。完整体验应使用仓库根目录的 `scripts/local-mvp.mjs`
启动平台、注册 9 个 Agent，再从任务发布页创建和托管真实任务；任务详情会展示正式
节点、候选、分配、执行与制品。手动单独启动时按 `product-workflow/.env.example` 配置
`WORKFLOW_AGENT_SECRET`，并确保分发引擎注册信息使用同一服务地址和凭据。所有密钥都
只能位于服务端环境变量，变量名不得添加 `NEXT_PUBLIC_`。

## 论文调研报告 Agent 能力说明

### 它能帮你做什么

给它一个研究主题和一个具体问题，它会先从 OpenAlex 检索真实论文，再使用配置的
Ollama 或 DeepSeek 模型整理证据，最后交付一份带来源引用和局限性说明的研究综述。

适合用于技术选型调研、课题前期文献摸底、产品研究和快速了解某个学术方向。例如：
“现有研究中，哪些认证、幂等和失败恢复机制适合独立部署的 AI Agent？”

它不是论文代写或自动投稿工具。交付物是便于人继续判断和核查的调研草稿，不代表
同行评审结论，也不能替代人工阅读原论文。

### 输入与输出

| 类别 | 内容 |
| --- | --- |
| 必填输入 | 研究主题、具体研究问题 |
| 可选输入 | 报告语言、目标字数、来源数量、论文年份范围 |
| 报告正文 | 标题、执行摘要、至少两个分析章节 |
| 证据 | 各章节引用的来源编号，以及论文题目、作者、年份、DOI/链接 |
| 风险说明 | 证据缺失、研究限制和仍需人工确认的内容 |
| 机器可读字段 | schema 版本、任务 ID、生成时间，便于平台后续编排和验收 |

### 一次任务怎样才算成功

- Agent 必须先调用 OpenAlex，不能脱离检索结果直接生成报告。
- 报告至少包含两个非空章节和一条真实引用。
- 每个引用都必须来自本次检索结果；未知或模型编造的来源 ID 会被代码拒绝。
- 输出必须通过版本化 Zod schema 校验，字段缺失或格式错误不会作为成功结果返回。
- 报告必须披露证据不足和不确定性；事实正确性仍需用户通过原论文人工复核。

### 耗时与成本

- DeepSeek：通常比本机 CPU 推理快，按实际输入/输出 token 计费；当前两阶段流程包含一次
  短检索规划和一次报告生成，实测约 25 秒～4 分钟。任务通过一次检索调用、输出 token
  和超时设置限制成本。
- Ollama：没有 API token 费用，但当前电脑仅靠 CPU 时单次模型调用基线为 3～15 分钟；
  两阶段完整任务尚未重新测量，预计会更久。
- Agent Lab 进一步把体验任务限制为 500～2,000 字和 3～8 个来源，避免一次测试占用
  过多时间或模型费用。

### 当前可用范围

当前版本可在本机 Agent Lab 中真实完成“协议调用 → 论文检索 → 报告生成 → 引用校验 →
页面展示”的沙箱任务。它仍是 v0.1 技术验证：请求同步执行，nonce 和幂等结果只保存在
内存中，尚未接入生产环境的异步派发、持久任务状态、进度回调、结算和争议流程。
DeepSeek 模式已在 2026-08-22 通过 500 字、3 个来源的真实页面闭环；两阶段 Ollama 模式
尚未重新做完整 CPU 基线验收。

### 名称

- **展示名称：** 论文调研报告 Agent
- **一句话说明：** 检索真实论文，并生成带引用和局限性说明的研究综述
- **系统 ID：** `evidence-research-agent`（用于协议路由和配置，保持稳定，不作为市场展示名）

## 技术实现

`evidence-research/` 是项目第一条 Mastra 纵向切片：

- 独立实现协议 v1.0 的 HMAC-SHA256 验签、时间窗口、nonce 防重放和 `X-Call-Type`。
- 通过 `Idempotency-Key` 防止同一研究请求重复执行。
- 使用两个职责分离的 Mastra `Agent`：第一个规划一次检索，第二个只基于冻结证据生成
  Zod Structured Output；支持 Ollama 本地推理和 DeepSeek 云端推理。
- 使用 OpenAlex 检索真实学术元数据与摘要。
- 模型只能引用工具实际返回的 OpenAlex source ID，交付前再次拒绝未知引用。

## 代码阅读顺序

第一次阅读建议按一次真实请求经过系统的顺序看：

1. `src/example-client.ts`：调用方如何构造任务、签名并发送请求。
2. `src/protocol.ts`：签名基串、时间窗口、nonce 防重放和调用类型。
3. `src/server.ts`：Node HTTP 请求如何转换成框架无关的 API 请求。
4. `src/api.ts`：路由、验签、幂等、输入校验、超时和错误映射。
5. `src/domain.ts`：论文任务输入、模型草稿和最终报告的数据契约。
6. `src/mastra-executor.ts`：Mastra 如何调用检索工具并生成结构化报告。
7. `src/openalex.ts`：如何检索、校验和标准化真实论文数据。
8. `src/index.ts`：如何把配置、执行器、API 和 HTTP 服务组合起来。

核心数据流是：`签名请求 → 协议校验 → 幂等检查 → Mastra 规划一次检索 → OpenAlex 返回并冻结证据 → 无工具 Mastra Agent 生成草稿 → 引用白名单校验 → 返回报告`。

当前是 v0.1 技术验证，不是生产部署：请求同步等待模型完成，nonce 与幂等结果只保存在
内存中，进程重启后丢失。平台的正式派发、节点进度和结果回调契约已经冻结；若要把论文
Agent 升级为正式市场 Agent，应像 `product-workflow` 一样实现该契约并接入持久任务状态，
不能继续复用 Agent Lab 的同步代理作为生产入口。

## 本地运行

要求 Node.js 22+、pnpm 11+。模型供应商二选一：

- `ollama`：要求 Ollama 0.32+，并已安装 `gemma4:latest`；零 API 费用但 CPU 较慢。
- `deepseek`：要求有效且有余额的 `DEEPSEEK_API_KEY`；通常更快，但按 token 计费。

```bash
cd agents
nvm use 22
pnpm install --frozen-lockfile
cp evidence-research/.env.example evidence-research/.env
```

### Ollama 本地模式

`.env` 保持以下关键配置：

```dotenv
EVIDENCE_AGENT_PROVIDER=ollama
EVIDENCE_AGENT_MODEL=gemma4:latest
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
```

设置 `.env` 后，在第一个终端启动 Ollama：

```bash
ollama serve
```

在第二个终端启动论文 Agent：

```bash
set -a
source evidence-research/.env
set +a
pnpm --filter @aicp/evidence-research-agent dev
```

在第三个终端发送带协议签名的沙箱请求：

```bash
set -a
source evidence-research/.env
set +a
pnpm --filter @aicp/evidence-research-agent example
```

服务默认只绑定 `127.0.0.1:9201`。`EVIDENCE_AGENT_SECRET` 不得提交到仓库或写入日志。
本地 CPU 单次推理基线为 3～15 分钟；Agent 为此使用 6 分钟单步超时、15 分钟模型总超时
和 16 分钟 HTTP 超时。这组值来自 `gemma4:latest` 的旧单阶段调用基线；当前两阶段完整
任务尚未重新测量，因此不能把 3～15 分钟当作端到端完成时间。

### DeepSeek 快速模式

把 `evidence-research/.env` 中的模型配置改为：

```dotenv
EVIDENCE_AGENT_PROVIDER=deepseek
EVIDENCE_AGENT_MODEL=deepseek-v4-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=替换成你的服务端密钥
```

DeepSeek 模式不需要启动 Ollama，直接启动论文 Agent 即可。Key 只由 Mastra 的服务端模型
配置读取，不进入公共协议、API 响应或 Agent Lab 浏览器 bundle。DeepSeek 的 JSON 输出不使用
它未完整支持的严格 `json_schema` 响应格式；Mastra 会内联 JSON 结构提示，返回后仍由同一份
Zod schema 严格校验，因此输出契约不会因切换供应商而放宽。

## 在 Agent Lab 页面体验

论文 Agent 启动后，再启动现有 Next.js Web 项目：

```bash
cd ../web
nvm use 22
pnpm --filter web dev
```

浏览器访问 `http://127.0.0.1:3001/agent-lab`。页面通过 Next.js 服务端代理完成 HMAC
签名，浏览器不会收到 `EVIDENCE_AGENT_SECRET`。开发环境中
`web/apps/web/.env.local` 与 `agents/evidence-research/.env` 必须使用相同密钥。

Agent Lab 当前只允许调用 `127.0.0.1`、`localhost` 或 `::1` 的 HTTP Agent 地址，
并把任务限制为 500～2,000 字、3～8 个来源，避免体验任务长时间占满本机 CPU。

## 验证

```bash
CI=true pnpm check
CI=true pnpm test
CI=true pnpm build
```

共享签名测试向量位于 `docs/protocol-test-vectors/signature-v1.json`，Go 协议实现与 TypeScript Agent 都会消费它，防止两种语言的签名基串漂移。

## 已知边界

- OpenAlex 的元数据和摘要可能缺失；Agent 必须在 `limitations` 中披露，不能补写不存在的证据。
- 单次执行调用 OpenAlex 1 次、收集不超过输入的 `sourceCount`，模型输出 token 和总执行时间也有硬上限；这些是成本与失控循环保护，不是质量保证。
- 当前报告是证据综述草稿，不代表同行评审论文，也不能替代人工引用核查。
- 开放式报告默认人工验收；结构化 schema 和引用存在性通过不等于研究结论正确。
- Mastra 仅属于 Agent 内部实现。公共请求与响应不得包含 Mastra memory、message 或 workflow 状态。
