# LangGraph 与 Temporal 持久编排 — 需求

## 目标

在不改变现有任务、资金和 DAO 权威状态的前提下，为项目增加两条可验证的编排基线：

- LangGraph 表达复杂 Coding Agent 内部的条件分支、局部修复和检查点恢复。
- Temporal 表达跨服务自动准入流程的 Activity 重试、稳定身份和可回放执行顺序。

## 功能需求

1. [F-001] LangGraph Coding 流程必须把页面生成和样式生成建模为独立节点；输出校验失败最多局部重做一次，不得重新生成已经通过的片段。
2. [F-002] LangGraph checkpointer 必须由调用方注入，并通过稳定 `thread_id` 恢复；基础设施失败恢复时不得覆盖已验收 TSX。
3. [F-003] Temporal 自动准入 Workflow 必须依次完成三次不同沙箱 Activity；技术门禁失败仍保存完整三次证据，但不能触发付费质量评测。
4. [F-004] Temporal Activity 使用稳定 Activity ID 和业务幂等键；临时错误最多重试三次，协议不合规等确定性错误不可重试。
5. [F-005] 只有质量评测通过时才执行生命周期迁移 Activity；迁移使用轮次级幂等键。
6. [F-006] PostgreSQL 继续保存业务事实，智能合约继续保存资金事实；Temporal 与旧 Worker 必须互斥，不迁移历史任务，不广播链上交易。

## 验收标准

- [x] [AC-001] LangGraph 正常路径、局部修复和同线程检查点恢复测试通过。
- [x] [AC-002] Temporal 三次运行、临时错误重试、技术失败跳过评测及通过后幂等迁移测试通过。
- [x] [AC-003] Product Workflow 与 Dispatch Engine 完整回归、类型检查、构建和静态检查通过。
- [x] [AC-004] PostgreSQL checkpointer 关闭连接恢复、Temporal Dev Server 与 Worker 停机重启恢复演练通过。
- [x] [AC-005] LangGraph 使用独立正式 Agent ID；Temporal Activity 适配现有仓储、评测与生命周期模块，入口具有互斥配置。
- [x] [AC-006] `code-langgraph` 使用真实 DeepSeek 生成 TSX 与 CSS，并通过设计继承、响应式和可信源码校验。

## 非目标

- 不把 LangGraph 内部状态写入 AICP 公共协议。
- 不使用 Temporal 直接调用模型、数据库或链上 RPC；这些副作用只能位于 Activity。
- 不替换现有 Mastra 候选、自研状态机或资金状态机。
- 不迁移已有任务和历史准入 Workflow。
