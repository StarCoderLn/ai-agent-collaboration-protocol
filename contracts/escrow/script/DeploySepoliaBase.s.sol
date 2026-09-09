// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {ArbitrationDAO} from "../src/ArbitrationDAO.sol";
import {Escrow} from "../src/Escrow.sol";

/**
 * @notice 部署 Sepolia 的成员质押与 USDC 托管基础合约，案件合约在 VRF 订阅就绪后另行部署。
 * @dev 管理员不兼任资金执行 operator；测试网使用 100 YD 门槛和 7 天退出冷静期。
 * 脚本不转移用户资产、不铸币，也不创建 VRF 订阅；不带 --broadcast 时仅模拟。
 */
contract DeploySepoliaBase is Script {
    function run() external returns (ArbitrationDAO membership, Escrow escrow) {
        require(block.chainid == 11155111, "SEPOLIA_ONLY");
        address admin = vm.envAddress("DAO_CASE_ADMIN");
        address operator = vm.envAddress("ESCROW_OPERATOR_ADDRESS");
        address yd = vm.envAddress("ARBITRATION_DAO_YD_TOKEN_ADDRESS");
        address usdc = vm.envAddress("ESCROW_PAYMENT_TOKEN_ADDRESS");
        require(admin != address(0) && operator != address(0), "ROLE_REQUIRED");
        require(admin != operator && yd.code.length > 0 && usdc.code.length > 0, "INVALID_BASE_CONFIG");

        vm.startBroadcast();
        membership = new ArbitrationDAO(admin, admin, admin, yd, 100 ether, 7 days);
        escrow = new Escrow(admin, operator, admin, admin, admin, usdc);
        vm.stopBroadcast();

        console2.log("ArbitrationDAO", address(membership));
        console2.log("Escrow", address(escrow));
    }
}
