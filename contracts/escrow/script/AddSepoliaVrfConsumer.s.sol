// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";

interface IVRFConsumerCoordinator {
    function addConsumer(uint256 subscriptionId, address consumer) external;
}

/**
 * @notice 将已部署的 ArbitrationCases 注册为项目 VRF subscription 的 consumer。
 * @dev 仅 subscription owner 可执行。consumer 必须已有链上代码，防止将拼写错误或
 * 模拟地址永久写入订阅；执行后仍以 getSubscription 返回列表作为验收依据。
 */
contract AddSepoliaVrfConsumer is Script {
    function run() external {
        require(block.chainid == 11155111, "SEPOLIA_ONLY");
        address coordinator = vm.envAddress("CHAINLINK_VRF_COORDINATOR");
        uint256 subscriptionId = vm.envUint("CHAINLINK_VRF_SUBSCRIPTION_ID");
        address consumer = vm.envAddress("ARBITRATION_CASES_CONTRACT_ADDRESS");
        require(coordinator.code.length > 0 && subscriptionId > 0 && consumer.code.length > 0, "VRF_CONSUMER_REQUIRED");

        vm.startBroadcast();
        IVRFConsumerCoordinator(coordinator).addConsumer(subscriptionId, consumer);
        vm.stopBroadcast();
    }
}
