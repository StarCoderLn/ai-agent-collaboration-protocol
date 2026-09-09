// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";

interface IVRFSubscriptionCoordinator {
    function createSubscription() external returns (uint256 subscriptionId);
}

/**
 * @notice 由项目 admin 在 Sepolia 创建独立的 Chainlink VRF v2.5 subscription。
 * @dev 本阶段只创建订阅，不充值也不添加 consumer。订阅编号必须从成功回执的
 * SubscriptionCreated 事件核对后再写入配置，禁止把本地模拟返回值当成链上事实。
 */
contract CreateSepoliaVrfSubscription is Script {
    function run() external returns (uint256 subscriptionId) {
        require(block.chainid == 11155111, "SEPOLIA_ONLY");
        address coordinator = vm.envAddress("CHAINLINK_VRF_COORDINATOR");
        require(coordinator.code.length > 0, "VRF_COORDINATOR_REQUIRED");

        vm.startBroadcast();
        subscriptionId = IVRFSubscriptionCoordinator(coordinator).createSubscription();
        vm.stopBroadcast();

        console2.log("VRF subscription simulation result", subscriptionId);
    }
}
