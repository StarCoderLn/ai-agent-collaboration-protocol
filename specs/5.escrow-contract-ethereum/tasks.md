# Ethereum 托管合约 — 任务清单

## 任务版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始任务 |
| 2026-08-20 | v2   | T-003 明确转账拆分与 `feeReceiver` 管理；T-005 增加 `setFeeReceiver()` 权限接入；T-006 增补测试；任务结构和数量不变 |
| 2026-08-20 | v3   | T-005 拆出独立 `TREASURY_ROLE`（`setFeeReceiver()` 从 `PAUSER_ROLE` 改过来）；T-006 增补对应测试；任务结构和数量不变 |
| 2026-08-23 | v4   | T-003/T-006 补充实际成交额与未使用预算退款的金额守恒要求 |
| 2026-08-27 | v5   | 托管资产改为 USDC，增加授权/余额失败路径与恶意 Token 重入验证；测试网部署待重新验收 |
| 2026-08-30 | v6   | 增加多 Agent 里程碑释放、最终余额退款和部分释放后退款；公共测试网部署状态不变 |

## 项目信息

- 项目名: ai-agent-collaboration-protocol
- 架构类型: 多服务架构
- specs 路径: specs/5.escrow-contract-ethereum/

## 任务列表

### 功能 1: 脚手架与事件

- [x] T-001: 初始化合约项目（Hardhat/Foundry + OpenZeppelin 依赖，配置测试网络），并定义 `Deposited`/`Released`/`Refunded`/`Paused`/`Unpaused` 事件签名 ~30min

### 功能 2: 存款与状态

- [x] T-002: 实现 `Escrow` 存储结构与 USDC `deposit(taskId, amount)`（含零金额、授权不足、余额不足、重复托管拒绝，触发 `Deposited`） ~30min

### 功能 3: 结算与退款

- [x] T-003: 实现一次性 `release()`，以及多 Agent 的 `releaseMilestone()`/`finalize()`（权限、防重入、累计释放和余额退款） ~30min
- [x] T-004: 实现 `refund()`（权限、防重入、终态迁移；部分里程碑已释放时只退剩余余额） ~30min

### 功能 4: 权限与暂停

- [x] T-005: 接入 AccessControl 角色（`OPERATOR_ROLE`/`PAUSER_ROLE`/`[v3 新增]` `TREASURY_ROLE`）与 Pausable 机制（触发 `Paused`/`Unpaused`）；实现 `setFeeReceiver()`（`[v3 修改]` 权限从 `PAUSER_ROLE` 改为 `TREASURY_ROLE`，触发 `FeeReceiverUpdated`） ~30min

### 集成与测试

- [x] T-006: 编写单元测试：正常路径、授权/余额不足、权限、暂停、金额守恒、多个里程碑累计上限、最终余额退款、部分释放后退款与终态防重放；非 `TREASURY_ROLE` 无法调用 `setFeeReceiver()` ~30min
- [x] T-007: 编写重入攻击模拟测试（恶意支付 Token 在转账期间回调资金终态） ~30min
- [ ] T-008: 使用目标测试网官方 USDC 地址部署合约，输出合约/USDC 地址与 ABI 供 [[6.escrow-sync-and-wallet]] 使用，并核对 `paymentToken()` ~30min

> 2026-08-30：部署脚本已要求 `ESCROW_PAYMENT_TOKEN`，合约 14/14 测试通过；新 USDC
> 合约尚未部署公共测试网，因此 T-008 按真实外部验收状态保持未勾选。

## 依赖关系

- T-002 依赖 T-001
- T-003、T-004 依赖 T-002、T-005
- T-006、T-007 依赖 T-002、T-003、T-004、T-005
- T-008 依赖 T-006（内部测试通过后再部署到测试网）

## 风险点

- 独立第三方安全审计未包含在本任务清单内（PRD 要求上线前完成），需在项目里程碑层面单独排期，不得以本 feature 任务全部完成为由跳过审计。
- 手续费费率与承担方已确认（见 requirements.md），`feeAmount` 由调用方（链下 [[4.task-creation-and-preview]] 的 `CalculatePlatformFee()`）传入，链下校验测试属于 [[6.escrow-sync-and-wallet]] 范围，不在本 feature 任务内。
