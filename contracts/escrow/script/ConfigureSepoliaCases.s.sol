// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArbitrationCases} from "../src/ArbitrationCases.sol";
import {ArbitrationRewards} from "../src/ArbitrationRewards.sol";

/**
 * @notice 为 Sepolia 演示启用已确认的 10 YD 投票奖励，并预充值独立奖励池。
 * @dev 申诉保证金使用 1 USDC、服务费 0.1 USDC且保证金始终退还，避免测试参与者因演示
 * 结论损失资产。参数只影响新案件；脚本要求管理员实际持有并批准足额 YD。
 */
contract ConfigureSepoliaCases is Script {
    function run() external {
        require(block.chainid == 11155111, "SEPOLIA_ONLY");
        ArbitrationCases court = ArbitrationCases(vm.envAddress("ARBITRATION_CASES_CONTRACT_ADDRESS"));
        ArbitrationRewards rewards = ArbitrationRewards(address(court.rewards()));
        address awardOperator = vm.envAddress("DAO_REWARD_AWARD_OPERATOR_ADDRESS");
        uint256 funding = vm.envUint("DAO_REWARD_INITIAL_FUNDING_MINOR");
        require(awardOperator != address(0), "INVALID_REWARD_CONFIG");

        vm.startBroadcast();
        court.configureTerms(
            ArbitrationCases.Terms({
                rewardPerVote: 10 ether,
                appealBond: 1_000_000,
                appealFee: 100_000,
                bondPolicy: ArbitrationCases.BondPolicy.ReturnAlways
            })
        );
        rewards.grantRole(rewards.AWARD_ROLE(), awardOperator);
        if (funding > 0) {
            IERC20(rewards.ydToken()).approve(address(rewards), funding);
            rewards.fund(funding);
        }
        // 单案最多预留 3 + 5 票；复用旧池时只核对可用余额，不要求重复充值 500 YD。
        require(rewards.available() >= 80 ether, "REWARD_POOL_TOO_LOW");
        vm.stopBroadcast();
    }
}
