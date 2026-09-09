// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {ArbitrationDAO} from "../src/ArbitrationDAO.sol";
import {ArbitrationCases} from "../src/ArbitrationCases.sol";
import {ArbitrationRewards} from "../src/ArbitrationRewards.sol";
import {CaseVrfCoordinatorTestDouble} from "../test/ArbitrationCases.t.sol";

/**
 * @notice 仅在本地链为自动发奖验收部署目录与独立奖励池，不切换现有任务的仲裁合约。
 * @dev 使用实际 Cases/Rewards 字节码，但 VRF 是明确的测试替身；不得用于 Sepolia 或正式网络。
 * 不绑定旧 Escrow、不改成员质押、不配置奖励/申诉金额、不铸币充值；运行模拟不产生外部写入，
 * 只有显式 --broadcast 才部署。部署交易凭证由 Foundry 的 broadcast 目录保存。
 */
contract DeployLocalRewards is Script {
    function run() external returns (ArbitrationCases court, ArbitrationRewards rewards) {
        require(block.chainid == 31337, "LOCAL_CHAIN_ONLY");
        address admin = vm.envAddress("LOCAL_REWARD_ADMIN");
        address membershipAddress = vm.envAddress("ARBITRATION_DAO_CONTRACT_ADDRESS");
        address usdc = vm.envAddress("ESCROW_PAYMENT_TOKEN_ADDRESS");
        require(
            admin != address(0) && membershipAddress.code.length > 0 && usdc.code.length > 0, "INVALID_LOCAL_DIRECTORY"
        );
        address yd = address(ArbitrationDAO(membershipAddress).ydToken());

        vm.startBroadcast(admin);
        CaseVrfCoordinatorTestDouble coordinator = new CaseVrfCoordinatorTestDouble();
        rewards = new ArbitrationRewards(admin, yd);
        court = new ArbitrationCases(
            admin,
            membershipAddress,
            address(rewards),
            usdc,
            address(coordinator),
            admin,
            ArbitrationCases.VrfConfig(keccak256("local-only-key-hash"), 42, 3, 200_000, false),
            // 条款仍未启用；这些仅是本地消费端的部署参数，不代表已确认的产品窗口。
            ArbitrationCases.TimingConfig(1 days, 3 days, 2 days, 1 days, 10 days, 0)
        );
        rewards.grantRole(rewards.CASE_ROLE(), address(court));
        rewards.grantRole(rewards.AWARD_ROLE(), admin);
        vm.stopBroadcast();

        console2.log("Local VRF test double", address(coordinator));
        console2.log("Reward directory (not active arbitration)", address(court));
        console2.log("ArbitrationRewards", address(rewards));
    }
}
