# LangGraph 与 Temporal 持久编排 — 设计

## 高影响决策

- **触发条件：** 新增 Agent 运行时依赖和跨服务工作流 SDK，涉及重试、状态恢复及未来部署边界。
- **不变量：** PostgreSQL 是任务和准入业务事实源，智能合约是资金事实源；重复恢复不能重复模型调用、生命周期迁移或交易。
- **范围：** LangGraph 正式 Coding 候选、PostgreSQL checkpointer、Temporal 自动准入 Workflow、Activity 适配和互斥入口。
- **非目标：** 现有任务迁移、Temporal 云端部署、Sepolia 或 AWS 写入。
- **未知验证：** 本机面试演示使用 Temporal Dev Server；云端部署方式、监控、备份、容量与费用仍需结合上线环境验证。

## 候选方案与选择

### 方案 A：LangGraph/Temporal 直接接管现有状态

优点是框架能力能立即进入产品路径。缺点是会与 PostgreSQL 租约、outbox、任务状态机和链上同步形成双重权威；历史任务迁移和失败补偿范围过大，无法安全回滚。

### 方案 B：按边界渐进接入（采用）

LangGraph 作为 Coding 内部深模块返回现有 `GeneratedCodeFiles`，使用独立 Agent ID；Temporal 只接管自动准入的执行顺序，并复用现有业务模块。两种准入入口通过单值运行模式互斥，回退到 PostgreSQL Worker 不需要迁移业务状态。

## LangGraph 边界

```text
generate_page
  ├─ 可信输出失败且未重试 → generate_page
  ├─ 基础设施失败 → 保留 checkpoint，外部恢复
  └─ 成功 → generate_styles

generate_styles
  ├─ 可信输出失败且未重试 → generate_styles
  ├─ 基础设施失败 → 保留已验收 TSX，外部恢复
  └─ 成功 → END
```

模型客户端、提示词和可信校验继续复用 Product Workflow 的权威实现。图中只保存稳定错误码和字段路径，不保存供应商原始响应。

正式组合根使用官方 PostgreSQL checkpointer 和独立 schema。测试可注入 `MemorySaver`；正式线程键由 assignment 和执行/返工轮次构成，避免恢复丢失或返工碰撞。

## Temporal 边界

```text
Sandbox 1 → Sandbox 2 → Sandbox 3 → Evaluate → Apply decision
    └─ 技术失败 ─────────────────────────────→ not_passed
```

Workflow 只执行确定性控制逻辑。Agent HTTP、DeepSeek、PostgreSQL 和生命周期迁移均由 Activity 负责。每个 Activity 同时具有 Temporal Activity ID 和现有业务幂等键；Temporal 重试不代替数据库幂等。

Dispatch Engine 在 `postgres` 与 `temporal` 中只启动一个准入入口。Temporal Starter 先取得现有数据库轮次租约，再用单轮唯一 Workflow ID 启动；启动或 Activity 最终失败时释放租约。真实 Dev Server/Worker 停机恢复已经通过，云端集群和可观测性仍属部署开放项。

当前演示部署固定使用本机 Temporal CLI Dev Server，并通过屏幕共享展示，不向公网开放
Temporal 端口。线上初次部署可保持 PostgreSQL Worker；只有需要线上持久编排时才部署
Temporal Service，避免让线上业务依赖个人电脑或为演示提前承担云端固定费用。

## 依赖与本机影响

- TypeScript：`@langchain/langgraph@1.4.15` 与 PostgreSQL checkpointer 1.0.5，纯 JavaScript 依赖，不调用 Rust 工具链。
- Go：`go.temporal.io/sdk@v1.48.0`，使用 Go 模块缓存，不调用 Cargo、rustup 或 `puccinialin`。
- 真实验收只在测试临时目录下载 Temporal CLI，结束后删除；项目不会自动安装常驻服务，也不连接 AWS。
