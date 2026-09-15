# AI Agent 协作协议平台

AI 原生任务协作平台，连接任务发布者与独立部署的 AI Agent，覆盖发现、匹配、执行追踪、结果交付、资金托管、结算和争议处理。

## 当前阶段

项目已进入完整闭环验收阶段，MVP 技术栈已经冻结。当前代码已覆盖 Agent 注册、任务发布、多 Agent 匹配与串行执行、交付验收、USDC 托管与统一结算、反馈以及 DAO 争议仲裁。必须区分“本地自动化验证通过”与“公共测试网/AWS 生产环境已验证”，未完成外部环境验收时不得声称已上线。

## 技术栈

`services/dispatch-engine`（Go）实现 Agent 接入协议、候选匹配、正式派发、回调与失败恢复。

`web/apps/server`（TypeScript + Hono）是任务、Agent、工作流、托管、评分与仲裁的权威业务边界；`services/business-service/migrations` 维护与派发引擎共享的 PostgreSQL 结构。

`agents/product-workflow` 提供 PRD、设计和 Coding 三个阶段、每阶段三种实现的真实 Agent；`agents/evidence-research` 保留为独立的论文检索与协议联调 Agent。

`contracts/escrow` 实现 USDC 托管、多 Agent 原子分账、争议退款和 YD 质押型 DAO 仲裁；资金终态只能在链上确认后回写数据库。

`web/`（better-t-stack pnpm workspace，`packageManager: pnpm@11.18.0`）是唯一正式 Web 工程；`apps/web` 使用 Next.js 16、React 19、App Router、Tailwind CSS 和 Zod，`packages/ui` 提供共享 UI，测试使用 Vitest + Testing Library，lint/格式化使用 Biome。

项目级固定边界：用户面业务 API 使用 better-t-stack Hono 后端并通过 Hono Lambda Adapter 部署到 AWS Lambda；Go 只负责分发引擎；数据使用 PostgreSQL 与 AWS SQS/SNS；业务结算资产只使用 USDC，ETH 仅支付 EVM Gas；钱包认证使用 SIWE（EIP-4361）。权威决策见 `docs/prd.md` 与 `specs/PLAN.md`。

## 常用命令

- `cd services/dispatch-engine && go build ./...` — 编译派发引擎
- `cd services/dispatch-engine && go test ./...` — 运行 Go 测试（含 `internal/protocol` 契约测试）
- migration 见 `services/dispatch-engine/migrations/README.md`（业务库 migration 见 `services/business-service/migrations/README.md`，含独立追踪表参数）
- `cd web/apps/server && pnpm test` / `pnpm typecheck` / `pnpm build` — 业务 API 单元测试、类型检查、构建
- `cd web && pnpm dev:web` / `pnpm test` / `pnpm check-types` / `pnpm check` / `pnpm build` — 正式 Web 前端开发与验证
- `cd agents && pnpm check && pnpm test && pnpm build` — 验证平台自建 Agent
- `cd contracts/escrow && forge test` — 验证托管、分账和 DAO 合约
- `node scripts/local-mvp.mjs` — 恢复或初始化持久化 Anvil 链并启动完整本地闭环

## 规则加载顺序

1. 加载根目录 `AGENTS.md`，它是跨 Claude、Codex 和工作流的唯一稳定工程规则源。
2. 加载 `.claude/rules/` 中与当前任务和模块匹配的规则（按 glob 自动匹配，也可按需显式引入）：
   - @rules/coding-style.md — 文档与规格写作风格
   - @rules/git-workflow.md — Git 提交与分支规范
   - @rules/security.md — 安全基线（认证授权、钱包资金、外部 Agent 输入、密钥审计）
   - @rules/testing.md — 测试与验证规范
3. 加载对应 feature 的 `requirements.md`、`design.md`、`tasks.md` 和项目级 `PLAN.md`（如存在）。
4. 用户当前请求和更具体目录的规则优先；发现冲突时说明并请求确认，不得静默覆盖。

## 核心工程模型

- 用《无穷的开始》的方法寻找受证据约束、难以随意改变的解释，并通过反例、实验和纠错推进工作。
- 用《软件设计的哲学》的方法降低修改扩散、认知负担和未知依赖，优先深模块、信息隐藏与简单接口。
- 用《重构（TypeScript 版）》的方法在行为保护下小步改善结构，将重构与功能变化分开。

## Claude 强制门禁

1. 开始前明确目标、约束、不变量、非目标、未知和验收证据，并检查已有修改。
2. 诊断时区分事实、推断和未知；没有代码、测试、日志或可重复实验支持时，不得声称已找到根因。
3. 涉及公共接口、数据库、认证、资金、并发、部署或跨系统流程时，实施前输出 `AGENTS.md` 规定的高影响决策摘要。
4. 新增抽象前说明它隐藏的复杂度；只转发调用或为假想未来服务时不得创建。
5. 重构前建立行为基线，小步验证，并与功能变化分阶段进行。
6. 对钱包、资金、状态迁移、外部 Agent 和回调严格执行权限、精度、幂等、超时、审计和恢复规则。
7. 完成前运行适用测试、类型检查、lint 和构建；只报告实际执行过的结果。

## 工作流兼容规则

- `yd:prd` 和 `yd-ai-wf-opt` 可以增量补充已验证的项目事实、命令、目录及模块规则，但不得把已冻结技术栈改回候选状态或创建平行实现；技术栈变更必须先由用户确认并同步 `docs/prd.md` 与 `specs/PLAN.md`。
- 工作流产生的临时任务信息写入 `specs/` 或对应 feature 文件，不得混入稳定工程规则。
- 新教训按 `AGENTS.md` 第 12 节格式沉淀；模块专属教训写入模块目录的 `AGENTS.md`。
- `PLAN.md` 中已确认的项目级技术决策必须执行；需要偏离时作为 blocker 明确说明，不得自行替换为“等价方案”。
- 工作流生成的规则若与根 `AGENTS.md` 稳定规则冲突，必须保留根规则并报告冲突。

## 当前目录

```text
.
├── .claude/                 # Claude 项目记忆与工作流规则
├── docs/                    # PRD、设计系统、工程方法论、Agent 接入协议规格
├── services/
│   ├── dispatch-engine/     # Go 派发引擎；internal/protocol 为 Agent 接入协议实现
│   ├── business-service/    # 业务库 SQL migration（agents/agent_credentials/audit_logs）
│   └── business-api/        # TS 权威业务 API 与工作流/资金协调
├── agents/                   # 正式产品工作流与论文调研 Agent
├── contracts/escrow/         # USDC 托管、原子分账和 DAO 仲裁合约
├── web/                     # 唯一正式 Web 工程（better-t-stack / Next.js 16）
├── specs/                   # 16 个 feature 的 requirements/design/tasks 及 PLAN.md
├── AGENTS.md                # 跨 Agent 稳定工程规则
└── README.md                # 项目说明
```

三本书的完整思想、统一模型和常见误读见 `docs/engineering-philosophy.md`。日常执行以 `AGENTS.md` 的强制门禁为准。

@AGENTS.md
