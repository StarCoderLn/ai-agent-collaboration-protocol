# Ethereum 托管合约 — 任务清单

## 任务版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始任务 |
| 2026-08-20 | v2   | T-003 明确转账拆分与 `feeReceiver` 管理；T-005 增加 `setFeeReceiver()` 权限接入；T-006 增补测试；任务结构和数量不变 |
| 2026-08-20 | v3   | T-005 拆出独立 `TREASURY_ROLE`（`setFeeReceiver()` 从 `PAUSER_ROLE` 改过来）；T-006 增补对应测试；任务结构和数量不变 |

## 项目信息

- 项目名: ai-agent-collaboration-protocol
- 架构类型: 多服务架构
- specs 路径: specs/5.escrow-contract-ethereum/

## 任务列表

### 功能 1: 脚手架与事件

- [ ] T-001: 初始化合约项目（Hardhat/Foundry + OpenZeppelin 依赖，配置测试网络），并定义 `Deposited`/`Released`/`Refunded`/`Paused`/`Unpaused` 事件签名 ~30min

### 功能 2: 存款与状态

- [ ] T-002: 实现 `Escrow` 存储结构与 `deposit()`（含重复托管拒绝，触发 `Deposited`） ~30min

### 功能 3: 结算与退款

- [ ] T-003: 实现 `release()`（权限校验、防重入、终态迁移，触发 `Released`；`[v2]` 转账拆分为 `payee` 收 `amount-feeAmount`、`feeReceiver` 收 `feeAmount`） ~30min
- [ ] T-004: 实现 `refund()`（权限校验、防重入、终态迁移，触发 `Refunded`） ~30min

### 功能 4: 权限与暂停

- [ ] T-005: 接入 AccessControl 角色（`OPERATOR_ROLE`/`PAUSER_ROLE`/`[v3 新增]` `TREASURY_ROLE`）与 Pausable 机制（触发 `Paused`/`Unpaused`）；实现 `setFeeReceiver()`（`[v3 修改]` 权限从 `PAUSER_ROLE` 改为 `TREASURY_ROLE`，触发 `FeeReceiverUpdated`） ~30min

### 集成与测试

- [ ] T-006: 编写单元测试：正常路径、权限拒绝、重复操作拒绝、暂停期间操作拒绝、`[v2]` `release()` 转账拆分金额正确（`payee` 与 `feeReceiver` 各收到的金额之和等于托管总额）、`[v3 修改]` 非 `TREASURY_ROLE` 无法调用 `setFeeReceiver()`（含验证 `PAUSER_ROLE` 单独持有者也不能调用，确认两个角色确实互不越权） ~30min
- [ ] T-007: 编写重入攻击模拟测试（恶意 payee 合约尝试重入 `release`） ~30min
- [ ] T-008: 编写测试网部署脚本，输出合约地址与 ABI 供 [[6.escrow-sync-and-wallet]] 使用 ~30min

## 依赖关系

- T-002 依赖 T-001
- T-003、T-004 依赖 T-002、T-005
- T-006、T-007 依赖 T-002、T-003、T-004、T-005
- T-008 依赖 T-006（内部测试通过后再部署到测试网）

## 风险点

- 独立第三方安全审计未包含在本任务清单内（PRD 要求上线前完成），需在项目里程碑层面单独排期，不得以本 feature 任务全部完成为由跳过审计。
- 手续费费率与承担方已确认（见 requirements.md），`feeAmount` 由调用方（链下 [[4.task-creation-and-preview]] 的 `CalculatePlatformFee()`）传入，链下校验测试属于 [[6.escrow-sync-and-wallet]] 范围，不在本 feature 任务内。
