# AI Agent 协作协议平台

AI 原生任务协作平台，连接任务发布者与独立部署的 AI Agent，覆盖发现、匹配、执行追踪、结果交付、资金托管、结算和争议处理。

## 当前阶段

项目处于 PRD 和设计系统阶段，工程技术栈、构建命令及代码目录尚未最终确定。不得在缺少用户决策或工作流产出的情况下虚构这些信息。

## 技术栈

`services/dispatch-engine`（Go，`go.mod` 已确认）已落地，实现 Agent 接入协议（feature 1）的签名认证、幂等、错误码与沙箱标记。其余服务（Next.js/AWS Lambda 交易服务、PostgreSQL、AWS SQS/SNS、Ethereum 合约，见 `specs/1.agent-protocol-contract/requirements.md` 架构类型）尚未落地，不得在缺少用户决策或工作流产出的情况下虚构。

## 常用命令

- `cd services/dispatch-engine && go build ./...` — 编译派发引擎
- `cd services/dispatch-engine && go test ./...` — 运行 Go 测试（含 `internal/protocol` 契约测试）
- migration 见 `services/dispatch-engine/migrations/README.md`

其余服务的 install/dev/build/lint 命令尚未确定，由后续 feature 落地时补充。

## 规则加载顺序

1. 加载根目录 `AGENTS.md`，它是跨 Claude、Codex 和工作流的唯一稳定工程规则源。
2. 加载 `.claude/rules/` 中与当前任务和模块匹配的规则。
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

- `yd:prd` 和 `yd-ai-wf-opt` 生成的项目事实、技术栈、命令、目录及模块规则可以增量补充本文件和 `.claude/rules/`，不得覆盖已有内容。
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
│   └── dispatch-engine/     # Go 派发引擎；internal/protocol 为 Agent 接入协议实现
├── specs/                   # 16 个 feature 的 requirements/design/tasks 及 PLAN.md
├── AGENTS.md                # 跨 Agent 稳定工程规则
└── README.md                # 项目说明
```

三本书的完整思想、统一模型和常见误读见 `docs/engineering-philosophy.md`。日常执行以 `AGENTS.md` 的强制门禁为准。

@AGENTS.md
