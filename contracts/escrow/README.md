# AICP USDC Escrow

Feature 5 的 Foundry + OpenZeppelin 托管合约。每次部署固定绑定一个 USDC 合约地址，
任务发布者先授权精确任务金额，再由 `deposit(taskId, amount)` 拉取资金。ETH 不属于业务
结算资产，只用于所在 EVM 网络的 Gas。单 Agent 历史任务用 `release()` 一次结算；正式
多 Agent 工作流在全部阶段完成并由发布者最终验收后，通过 `settleWorkflow()` 一笔交易
原子支付所有 Agent、平台费并退还未使用预算。争议全额退款用 `refundDispute()` 将裁决
和证据摘要锚定链上。`releaseMilestone()` / `finalize()` 只为迁移前任务恢复保留，不再由
新流程调用。暂停、自动结算和手续费收款配置分别由三个独立角色控制，避免一把密钥同时
拥有全部资金权限。

首次构建前安装锁定版本的依赖。`--no-git` 避免依赖仓库污染父项目的 Git 状态；
`lib/`、编译产物、缓存和广播记录均按约定忽略。

```bash
forge install OpenZeppelin/openzeppelin-contracts@v5.7.0 --no-git
forge install foundry-rs/forge-std@v1.16.2 --no-git
```

```bash
forge test
forge script script/DeployEscrow.s.sol:DeployEscrow --rpc-url sepolia --broadcast
```

Escrow 部署脚本读取 `ESCROW_ADMIN`、`ESCROW_OPERATOR`、`ESCROW_PAUSER`、`ESCROW_TREASURY`、
`ESCROW_FEE_RECEIVER` 和 `ESCROW_PAYMENT_TOKEN`。最后一项必须是目标网络核对过的官方
USDC 地址；本地 Anvil 才使用测试 USDC。脚本会输出部署地址，ABI 生成于
`out/Escrow.sol/Escrow.json`。仓库中禁止保存 operator 明文私钥；生产签名必须使用
Feature 5/6 约定的 KMS/HSM 边界。

DAO 仲裁使用独立 `ArbitrationDAO`：用户质押 YD 后获得候选资格，申请退出即停止进入
新案件，冷静期结束才能领取。公共测试网部署应绑定已有的产品 YD 合约；`TestYD` 只用于
Anvil 和 Foundry 验收，不能作为钱包资产目录里的产品 YD。业务层负责隐私证据、利益冲突
分案和投票，合约不公开任务正文。

## DAO 仲裁升级状态（2026-09-10）

新增独立 `ArbitrationCases`、Chainlink VRF v2.5 消费端和 `ArbitrationRewards`。
当前合约测试通过，本地独立奖励池与目录已完成实际付款验证；新版 DAO、Escrow、案件和奖励合约已在 Sepolia 启用，VRF subscription 已充值并注册 consumer，8 个创始钱包已各质押 100 YD。真实案件已经完成 VRF、首审、钱包付费申诉、终审、最终结算、异常恢复和保证金领取闭环；旧部署案件与本地成员质押不迁移。
启用条件、部署脚本与未完成项见 [独立链上仲裁](../../docs/dao-chain-arbitration.md)。

YD 奖励由独立池 `payReward(sourceId,recipient)` 自动支付，金额与受益人在记账时固定；
平台 operator 承担 Gas，用户无需领取签名。`RewardPaid` 确认后才发站内到账通知。
任务/活动 `award` 必须带来源分类且由授权角色核验业务资格，不是公开免费领币入口。

`script/DeployLocalRewards.s.sol` 仅允许链 31337，为独立奖励体验部署实际奖励合约和未启用条款的案件目录；VRF 使用明确测试替身，不是 Chainlink 真实证明。脚本不绑定旧 Escrow、不铸币或配置产品费率；广播前必须先模拟并取得本地部署授权。
