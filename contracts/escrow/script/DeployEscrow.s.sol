// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {Escrow} from "../src/Escrow.sol";

contract DeployEscrow is Script {
    function run() external returns (Escrow deployed) {
        address admin = vm.envAddress("ESCROW_ADMIN");
        address operator = vm.envAddress("ESCROW_OPERATOR");
        address pauser = vm.envAddress("ESCROW_PAUSER");
        address treasury = vm.envAddress("ESCROW_TREASURY");
        address feeReceiver = vm.envAddress("ESCROW_FEE_RECEIVER");
        vm.startBroadcast();
        deployed = new Escrow(admin, operator, pauser, treasury, feeReceiver);
        vm.stopBroadcast();
        console2.log("ESCROW_CONTRACT_ADDRESS", address(deployed));
        console2.log("ABI artifact: out/Escrow.sol/Escrow.json");
    }
}
