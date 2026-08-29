# AICP USDC Escrow

Feature 5 的 Foundry + OpenZeppelin 托管合约。每次部署固定绑定一个 USDC 合约地址，
任务发布者先授权精确任务金额，再由 `deposit(taskId, amount)` 拉取资金。ETH 不属于业务
结算资产，只用于所在 EVM 网络的 Gas。单 Agent 任务用 `release()` 一次结算；正式
多 Agent 工作流在每个节点验收后用 `releaseMilestone()` 释放成交额，全部节点完成后用
`finalize()` 退还未使用预算。暂停、自动结算和手续费收款配置分别由三个独立角色控制，
避免一把密钥同时拥有全部资金权限。

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

部署脚本读取 `ESCROW_ADMIN`、`ESCROW_OPERATOR`、`ESCROW_PAUSER`、`ESCROW_TREASURY`、
`ESCROW_FEE_RECEIVER` 和 `ESCROW_PAYMENT_TOKEN`。最后一项必须是目标网络核对过的官方
USDC 地址；本地 Anvil 才使用测试 USDC。脚本会输出部署地址，ABI 生成于
`out/Escrow.sol/Escrow.json`。仓库中禁止保存 operator 明文私钥；生产签名必须使用
Feature 5/6 约定的 KMS/HSM 边界。
