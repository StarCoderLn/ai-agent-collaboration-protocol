# LangGraph 与 Temporal 编排边界

项目采用分层编排：LangGraph 管理单个 Agent 内部的不确定执行图，Temporal 管理跨服务、可长时间运行的业务步骤。PostgreSQL 保存任务与准入业务事实，智能合约保存资金最终事实；页面不会从 checkpoint 或 Temporal History 猜测业务状态。

2026-09-16 增加 AI 工作流规划：LangGraph 还负责“生成草案 → 本地 DAG 审查 → 最多一次修正”，
但生成结果仍只是版本化草案。发布者确认后，Marketplace API 才将其固化到正式工作流表并开放
逐节点匹配。本次规划不调用 Temporal；当前 Temporal 继续承担自动准入和匹配 V2 夜间训练，
正式任务 DAG 仍由 PostgreSQL 状态机与 Dispatch Engine 推进。结构化模型客户端通过统一
配置支持 DeepSeek 与 OpenAI，供应商输出始终经过相同 Zod 和确定性拓扑校验。

## LangGraph Coding Agent

`agents/product-workflow/src/agents/coding/langgraph-agent.ts` 是正式候选 `code-langgraph`，使用独立平台 UUID。内部图把 TSX 与 CSS 分为两个节点，可信输出失败只局部重做一次；基础设施失败后从最后一个成功检查点继续。

正式服务使用 `@langchain/langgraph-checkpoint-postgres`，框架表位于独立 `langgraph` schema。线程键由 Agent、assignment 和执行/返工轮次组成：网络重放与执行恢复复用同一检查点，新返工不会读取旧产物。启动时会幂等执行官方 checkpoint migration。

内部实现使用 `StateGraph`、`Annotation.Root`、`START`、`END` 和条件边表达两段生成。
`MemorySaver` 只用于无需数据库的单元测试；正式服务和跨进程恢复均使用 `PostgresSaver`。

## Temporal 自动准入

`services/dispatch-engine/internal/temporaladmission` 已接入 Dispatch Engine 组合根。三次沙箱、质量评测、生命周期迁移和失败释放分别位于 Activity；每项具有稳定 Activity ID，并继续使用现有 PostgreSQL 幂等键。

运行模式只有一个生效：

```bash
# 原 PostgreSQL 租约 Worker
AGENT_ADMISSION_ENGINE=postgres

# Temporal Starter 与 Worker
AGENT_ADMISSION_ENGINE=temporal
TEMPORAL_ADDRESS=127.0.0.1:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_ADMISSION_TASK_QUEUE=aicp-agent-admission-v1
```

`AGENT_ADMISSION_ENABLED=false` 会关闭两种入口。Temporal 模式连接失败时 Dispatch Engine 启动失败，不会静默退回 PostgreSQL Worker。Workflow 最长运行一小时，数据库领取租约为两小时，避免活跃 Workflow 被第二个 Starter 重领；启动失败和 Activity 最终失败会释放原租约。

技术失败仍完成三道低成本沙箱题，以便提供者一次获得完整诊断。评测 Activity 复用 `sandboxadmission.Worker` 的唯一技术门禁：技术不通过时只保存确定性结果，不调用 DeepSeek。只有质量通过才迁移 Agent 生命周期；无论通过与否都会结束数据库轮次。

## Temporal 匹配 V2 夜间训练

`temporaltraining` 使用独立 Task Queue 编排“导出已完成真实漏斗 → 执行 PyTorch 训练 →
注册 candidate 模型”。UTC 02:00 Schedule 默认跳过重叠运行，六小时外不追赶，并在最终
失败时暂停，避免服务恢复后堆叠训练。训练数据、运行状态和模型版本仍由 PostgreSQL
保存；Temporal History 只负责步骤、重试和恢复。开启时需设置
`MATCHING_V2_TRAINING_ENABLED=true` 及模型代码、训练工作目录和制品目录。

## 当前可用性与部署口径

LangGraph 和 Temporal 的代码接入、本机真实服务运行及中断恢复验收均已完成。面试演示使用
本机 Temporal CLI Dev Server 即可：面试官通过屏幕共享查看 Web UI，不需要开放 `7233`
端口，也不依赖 AWS 或 Temporal Cloud。完整本地启动前先运行 Temporal Dev Server，再将
`AGENT_ADMISSION_ENGINE` 设置为 `temporal`。

线上业务不能长期依赖个人电脑上的 Temporal Server。首次部署可以继续使用默认
`AGENT_ADMISSION_ENGINE=postgres`；需要在线启用 Temporal 时，再选择 Temporal Cloud 或
把开源 Temporal Server 部署到线上。Temporal Cloud 是付费托管服务；AWS 自托管还需要
数据库、备份、监控和升级，二者均属于上线运维范围，不影响当前开发完成状态。

## 已执行的真实验证

- 工作流规划使用固定新能源汽车调研需求完成真实 DeepSeek 调用，生成 7 个合法阶段；浏览器
  完成节点编辑、新增第 8 阶段、创建依赖、保存与确认，并切换到正式 Agent 分配图。
- PostgreSQL 核对确认 1 个正式 run、8 个节点、8 条业务依赖，候选和托管记录均为 0；事务
  集成测试覆盖三类修订、版本冲突、确认锁定和回滚隔离。
- 2026-09-17 将规划协议升级为 v2：LangGraph 只能使用 active Agent 实时声明的完整契约组合，
  Marketplace API 在确认事务中再次执行能力门禁。历史错误图仅在没有选人、托管和执行事实时
  才能先归档再恢复为草案；有分配或托管记录的集成测试路径均明确拒绝恢复。
- 上述“候选和托管为 0”只证明确认边界没有提前产生交易事实。随后同一验收任务删除未执行
  的空占位节点，剩余 7 个真实阶段完成研究、路演结构、HTML/PPTX 交付与质检；12 USDC
  Sepolia 托管最终原子结算 10.5 USDC 毛额、平台费 0.35 USDC，并退款 1.5 USDC，任务状态为
  `settled`，未解决对账告警为 0。

- Product Workflow 全量回归 77 项通过、3 项需显式环境的真实用例默认跳过；TypeScript
  检查与构建通过。AI 工作流规划的 PostgreSQL 生命周期另以本机事务集成测试通过。
- 经单独授权后，`code-langgraph` 使用固定合法 DesignSpec 完成一次真实 DeepSeek 冒烟：生成
  `app/page.tsx` 与 `app/globals.css`，并通过标题、四个颜色 token、响应式规则和可信源码校验。
  该用例没有调用 Design Agent，测试输出仅写入系统临时目录。
- PostgreSQL checkpointer 在关闭第一组连接后由新连接恢复 CSS，TSX 调用次数保持为 0。
- Product Workflow 正式服务初始化 checkpoint schema 后，`/livez` 返回 200，目录返回 `code-langgraph`，共 10 个候选。
- Temporal CLI 1.8.3 / Server 1.31.2 真实启动；第二个 Activity 执行时停止 Worker 和 Server，使用同一 SQLite 历史库重启后完成剩余步骤，第一个 Activity 未重跑。
- 匹配 V2 使用同一真实 Temporal Server 完成数据准备、PyTorch 离线训练、ONNX 导出和 candidate 注册
  Activity；样本不足走 `skipped` 正常终态，不会暂停下一次夜间 Schedule。
- Dispatch Engine 全量 Go 测试通过；真实恢复测试默认跳过，需显式设置 `AICP_TEMPORAL_DEV_SERVER_TEST=1`，下载目录使用测试临时目录并在结束后清理。

除明确标注的单次 Coding 冒烟外，其余恢复验证不调用 DeepSeek。所有验证均不连接 AWS、
不修改链上状态。本机面试演示方案已经确定；线上 Temporal 选用 Cloud、自托管或其他部署
方式仍是上线前的运维决策，需补充监控、备份、容量和费用评估。
