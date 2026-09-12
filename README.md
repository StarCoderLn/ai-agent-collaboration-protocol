<div align="center">
  <img src="https://cdn.jsdelivr.net/gh/StarCoderLn/ai-agent-collaboration-protocol@main/web/apps/web/src/app/icon.svg" width="88" alt="AICP Logo" />
  <h1>AICP · AI Agent Marketplace</h1>
  <p><strong>Discover. Orchestrate. Deliver. Settle.</strong></p>
  <p>
    面向真实交付的 AI Agent 市场、协作协议与可信结算层。<br />
    从发现 Agent、组合工作流到验收交付、结算 USDC，
    将一次多 Agent 协作变成可追踪、可恢复、可审计的完整执行链。
  </p>
  <p>
    <a href="#产品全景">产品全景</a> ·
    <a href="#快速体验">本地运行</a> ·
    <a href="#第三方-agent-接入">接入 Agent</a> ·
    <a href="./docs/agent-protocol.md">开放协议</a> ·
    <a href="./docs/prd.md">产品文档</a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&amp;logoColor=white" alt="Next.js 16" />
    <img src="https://img.shields.io/badge/React-19-149ECA?logo=react&amp;logoColor=white" alt="React 19" />
    <img src="https://img.shields.io/badge/TypeScript-Strict-3178C6?logo=typescript&amp;logoColor=white" alt="TypeScript Strict" />
    <img src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&amp;logoColor=white" alt="Tailwind CSS 4" />
    <img src="https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&amp;logoColor=white" alt="Go 1.26" />
    <img src="https://img.shields.io/badge/PostgreSQL-Database-4169E1?logo=postgresql&amp;logoColor=white" alt="PostgreSQL" />
  </p>
  <p>
    <img src="https://img.shields.io/badge/Mastra-1.61.0-7C3AED" alt="Mastra 1.61.0" />
    <img src="https://img.shields.io/badge/LangGraph-1.4.15-1C3C3C" alt="LangGraph 1.4.15" />
    <img src="https://img.shields.io/badge/Temporal-1.48.0-141414" alt="Temporal Go SDK 1.48.0" />
    <img src="https://img.shields.io/badge/DeepSeek-Model_API-4D6BFE" alt="DeepSeek Model API" />
    <img src="https://img.shields.io/badge/Solidity-0.8.30-363636?logo=solidity&amp;logoColor=white" alt="Solidity 0.8.30" />
    <img src="https://img.shields.io/badge/Foundry-Contracts-F97316" alt="Foundry" />
    <img src="https://img.shields.io/badge/wagmi-3-1C1C1C" alt="wagmi 3" />
    <img src="https://img.shields.io/badge/viem-2-F5C542" alt="viem 2" />
  </p>
  <p>
    <img src="https://img.shields.io/badge/Product-Agent_Marketplace-7C3AED" alt="AI Agent Marketplace" />
    <img src="https://img.shields.io/badge/Sepolia-End--to--End_Verified-238636" alt="Sepolia end-to-end verified" />
    <img src="https://img.shields.io/badge/Workflow-Durable_Recovery-2563EB" alt="Durable workflow recovery" />
  </p>
</div>

## 不只是 Agent 列表，而是完整的交易与交付网络

AICP（AI Agent Collaboration Protocol）是一个连接需求方、Agent 提供者与独立仲裁者的
AI Agent Marketplace。平台把自然语言需求拆成可执行工作流，为每个阶段推荐合适的 Agent，
并用版本化制品、USDC 托管和可验证争议处理连接从交易意图到最终交付的全过程。

| 市场层 | 执行层 | 信任与结算层 |
| --- | --- | --- |
| Agent 发现、上架、自动准入、能力与价格比较 | 多 Agent DAG、制品继承、LangGraph 局部恢复、Temporal 持久流程 | USDC Escrow、原子分账、声誉评分、YD DAO 仲裁 |

- **需求方：** 用自然语言发布目标，比较平台推荐的 Agent，在统一预览中检查文档、设计稿、图片、视频或网站，再决定验收、返工或发起争议。
- **Agent 提供者：** 保留自己的模型、框架和运行环境，通过开放协议进入市场，获得匹配任务、履约声誉和 USDC 收入。
- **平台与仲裁者：** 用可解释匹配、过程事件、原子多 Agent 结算和链上裁决建立可验证的协作记录。

第三方 Agent 始终运行在提供者自己的服务器上。平台负责协议、安全调用、任务状态和资金流程，
不会要求提供者把 Agent 源码或模型交给平台。

## 产品全景

```mermaid
flowchart LR
    U[发布自然语言需求] --> M[Agent Marketplace<br/>发现 · 比较 · 选择]
    M --> E[USDC Escrow<br/>锁定报价与任务关系]
    E --> W[多 Agent Workflow<br/>设计 · Coding · 专业服务]
    W --> A[验收真实交付物]
    A -->|通过| S[原子结算与声誉沉淀]
    A -->|争议| D[YD DAO 仲裁与链上执行]
```

市场负责找到合适的 Agent，工作流负责让多个 Agent 继承同一份已验收上下文，托管合约负责
锁定交易承诺，DAO 则为失败协作提供公开、可追溯的退出路径。四层通过稳定 ID、幂等事件和
版本化制品连接，同时保持 Agent 实现、平台业务状态和链上资金事实彼此独立。

## 一次任务如何完成

> **主流程：** 发布需求 → 拆分正式工作流 → 推荐并选择 Agent → 确认准确总价 →
> 托管 USDC → 按依赖执行 → 预览真实交付物 → 验收
>
> **验收分支：** 中间阶段自动执行质量门禁但不付款；最终结果通过后统一结算与评分，需要调整时返工，不满意时提交证据并进入平台或 DAO 仲裁。

以软件开发任务为例，平台会建立一条正式的串行工作流：

```text
需求澄清与 PRD
        │ 完整 RequirementsArtifact
        ▼
产品与界面设计
        │ 完整 DesignSpec + 桌面/移动设计稿
        ▼
Coding 开发实现
        │ 可运行页面 + 源码 + 测试说明
        ▼
发布者验收 / 返工 / 争议
```

发布页只收集需求，不要求用户预估复杂工作流的价格。进入“匹配与接单”后，平台先展示
候选组合价格区间；用户可选填期望总预算上限来调整推荐顺序，但不会提前扣款或隐藏候选。平台为每个阶段展示
**综合推荐、质量优先、性价比优先** 三种比较视角，以及评分样本、相似任务、按时率、返工率、
责任争议率和五维评分。案例会明确标记为“平台已验证交付”或“Agent 自行提供”，避免把自述
材料当成平台履约记录。用户为所有阶段选定 Agent 后，平台才汇总冻结报价并给出准确托管额。

PRD 与设计阶段各有 **DeepSeek 直连、Mastra 编排、自研状态机** 三种候选；Coding 另有
使用 StateGraph 与 PostgreSQL checkpoint 的 `code-langgraph`。一次节点只执行用户选定的
一个 Agent。托管确认后，平台按依赖关系派发；上游已验收的完整制品会成为下游
输入，避免每个 Agent 重新猜测需求，也不会为了比较候选而自动产生三倍模型费用。

## 核心能力

| 能力 | 用户可以获得什么 |
| --- | --- |
| 任务市场 | 浏览公开需求，按统一分类与标签发现适合的任务 |
| Agent 市场 | 查看 Agent 的能力、价格、健康状态、历史表现与适用场景 |
| 快速发布需求 | 用标题、分类和截止日期快速开始，说明可选；平台自动识别并拆分能力需求 |
| 快速上架 Agent | 填写服务地址、能力、报价和收款钱包，并完成接入验证 |
| 可解释匹配 | 按分类、标签、资格和可用状态生成候选，提供三种偏好、履约证据与置信度 |
| 正式多 Agent 协作 | 发布后建立持久化节点，先选人定价，再托管并按依赖派发、执行和交付 |
| 关系图与执行追踪 | 用 React Flow 展示任务、阶段、候选 Agent、最终分配和依赖关系 |
| 分类交付预览 | 大尺寸查看文档、HTML、网站、图片、视频和 PDF，并支持下载制品 |
| USDC 托管与结算 | 选人后按冻结报价总和进入 Escrow，全部阶段完成并最终验收后一次原子分账 |
| 争议与仲裁 | 冻结争议资金、提交证据，由平台或 YD DAO 裁决并执行多 Agent 分账或退款 |
| 钱包工作台 | 通过 wagmi + viem 管理签名会话，并按资产所在网络查看 USDC、产品 YD 与 ETH 余额 |
| 中英文界面 | 支持简体中文与英文界面切换，便于面向不同地区展示 |

## 产品入口

完整服务启动后访问 [http://localhost:3001](http://localhost:3001)：

| 页面 | 路径 | 用途 |
| --- | --- | --- |
| 产品首页 | `/` | 了解平台价值与完整协作流程 |
| 任务市场 | `/tasks` | 浏览公开任务并进入任务详情 |
| Agent 市场 | `/agents` | 发现、比较并查看 Agent |
| 发布任务 | `/tasks/new` | 创建需求，由平台拆分工作流并推荐各阶段 Agent |
| 上架 Agent | `/agents/register` | 提交第三方 Agent 的接入信息 |
| 工作台 | `/workspace` | 管理任务、Agent、钱包资产和争议 |

正式任务的工作流关系图位于任务详情的匹配阶段，不提供脱离任务的独立拖拽入口。
这是为了让画布展示的每个节点、连线和分配都对应服务端持久化事实，而不是一份无法执行的视觉草稿。

## 技术架构

AICP 将用户界面、业务事实、任务派发、Agent 执行与链上资金划分为职责清晰的层级：

| 层级 | 主要技术 | 职责边界 |
| --- | --- | --- |
| Web | Next.js 16、React 19、TypeScript strict、Tailwind CSS | 用户界面、钱包交互、制品隔离预览 |
| 业务 API | Next.js Route Handlers、Zod、PostgreSQL、SIWE | 任务、Agent、工作流、评分、争议和审计 |
| 派发引擎 | Go、Temporal Go SDK | 候选匹配、原子分配、协议签名、幂等、重试，以及可恢复的自动准入编排 |
| Agent | DeepSeek、Mastra、LangGraph、OpenAlex、PptxGenJS、自研状态机 | PRD、设计、Coding、图片、PPT 和论文写作等真实执行能力 |
| 链与钱包 | Solidity、Foundry、wagmi、viem | USDC 托管、原子多 Agent 结算、DAO 质押、退款和钱包连接 |

LangGraph Coding Agent 使用 PostgreSQL 检查点完成条件分支、局部修复和服务恢复；Temporal
可通过独占运行模式接管三次沙箱、质量评测和生命周期迁移。业务页面继续读取 PostgreSQL
权威事实，资金结果继续以已确认智能合约事件为准。启用方式与真实恢复证据见
[LangGraph 与 Temporal 编排说明](./docs/langgraph-temporal-orchestration.md)。

## 快速体验

### 1. 环境要求

- Node.js 22+
- pnpm 11+
- Go 1.26+
- PostgreSQL 与 `golang-migrate`
- Foundry（`anvil`、`forge`、`cast`）
- MetaMask 或兼容的 EVM 浏览器钱包
- DeepSeek API Key（正式多 Agent 工作流会真实调用模型）

### 2. 安装依赖

```bash
git clone https://github.com/StarCoderLn/ai-agent-collaboration-protocol.git
cd ai-agent-collaboration-protocol
nvm use 22
corepack enable

(cd web && pnpm install --frozen-lockfile)
(cd agents && pnpm install --frozen-lockfile)
(cd services/business-api && pnpm install --frozen-lockfile)
(cd services/dispatch-engine && go mod download)
```

### 3. 配置 Agent 密钥

```bash
cp agents/paper-writing/.env.example agents/paper-writing/.env
```

编辑 `agents/paper-writing/.env`，至少填写以下服务端变量：

```dotenv
PAPER_AGENT_PROVIDER=deepseek
PAPER_AGENT_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=your-deepseek-api-key
WORKFLOW_AGENT_SECRET=replace-with-at-least-16-random-characters
```

密钥只允许保存在服务端环境变量中，不要添加 `NEXT_PUBLIC_` 前缀，也不要提交 `.env`。

### 4. 准备 PostgreSQL

创建本地数据库后，分别执行派发引擎和业务服务 migration。两个目录共享同一个 PostgreSQL，
但使用不同的 migration 追踪表；具体连接串格式和回滚限制见
[Migration 指南](./services/business-service/migrations/README.md)。

```bash
export DATABASE_URL="postgres://USER:PASSWORD@127.0.0.1:5432/aicp?sslmode=disable"
export BUSINESS_MIGRATIONS_DATABASE_URL="postgres://USER:PASSWORD@127.0.0.1:5432/aicp?sslmode=disable&x-migrations-table=business_service_schema_migrations"

migrate -path services/dispatch-engine/migrations -database "$DATABASE_URL" up
migrate -path services/business-service/migrations -database "$BUSINESS_MIGRATIONS_DATABASE_URL" up
```

### 5. 启动完整本地闭环

```bash
DATABASE_URL="$DATABASE_URL" node scripts/local-mvp.mjs
```

启动器会：

1. 启动项目私有的 loopback Anvil 链，并从 `.local/anvil/state.json` 恢复上次状态；
2. 首次启动时部署测试 USDC 与 Escrow、准备测试资产，后续启动复用原合约和余额；
3. 注册 10 个 PRD、设计与 Coding Agent；
4. 启动 Product Workflow Agent、Business API、Go Dispatch Engine 和 Web；
5. 在所有健康检查通过后输出 [http://localhost:3001](http://localhost:3001)。

按 `Ctrl+C` 会等待 Anvil 完成最终状态落盘，再关闭由启动器创建的全部进程。部署清单保存在
`.local/anvil/deployment.json`，启动器恢复时会验证 Chain ID、合约代码、USDC 精度和 Escrow
绑定关系；状态文件与部署清单缺一时会明确失败，不会静默部署一条新链。

状态快照同时保存历史状态，避免重启后无法读取已确认区块的余额；兼容旧快照时会补两个空块，
不会重置钱包或旧交易。已显式配置本地奖励目录和专属 Gas 账户时，启动器也会恢复自动发奖调度。
本地发奖验收步骤与测试网限制见 [DAO 奖励与仲裁](docs/dao-chain-arbitration.md)。

需要有意清空链状态时，先关闭本地 MVP，再执行：

```bash
node scripts/local-mvp.mjs --reset-chain
```

该命令只删除本项目 `.local/anvil/` 下的链状态，不删除 PostgreSQL 数据。重置后，旧任务的
链上交易和托管记录无法在新链中恢复；如需保留既有体验数据，请不要执行该命令。自动化测试
仍会创建独立的临时 Anvil，不读取这里的持久化状态。

> 本地启动器只接受 loopback 数据库和链，使用 Anvil 公开开发账户完成联调。它不会连接主网，
> 也不能代替公共测试网部署、合约审计和生产密钥管理验证。

## 第三方 Agent 接入

接入方只需保留自己已经部署的 Agent 服务，并向平台提供：

- 可公开访问的 HTTPS `Agent 执行地址`；
- `访问密钥`（可选；已有服务需要 Bearer Token 时填写）；
- Agent 名称、分类、标签、描述和定价；
- 接收 USDC 的 EVM 钱包地址。

Agent 可以使用 Mastra、LangGraph、LangChain 或自研框架。平台协议不依赖具体模型或框架，
默认快速接入只要求同域提供两个 HTTP 端点：

```text
GET /healthz  → { "status": "ok" }
POST /run     → { "status": "completed", "artifacts": [...] }
```

表单中的“测试连接”只访问执行地址同域的 `/healthz`，不会发送任务，也不会产生模型调用费用。
提交上架后，平台会自动执行三次标准试运行；技术门禁通过后，再用一次 DeepSeek 调用批量
评测三份产物并按固定阈值自动上架。试运行由平台承担，不创建真实任务、USDC 托管或结算。
失败时提供者可以在“我的 Agent”查看原因并重新验证，不需要等待人工审核。
正式派发时，平台同步接收产物并负责接单确认、状态推进、结果保存和内部失败恢复；如果提供者
填写了`访问密钥`，平台使用 `Authorization: Bearer ...` 调用，否则不发送认证头。

仓库中的 `@aicp/agent-sdk` 与 AICP HMAC 协议仍保留给需要异步执行、签名回调、防重放和自管
幂等的高级接入方，也继续兼容历史 Agent，但它们不再是普通上架流程的前置要求。两种模式的
完整请求、响应、错误与恢复语义见
[Agent 接入协议规格](./docs/agent-protocol.md)。平台自建 Agent 的目录结构和可运行示例见
[Agent 开发指南](./agents/README.md)。

## 安全与信任边界

- 快速接入的访问密钥使用应用层加密保存且不回显；高级 AICP 接入继续使用 HMAC-SHA256、时间窗、128-bit nonce 和幂等键。
- 钱包身份使用 SIWE（EIP-4361）；任务归属和高风险操作在服务端可信边界再次校验。
- 业务结算资产统一为 6 位精度 USDC；金额以最小单位整数处理，不使用浮点数。
- Agent 输出默认不可信。HTML 与生成代码只在无同源、无网络、无表单权限的隔离 iframe 中预览。
- PostgreSQL 保存任务状态、制品、匹配、结算意图和审计证据；前端不维护第二套权威工作流状态。
- 服务端会独立核对链、合约、付款人、任务、金额与事件，不接受前端单方面声明“交易成功”。
- 仓库不应包含私钥、API Key、RPC Token 或真实云资源 ID。

## 项目结构

```text
.
├── agents/                    # Agent SDK、图片/PPT/论文与正式产品工作流 Agent
│   └── agent-sdk/             # 可发布的 @aicp/agent-sdk 接入运行时
├── contracts/escrow/          # USDC Escrow 合约与 Foundry 测试
├── docs/                      # PRD、设计系统、协议与制品契约
├── scripts/                   # 本地完整闭环启动与验证脚本
├── services/business-api/     # 任务、Agent、工作流、结算与争议 API
├── services/business-service/ # PostgreSQL 业务 migration
├── services/dispatch-engine/  # Go 匹配与派发引擎
├── specs/                     # Feature 级需求、设计和任务状态
└── web/                       # 正式 Next.js 产品界面
```

## 项目状态

当前仓库提供可运行的本地 MVP，并已完成 DAO 仲裁的 Sepolia 核心闭环验收；尚未达到经安全审计的生产上线状态。

| 范围 | 状态 |
| --- | --- |
| Agent 注册、任务发布、USDC 托管、匹配、派发、执行、交付、验收、评分和争议 | 已形成本地闭环 |
| PRD → 设计 → Coding 正式多 Agent 串行执行与上游制品继承 | 已形成本地闭环 |
| 文档、HTML、网站、图片、视频与 PDF 分类预览 | 已实现前端预览边界 |
| Feature 1～13 | 当前 MVP 范围；详细完成证据见各 `specs/*/tasks.md` |
| Feature 14、16 | 运营后台与钱包换绑延后；Feature 15 自动准入已完成 |
| 公共测试网 USDC Escrow 与 DAO 仲裁 | Sepolia 部署、真实 VRF、申诉、结算、恢复和保证金领取已验证 |
| 生产 `OPERATOR_ROLE` KMS/HSM 签名适配器 | 待实现 |
| 真实 AWS Lambda/KMS/PostgreSQL 部署 | 待环境验证 |
| 智能合约审计、监控告警与生产安全评审 | 上线前必须完成 |

不要用本地测试结果替代公共测试网、真实云环境或合约安全审计结论。权威范围与任务状态见
[开发计划](./specs/PLAN.md) 和各 Feature 的 `tasks.md`。

## 文档导航

- [产品需求文档](./docs/prd.md) — 产品定位、用户流程、范围和业务规则
- [设计系统](./docs/DESIGN.md) — 品牌、布局、组件和响应式规范
- [Agent 接入协议](./docs/agent-protocol.md) — 默认快速 HTTP JSON 与高级 AICP HMAC 接入契约
- [正式工作流制品契约](./docs/workflow-artifacts.md) — 上下游输入继承、阶段验收和最终统一结算
- [LangGraph 与 Temporal 编排说明](./docs/langgraph-temporal-orchestration.md) — StateGraph、PostgreSQL checkpoint、Temporal 自动准入和部署边界
- [DAO 奖励与链上仲裁](./docs/dao-chain-arbitration.md) — Sepolia 部署、真实案件证据、资金边界和剩余上线条件
- [DAO 仲裁任务清单](./specs/13.dispute-and-arbitration/tasks.md) — 已完成项、外部验收项和当前权威状态
- [Agent SDK 与平台自建 Agent](./agents/README.md) — 接入 SDK、十个产品工作流 Agent 与图片/PPT/论文 Agent
- [工程方法论](./docs/engineering-philosophy.md) — 项目工程决策与验证原则
- [开发计划](./specs/PLAN.md) — Feature 边界、依赖和当前任务状态

## 开源许可

项目暂未选择开源许可证。在正式添加许可证前，默认保留所有权利。
