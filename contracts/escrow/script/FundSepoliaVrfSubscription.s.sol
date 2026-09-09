// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";

interface IVRFNativeFundingCoordinator {
    function fundSubscriptionWithNative(uint256 subscriptionId) external payable;
}

/**
 * @notice 使用 Sepolia ETH 为已经由 admin 持有的 VRF v2.5 subscription 充值。
 * @dev 订阅编号必须先由创建交易的成功回执确认；充值额从环境显式读取，脚本不猜测
 * 主网成本或自动追加资金。充值后仍需用 getSubscription 核对 native balance。
 */
contract FundSepoliaVrfSubscription is Script {
    function run() external {
        require(block.chainid == 11155111, "SEPOLIA_ONLY");
        address coordinator = vm.envAddress("CHAINLINK_VRF_COORDINATOR");
        uint256 subscriptionId = vm.envUint("CHAINLINK_VRF_SUBSCRIPTION_ID");
        uint256 amount = vm.envUint("CHAINLINK_VRF_NATIVE_FUNDING_WEI");
        require(coordinator.code.length > 0 && subscriptionId > 0 && amount > 0, "VRF_FUNDING_REQUIRED");

        vm.startBroadcast();
        IVRFNativeFundingCoordinator(coordinator).fundSubscriptionWithNative{value: amount}(subscriptionId);
        vm.stopBroadcast();
    }
}
