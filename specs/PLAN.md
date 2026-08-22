# 开发计划索引

## 本次 PRD（2026-08-20）切分为 16 个 feature

来源需求文档：`docs/prd.md`（AI Agent 协作协议平台 MVP）。范围：完整 MVP（对应 PRD 第 11 节 P1-P4），链选型：**Ethereum**（用户已确认，Solana 不在 MVP 范围）。`[2026-08-22 变更]` 14.ops-backend-and-metrics、15.agent-sandbox-admission、16.agent-wallet-rebind 已被用户确认延后至 P5「后续能力」（见 docs/prd.md 2.2 节），当前 MVP 本轮开发范围为 **12 个 feature**（1-13，不含 14/15/16）；三个延后 feature 的 requirements/design/tasks 均已生成，予以保留供后续启用时直接使用，不删除也不重新编号。

## 项目级技术栈决策（已冻结）

- 前端只保留 better-t-stack 生成的 `web/` pnpm workspace，唯一正式应用是 `web/apps/web`；不得新增 Vite 或其他平行前端。
- Web 使用 Next.js 16、React 19、TypeScript strict、App Router 和 Route Handlers；共享 UI 使用 `web/packages/ui`，样式使用 Tailwind CSS。
- 边界校验使用 Zod，前端测试使用 Vitest + Testing Library，lint/格式化使用 Biome。
- 用户面业务 API 采用 Next.js Route Handlers 并以 AWS Lambda 为部署方向；Go 只承担分发引擎与 Agent 接入协议职责。Lambda 打包与 IaC 方案（2026-08-22 由用户确认）：AWS Lambda Web Adapter + zip 打包（不用容器镜像）+ AWS CDK（不用 SAM——本项目已知会有多个 Lambda，包括未来 feature 9/10 的 SQS 消费者、feature 12 的定时评分任务，CDK 用真正的编程语言表达共享配置更合适）。具体实现与部署命令见 `services/business-api/infra/README.md`；后续新增 Lambda（不限于 business-api）默认沿用同一 IaC 工具，除非有真实理由需要偏离（如 Go 分发引擎若改用 ECS/Fargate 等非 serverless 资源，仍可用 CDK 表达，不需要引入第二套工具）。
- PostgreSQL、AWS SQS/SNS、Ethereum + Solidity + MetaMask 是 MVP 已选技术边界；不实现 Solana/Phantom 路径。
- “技术栈已确定”不代表所有实现已完成。路由装配、数据库适配器、认证协议或部署配置缺失时，必须准确记录为实现缺口，不得另建技术栈替代。
- 提供者钱包认证方案已冻结为 SIWE（EIP-4361）：`GET /api/auth/nonce` 签发一次性 nonce（PostgreSQL 存储，短 TTL，单次使用）→ 前端 `personal_sign` 签署标准 SIWE 消息 → `POST /api/auth/verify` 校验签名与 nonce 后写入 `auth_sessions`（session_id、wallet_address、expires_at）并下发 httpOnly+Secure+SameSite=Lax 的不透明 session cookie → 后续接口从 session 解析 `actorId`，不信任请求体/Header 自报的钱包地址。会话 TTL 24 小时，过期需重新签名；多端会话管理与 refresh 轮换体验不在本轮范围。详细设计与实现见 [[2.agent-registration]] design.md 模块 5。（2026-08-22 由用户确认冻结）
- Mastra、LangChain、LangGraph 仅用于第三方或自建测试 Agent 的内部编排，不是平台 Web/API 技术栈替代项；自建测试 Agent 的生产选型仍需样例工作流验证后单独冻结。

| 序号 | feature | 说明 | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | agent-protocol-contract | Agent 接入协议基础设施：认证签名、幂等键、错误码、超时重试语义 | - | 已实现 |
| 2 | agent-registration | Agent 注册、凭证加密存储、必填校验、审计日志 | 1 | 已完成（T-001～T-012；真实 PostgreSQL、AWS KMS 与 CDK 部署仍待环境级验证） |
| 3 | agent-health-lifecycle | 健康检查、上下架状态机、试运行准入、运营审核 | 1, 2 | 待开发 |
| 4 | task-creation-and-preview | 任务创建表单、字段校验、分类标签联动、发布前预览 | - | 待开发 |
| 5 | escrow-contract-ethereum | Ethereum 智能合约：托管存款、退款、结算、暂停、事件 | - | 待开发 |
| 6 | escrow-sync-and-wallet | 链上事件同步/确认/对账/恢复、钱包交互与托管状态前端 | 4, 5 | 待开发 |
| 7 | task-visibility-and-mode | 可见性（私密/公开）、分配模式（手动/自动）、市场与工作台分离 | 4；T-004 另有对 3、12 的**表结构级**轻依赖（见下方说明） | 待开发 |
| 8 | matching-and-candidates | V0 匹配（分类→资格→标签→排序）、JobDistributionRecord、候选列表/可视化 | 3, 6, 7 | 待开发 |
| 9 | dispatch-and-acceptance | 原子占用分配、SQS 派发、Agent 接单/拒单确认、接单超时处理 | 1, 8 | 待开发 |
| 10 | notification-and-sync | Webhook 签名异步通知、退避重试与死信队列、SSE 进度推送、状态补拉接口 | 1, 9 | 待开发 |
| 11 | execution-tracking-and-delivery | Agent 进度上报、1~3 个候选结果提交与版本管理、验收/返工 | 1, 10 | 待开发 |
| 12 | scoring-system | 五维评分计算（贝叶斯平滑/时间衰减）、规则版本化、评分页面 | 11 | 待开发 |
| 13 | dispute-and-arbitration | 争议发起、证据提交、资金冻结、人工仲裁决定、结算/退款执行 | 6, 11 | 待开发 |
| 14 | ops-backend-and-metrics | 运营后台（审核/查询/超时处理/交易核对）、核心指标埋点看板 | 2, 3, 8, 9, 13 | **延后至 P5**（用户确认，2026-08-22；MVP 阶段运营操作走直接数据库操作/人工介入） |
| 15 | agent-sandbox-admission | 新 Agent 沙箱调用（3 次标准化测试）+ 清单式人工判定，驱动试运行→可接单准入 | 1, 2, 3, 14 | **延后至 P5**（用户确认，2026-08-22；MVP 阶段内部测试 Agent 由人工直接标记为可接单，跳过正式沙箱流程；3 的 `AdminApprove` 事件改由人工/临时接口触发，不依赖 15） |
| 16 | agent-wallet-rebind | 钱包换绑：新钱包签名验证所有权 + 站外通知 + 冷静期，冷静期内结算仍走旧地址 | 1, 2 | **延后至 P5**（用户确认，2026-08-22；不阻塞其他 feature，无 feature 反向依赖 16） |

**推荐执行顺序**：1 → 2 → 3；与此并行可先做 4、5（任务创建表单与合约互不依赖）→ 6 → 7 → 8 → 9 → 10 → 11 →（12 与 13 可并行）。本轮开发到 12/13 完成即构成完整闭环（含评分与争议仲裁），14/15/16 已延后至 P5，暂不排入本轮开发顺序。

```text
1 → 2 → 3 ─┐
            ├→ 8 → 9 → 10 → 11 → 12
4 → 7 ──────┘
4 → 6 ← 5 ─────────────────────────────┐
6 → 13 ← 11 ─────────────────────────────┘
```

14（运营后台+指标）、15（沙箱准入）、16（钱包换绑）均已延后至 P5，不再画入本轮依赖图。3 的 `AdminApprove` 事件（原由 15 驱动）在 15 缺席期间由人工/临时接口直接触发；14 依赖的 2/3/8/9/13 均在本轮范围内，恢复 14 的排期时不受影响。

> **7.T-004 的轻依赖说明（避免误读为循环依赖）**：`ValidateHardConstraints()` 的"受控上线期预算上限"判断需要查询 `3.agent_status_config`（`3.T-001` 建表）和 `12.agent_score_snapshots`/`scoring_rule_versions`（`12.T-001` 建表）两张表，但**只依赖表结构存在，不依赖 12 的评分计算逻辑跑完**——查不到快照时按"样本量=0"处理，本身就是合法的"受控中"判定。所以不需要等 12 全部开发完才能做 7，只需要 12 的建表任务（`12.T-001`）先完成；`12.T-001` 本身只依赖 [[11.execution-tracking-and-delivery]] 的表结构（不依赖 11 的业务逻辑跑完），可以视需要提前于 12 的其余任务单独排期，不构成 7 → 12 → 11 → … → 8 → 7 这样的真实循环。

> 变更记录（2026-08-20，本条）：F-006「试运行 Agent 风险上限」改为「受控上线期风险上限」，修正与 [[15.agent-sandbox-admission]] 沙箱准入设计的矛盾（详见 3.agent-health-lifecycle v5、7.task-visibility-and-mode v2 的需求版本记录）；7 新增对 3、12 的表结构级依赖，已在上方特别说明避免误读为循环依赖。
> 变更记录（2026-08-20，本条）：[[4.task-creation-and-preview]] 最短执行周期默认值从 2 小时改为 30 分钟（v5），明确其只保证调度流水线跑得完，不重复"预计时长 vs 截止时间"硬约束的职责；同时修正 [[11.execution-tracking-and-delivery]] 超时检测（v3）此前只扫描「执行中」状态的漏洞，扩大到「待匹配、待接单、执行中」三个状态，避免 deadline 设置偏短的任务卡在中间状态导致资金滞留。
> 变更记录（2026-08-20，本条）：合约私钥管理方案确认为角色分离 + 多签分级参考表（[[5.escrow-contract-ethereum]] v5），拆出独立 `TREASURY_ROLE`。全量核对 16 个 feature 的开放问题，确认无阻塞开发的项目；补记此前遗漏的 PRD §14 P0-2（已在 6 落地，仅补文档）、P1-3（补进 14 的开放问题）、P1-4（合规工作，单独跟踪，不塞进某个 feature）。[[15.agent-sandbox-admission]] 沙箱调用成本确认由平台承担；[[2.agent-registration]] 邮箱字段确认为必填（支撑 [[16.agent-wallet-rebind]] 的站外通知）。

> 变更记录：
> - 拆分原「9.dispatch-and-acceptance」为 9（分配与接单）与 10（通知与状态同步）两个 feature，因合并后任务数超过单 feature 8 个上限（Step 5.5/9 强制要求）；10 之后的原 10-13 顺延为 11-14。
> - 2026-08-20 `--change`：新增 15.agent-sandbox-admission，落实 PRD §14 P0-7「新 Agent 沙箱调用 3 次 + 清单式人工判定」的确认方案。同步更新了 1.agent-protocol-contract（新增 F-006 沙箱模式标记位，v1→v2）与 3.agent-health-lifecycle（F-007 触发条件明确为 15 的判定结果，v1→v2），两个 feature 均未变更任务数量，任务结构不受影响。
> - 2026-08-20 `--change`：新增 16.agent-wallet-rebind，落实钱包换绑安全流程（新钱包签名验证 + 站外通知 + 冷静期，参考交易所提现地址变更惯例）。同步更新了 2.agent-registration（AC-004 从「MVP 不支持换绑」改为「换绑走 16 的独立流程」，v1→v2，任务结构不变）。
> - 2026-08-22 `--change`：用户确认为缩短本轮开发周期，将 16.agent-wallet-rebind 延后至 P5「后续能力」（同步更新 docs/prd.md 2.2 节）。2.agent-registration 的 AC-004（拒绝直接修改钱包地址）不受影响：MVP 阶段钱包地址注册后本就保持不可编辑，延后 16 不需要任何代码回退或降级路径。requirements/design/tasks 予以保留，不删除、不重新编号，后续启用时可直接使用。
> - 2026-08-22 `--change`：用户进一步确认将 14.ops-backend-and-metrics、15.agent-sandbox-admission 一并延后至 P5（同步更新 docs/prd.md 2.1/2.2 节），本轮 MVP 开发范围收敛为 1-13 共 12 个 feature，12（评分）与 13（争议仲裁）按用户要求保留在本轮范围内以保证闭环完整（PRD 4.2 单 Agent 任务闭环的第 9、11 步显式包含争议与评分）。影响评估：无其他 feature 依赖 14 或 15，延后不阻塞已排期的开发顺序；3.agent-health-lifecycle 的 `AdminApprove` 事件原本由 15 的沙箱判定结果驱动，15 缺席期间该事件需要人工/临时接口直接触发（不需要修改 3 的状态机本身，只是触发方从"15 的正式判定"改为"人工操作"）。requirements/design/tasks 均已生成，予以保留，不删除、不重新编号。

## 前置决策记录（来自用户确认，2026-08-20）

- **链选型**：Ethereum（Solidity 合约，MetaMask 钱包），不实现 Solana 路径。
- **生成范围**：完整 MVP（P1-P4），P5（后续能力）不生成 specs。
- **前端实现方式**：不使用 `docs/stitch-design-guide.md` 描述的 Stitch 出图流程（该文档已标注搁置）。所有前端 task 在开发阶段由前端工程师（`/yd:ai` 的 `yd-frontend-engineer`）直接依据 `docs/DESIGN.md` 的视觉规范用代码实现，通过浏览器实际运行验证效果，不产出中间设计稿。原因：Stitch 的图片生成对 `docs/DESIGN.md` 中新增的精确规则（金额小数位、过渡时长、图标描边等）难以稳定复现，直接写代码更精确且迭代成本更低。

## ID 编号约定

- 功能需求 / 任务 / 验收标准 ID **在单个 feature 内编号**，跨 feature 用 `{序号}.` 前缀区分。
- 例：`2.T-001` = 序号 2 这个 feature 的 T-001；`8.F-005` = 序号 8 的 F-005。
- **跨 feature 依赖**写全限定 ID，如 `9.T-001 依赖 8.T-004`。

## PRD 中标注「待确认」但本次切分未阻塞生成的决策

以下决策仍未拍板，已在对应 feature 的 requirements.md「开放问题」中标注，design.md 按当前 PRD 推荐方向设计但预留调整点。产品/合约/法务确认后，用 `/yd:prd --change {N} 说明变更` 更新：

- **链上交易确认条件（PRD §14 P0-2）**`[2026-08-20 补记，此前遗漏]`：切分时这条已在 [[6.escrow-sync-and-wallet]] 落地为可配置默认值（12 个区块确认，Ethereum 主网惯例），但从未被列入本清单，属于文档记录遗漏，不影响开发进度，仅为补全追溯记录。
- ~~平台手续费费率与承担方（PRD §14 P0-3）~~ `[2026-08-20 已确认]`：费率 0.4%，由 Agent 提供者结算金额中扣除（发布者不额外加价），见 [[4.task-creation-and-preview]] `CalculatePlatformFee()` 与 [[5.escrow-contract-ethereum]] `release()` 的转账拆分；不设最低任务预算，手续费下限改为 gas 成本兜底（非拍脑袋数字）。
- 接单后取消/退款/返工/超时赔付细则（PRD §14 P0-4）
- 仲裁执行方、是否支持部分支付/申诉（PRD §14 P0-5）
- ~~新 Agent 沙箱评估 vs 低风险真实任务 vs 纯人工审核（PRD §14 P0-7）~~ `[2026-08-20 已确认]`：采用沙箱调用 3 次 + 清单式人工判定，见 [[15.agent-sandbox-admission]]；沙箱调用成本 `[2026-08-20 已确认]` 由平台承担，不向 Agent 提供者收费；分类专属测试任务内容仍待产品/运营补充（见该 feature 的开放问题）
- ~~文件类型/大小（PRD §14 P0-8 部分）~~ `[2026-08-20 已确认]`：按任务分类分别配置上限（工程判断，非商业/法务决策），见 [[4.task-creation-and-preview]] F-007；任务类别体系本身、数据保留期限仍待产品/法务确认
- 自动分配是否进入 MVP 及价格上限规则（PRD §14 P0-9，PRD 正文已默认「手动为主、自动为可选开关」，按此实现）
- 机器验收（自动放款）适用范围与验收器归属（PRD §14 P0-10）
- 五维评分权重、匹配排序权重（PRD §14 P1-1、P1-2）
- **服务等级、告警阈值、备份恢复、容量目标（PRD §14 P1-3）**`[2026-08-20 补记，此前遗漏]`：初次切分时这条没有被任何 feature 承接，纯运维/SLA 定义工作，已补记到 [[14.ops-backend-and-metrics]] 开放问题；不阻塞当前开发（不影响接口/数据结构），上线前需要产品/运维定具体阈值。
- **上线地区及 KYC/AML、隐私、税务、争议适用法律（PRD §14 P1-4）**`[2026-08-20 补记，此前遗漏]`：初次切分时同样没有被任何 feature 承接，这条本质是法务合规工作而非工程任务，不适合塞进某个开发 feature——在这里单独跟踪：**上线前必须由法务/合规团队完成评估**，具体影响面可能涉及 KYC 流程（当前 specs 未设计）、税务申报接口、争议管辖条款，一旦有明确要求需通过 `--change` 补充对应 feature 或新增 feature。
