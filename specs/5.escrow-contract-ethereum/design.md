# Ethereum 托管合约 — 技术设计

## 设计版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始设计 |
| 2026-08-20 | v2   | 明确 `release()` 的转账拆分逻辑与 `feeReceiver` 地址管理（手续费由 Agent 提供者承担已确认） |
| 2026-08-20 | v3   | 拆分 `TREASURY_ROLE`（原 `setFeeReceiver()` 挂在 `PAUSER_ROLE` 下不合理，两者风险等级不同）；明确三个角色各自的密钥托管方式 |
| 2026-08-20 | v4   | 模块 3 补充多签签名人数量的分级参考表（按托管资金规模，参考 Aave 等协议实践），完整表格见 requirements.md 开放问题 |
| 2026-08-23 | v5   | `release()` 增加实际成交额参数，将未使用的预算上限差额退回发布者，修复链上与链下结算不一致 |
| 2026-08-27 | v6   | 业务资金统一为 USDC；部署时固定支付代币，存款改为精确金额 `transferFrom`，ETH 仅保留为 Gas |
| 2026-08-30 | v7   | 扩展累计释放账本，支持工作流节点里程碑结算、最终余额退款和部分释放后的剩余退款 |

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 智能合约（Solidity + Hardhat/Foundry）

## 功能模块设计

### 模块 1: 托管核心存储与存款

**涉及层及关键设计:**

- `mapping(bytes32 taskId => EscrowRecord)`，记录 `payer`、原托管 `amount`、累计
  `releasedAmount` 与 `state`；累计值让多个里程碑共享一笔托管而不创建链上子账户。
- `taskId` 由链下（feature 4 的任务 ID）派生的确定性哈希，保证链上链下一一对应，不引入自增 ID 的链下链上双写同步问题。
- 合约构造时固定一个 `paymentToken`，调用方不能在每次存款时自选 Token 地址，避免
  混币和恶意代币注入。存款函数校验 `state == None` 与 `amount > 0`，再通过
  `transferFrom` 拉取发布者已经精确授权的 USDC。
- 存款前后检查合约 USDC 余额差必须等于声明金额，拒绝扣税/通缩代币导致账面金额
  大于实际到账金额；失败时整笔交易回滚，不留下半完成托管记录。

### 模块 2: 结算与退款

**涉及层及关键设计:**

- `release()`、`releaseMilestone()`、`finalize()` 与 `refund()` 均要求 `OPERATOR_ROLE` 且 `state == Deposited`。一次性 `release()`、最终 `finalize()` 和 `refund()` 写入终态；`releaseMilestone()` 只增加 `releasedAmount`，保持托管打开供后续节点使用。
- `[v5]` `release()` 的转账拆分：`payee` 收到 `agentGrossAmount - feeAmount`，`feeReceiver` 收到 `feeAmount`，发布者收到 `escrowAmount - agentGrossAmount`。任务按预算上限托管但允许 Agent 以较低报价成交，因此不能把整笔托管额都视为 Agent 应得金额。合约强制 `agentGrossAmount <= escrowAmount`、`feeAmount <= agentGrossAmount`，三笔之和严格等于托管额。
- `[v7]` `releaseMilestone()` 强制节点成交额大于零且不超过 `amount - releasedAmount`，只向 Agent 与平台转账；`finalize()` 在全部节点完成后把 `amount - releasedAmount` 退给发布者。任一节点失败时 `refund()` 使用同一剩余金额公式，已验收里程碑不会被追回。
- `[v3]` `feeReceiver` 由专设的 `TREASURY_ROLE`（不是 `PAUSER_ROLE`）更新，不是部署时写死的常量，允许平台后续更换收款地址而不需要合约升级——见模块 3 关于为什么这条不能跟暂停权限共用。
- 遵循 checks-effects-interactions：先校验状态、更新状态变量，再执行外部转账调用；引入 OpenZeppelin `ReentrancyGuard`。

### 模块 3: 暂停与权限 `[v3 重新设计]`

**涉及层及关键设计:**

三个角色按风险等级和响应速度需求分开，不是简单"能拆就拆"，而是每个角色对应一种不同的运维模式：

- **`PAUSER_ROLE`**（`pause()`/`unpause()`）：职责严格限制在"暂停/恢复"，不承担任何资金或配置变更权限——参考行业惯例，应急权限应被限制到最小必要动作，绝不能让"止损"这一个操作背后附带能转移资金或改配置的能力。建议由较小的多签（如 2-of-3）持有，签名人是运营/安全值班人员，优化的是**响应速度**（出现异常时要能第一时间暂停，不能被审批流程拖慢）。
- **`OPERATOR_ROLE`**（`release()`/`refund()`）：触发真实资金结算，但因为要配合自动化验收结算流程高频调用，**无法用人工多签逐笔审批**（会拖垮自动化流程）。这个角色必须是后端服务持有的"热钥匙"，缓解手段不是"不让它自动化"，而是**私钥托管方式**：用云端 KMS/HSM 签名（如 AWS KMS 的 secp256k1 支持），私钥不以明文形式落在服务器磁盘或代码里；一旦怀疑该角色的密钥被盗用，`PAUSER_ROLE` 的快速暂停是唯一的兜底止损手段——这也是模块 2/3 把"暂停"和"资金操作"分成两个角色、且暂停角色优化响应速度的核心原因。
- **`TREASURY_ROLE`**（`setFeeReceiver()`）：调用频率极低（正常运营中几乎不触发）、但影响持久（改的是未来所有手续费的流向）。建议由较大的多签（如 3-of-5）持有，不需要优化响应速度，值得更谨慎、更多人审核——不能因为"反正也是行政类操作"就跟着挂在 `PAUSER_ROLE` 下面，两者的风险特征（响应速度要求 vs 审慎程度要求）正好相反。
- 三个角色的具体多签配置、签名人名单是部署时的运维决策，不在本 feature 的合约代码范围内；合约层只需要提供三个独立、可分别转移的角色，不假设任何一个角色背后到底是 EOA 还是多签合约地址（`AccessControl` 的 `grantRole` 对地址类型无感知，多签本身也是一个地址）。
- `[v4]` 签名人数量参考行业惯例按托管资金规模（TVL）分级，完整分级表见 requirements.md 开放问题；核心原则是 `TREASURY_ROLE` 在同一资金规模档位下比 `PAUSER_ROLE` 多一档签名人数（优化审慎程度而非速度），MVP 早期（<100 万美元 TVL）建议 `PAUSER_ROLE` 3-of-5、`TREASURY_ROLE` 4-of-7 起步，资金规模增长时按表调整，不需要改合约代码。

### 模块 4: 事件

**涉及层及关键设计:**

- `event Deposited(bytes32 indexed taskId, address indexed payer, uint256 amount)`
- `event Released(bytes32 indexed taskId, address indexed payee, uint256 escrowAmount, uint256 agentGrossAmount, uint256 feeAmount, uint256 payerRefundAmount)`
- `event MilestoneReleased(bytes32 indexed taskId, address indexed payee, uint256 escrowAmount, uint256 milestoneGrossAmount, uint256 feeAmount, uint256 totalReleasedAmount, uint256 remainingAmount)`
- `event Finalized(bytes32 indexed taskId, address indexed payer, uint256 escrowAmount, uint256 releasedAmount, uint256 payerRefundAmount)`
- `event Refunded(bytes32 indexed taskId, address indexed payer, uint256 escrowAmount, uint256 releasedAmount, uint256 payerRefundAmount)`
- `event Paused(address account)` / `event Unpaused(address account)`（继承自 OpenZeppelin `Pausable`）
- 事件是 [[6.escrow-sync-and-wallet]] 链下同步的唯一事实来源，链下不允许仅依赖交易 receipt 状态推断资金结果。

## 接口契约

```solidity
function deposit(bytes32 taskId, uint256 amount) external; // amount 是 USDC 的 6 位最小单位
function release(bytes32 taskId, address payee, uint256 agentGrossAmount, uint256 feeAmount) external onlyRole(OPERATOR_ROLE);
function releaseMilestone(bytes32 taskId, address payee, uint256 agentGrossAmount, uint256 feeAmount) external onlyRole(OPERATOR_ROLE);
function finalize(bytes32 taskId) external onlyRole(OPERATOR_ROLE);
function refund(bytes32 taskId) external onlyRole(OPERATOR_ROLE);
function pause() external onlyRole(PAUSER_ROLE);
function unpause() external onlyRole(PAUSER_ROLE);
function escrowOf(bytes32 taskId) external view returns (Escrow memory);
function setFeeReceiver(address newReceiver) external onlyRole(TREASURY_ROLE); // [v3 修改：从 PAUSER_ROLE 改为独立的 TREASURY_ROLE]
function feeReceiver() external view returns (address); // [v2 新增]
function paymentToken() external view returns (IERC20); // 部署时固定的 USDC，之后不可更换
```

## 数据模型

- 链上：`mapping(bytes32 => EscrowRecord)`；记录包含 `payer`、原托管 `amount`、只增的 `releasedAmount` 与 `EscrowState { None, Deposited, Released, Refunded }`。`address public feeReceiver` 在部署时初始化，可由 `setFeeReceiver()` 更新并触发 `FeeReceiverUpdated`。
- 链下镜像表在 [[6.escrow-sync-and-wallet]] 中定义，本 feature 不涉及链下存储。

## 安全考虑

- 重入保护：`deposit`/`release`/`refund` 使用 `nonReentrant` 修饰符；即使支付代币是
  恶意实现并在转账时回调，也不能重复进入资金状态机。
- 授权策略：Web 只授权当前任务金额，不使用无限授权；合约通过 OpenZeppelin
  `SafeERC20` 兼容标准 ERC-20 返回值和失败语义。
- `[v3 修改]` 权限分离：暂停（`PAUSER_ROLE`）、资金结算（`OPERATOR_ROLE`）、手续费收款地址变更（`TREASURY_ROLE`）三类操作使用三个独立角色，不是简单两两分离——任一角色的密钥泄露，影响范围都被限制在该角色自身能做的事，不会连带影响另外两类操作。
- `[v3 新增]` 私钥托管方式按角色风险特征区分：`PAUSER_ROLE`/`TREASURY_ROLE` 用多签（阈值按响应速度需求不同：`PAUSER_ROLE` 偏小、`TREASURY_ROLE` 偏大）；`OPERATOR_ROLE` 因需要自动化高频调用，用服务持有的密钥但要求云端 KMS/HSM 托管，不落地明文私钥。具体多签人选和阈值是部署时的运维决策，不在合约代码范围内。
- 实际成交额和手续费金额由调用方（授权地址）传入而非合约内置业务公式；链下必须用验收时冻结的成交价和费率快照构造参数，合约独立校验 `agentGrossAmount <= amount - releasedAmount` 与 `feeAmount <= agentGrossAmount`。最终关闭或退款只处理剩余余额。
- 独立第三方审计是上线前置条件，本 feature 的 tasks 只覆盖内部测试，审计流程作为 PRD §13 上线验收清单项，不在本 feature 的完成标准内。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 合约可升级性 | 不可升级 + 可暂停（选中）vs 代理可升级模式 | PRD 明确标注升级权限方案待确认；不可升级合约攻击面更小、审计范围更明确，符合「不确定性较高时优先最小可逆检查」原则，待升级需求明确后可作为高影响任务单独评估 |
| 权限模型 | OpenZeppelin AccessControl 角色分离（选中）vs 单一 Owner | 单一 Owner 意味着一把密钥控制暂停和资金两类操作，角色分离降低单点故障影响范围 |
| `[v3]` 角色拆分粒度 | 三个角色 `PAUSER`/`OPERATOR`/`TREASURY`（选中）vs 两个角色（`PAUSER` 兼管 `setFeeReceiver`） | `setFeeReceiver` 影响持久（改的是未来收入流向）但调用频率极低，跟"需要快速响应"的 `PAUSER_ROLE` 风险特征相反；行业惯例（Gnosis Safe 多签实践）明确建议不同功能域用不同多签和阈值，共用会导致响应速度和审慎程度这两个互相冲突的要求压在同一把钥匙上 |
| `[v3]` `OPERATOR_ROLE` 的私钥托管 | 服务持有 + 云端 KMS/HSM 签名（选中）vs 每笔结算要求多签审批 | 每笔结算走多签会拖垮自动化验收结算流程（业务上要求接单验收后能及时结算）；KMS/HSM 托管 + `PAUSER_ROLE` 快速止损兜底，是在"能自动化"和"私钥不落地明文"之间的现实折中，不是最高安全等级但匹配 MVP 的自动化需求 |
| taskId 表示 | 链下任务 ID 派生的 `bytes32` 哈希（选中）vs 链上自增 ID | 避免链上链下 ID 双写同步和竞态，任务在链下创建时已确定唯一标识 |
