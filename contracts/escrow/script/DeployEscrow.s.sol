// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {Escrow} from "../src/Escrow.sol";

/**
 * @notice 从目标网络部署配置创建只支持单一 USDC 的 Escrow。
 * @dev ESCROW_PAYMENT_TOKEN 必须是该网络核对过的官方 USDC 地址；脚本不会部署测试
 *      Token，也不会提供部署后的换币入口，避免不同任务使用不同结算资产。
 */
contract DeployEscrow is Script {
    function run() external returns (Escrow deployed) {
        address admin = vm.envAddress("ESCROW_ADMIN");
        address operator = vm.envAddress("ESCROW_OPERATOR");
        address pauser = vm.envAddress("ESCROW_PAUSER");
        address treasury = vm.envAddress("ESCROW_TREASURY");
        address feeReceiver = vm.envAddress("ESCROW_FEE_RECEIVER");
        address paymentToken = vm.envAddress("ESCROW_PAYMENT_TOKEN");
        vm.startBroadcast();
        deployed = new Escrow(admin, operator, pauser, treasury, feeReceiver, paymentToken);
        vm.stopBroadcast();
        console2.log("ESCROW_CONTRACT_ADDRESS", address(deployed));
        console2.log("ABI artifact: out/Escrow.sol/Escrow.json");
    }
}
