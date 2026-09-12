# LangGraph 与 Temporal 持久编排 — 任务清单

## 任务列表

- [x] T-001: 固定 Agent 内部编排、平台持久编排、PostgreSQL 业务事实和链上资金事实的职责边界。
- [x] T-002: 锁定 LangGraph 1.4.15，新增 Coding 显式图、有限局部修复及可注入 checkpointer。
- [x] T-003: 验证同 `thread_id` 在 CSS 基础设施失败后恢复，且不重新生成已验收 TSX。
- [x] T-004: 锁定 Temporal Go SDK 1.48.0，新增三次沙箱、技术门禁、质量评测和幂等迁移 Workflow。
- [x] T-005: 覆盖 Temporal Activity 临时错误重试、确定性技术失败跳过付费评测和通过后迁移。
- [x] T-006: 完成 Product Workflow、Dispatch Engine 全量回归、构建、静态检查和文档同步。

## 正式接入与真实环境验证

- [x] T-007: 使用官方 PostgreSQL checkpointer 关闭旧连接后恢复，且不重新生成已验收 TSX。
- [x] T-008: 新增独立 `code-langgraph` 正式候选、稳定 execution ID、目录和数据库 bootstrap。
- [x] T-009: 使用 Temporal Dev Server 和真实 Worker 完成 Server/Worker 停机、重启与历史恢复。
- [x] T-010: 为现有自动准入实现 Activity 适配器、单轮唯一 Workflow ID 和互斥运行模式。
- [x] T-011: 使用固定 DesignSpec 对 `code-langgraph` 完成受控真实 DeepSeek 生成与可信输出验收。
- [x] T-012: 明确本机 Temporal Dev Server 用于远程面试屏幕共享，线上部署前保持可回退的 PostgreSQL Worker。

## 部署开放项
- [ ] 出现线上持久编排需求时，决定 Temporal Cloud、自托管或其他部署方式，并补充监控、备份、容量和费用评估。
