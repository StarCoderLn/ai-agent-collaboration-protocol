// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArbitrationDAO} from "../src/ArbitrationDAO.sol";

/**
 * @notice 由单个创始仲裁钱包签名，将其 YD 质押补足到 DAO 当前最低门槛。
 * @dev 以链上已质押额和 allowance 为恢复依据：完成后重跑不会重复质押；若只有 approve
 * 已确认，则直接继续 stake。钱包地址由清单注入，并由外层包装器与 keystore 地址核对。
 */
contract StakeSepoliaArbitrator is Script {
    function run() external {
        require(block.chainid == 11155111, "SEPOLIA_ONLY");
        ArbitrationDAO membership = ArbitrationDAO(vm.envAddress("ARBITRATION_DAO_CONTRACT_ADDRESS"));
        address actor = vm.envAddress("SEPOLIA_ACTOR_ADDRESS");
        IERC20 yd = membership.ydToken();
        ArbitrationDAO.Membership memory current = membership.membershipOf(actor);
        uint256 minimumStake = membership.minimumStake();
        if (current.stakedAmount >= minimumStake) return;

        uint256 amount = minimumStake - current.stakedAmount;
        require(yd.balanceOf(actor) >= amount, "ARBITRATOR_YD_INSUFFICIENT");
        uint256 allowance = yd.allowance(actor, address(membership));

        vm.startBroadcast();
        if (allowance < amount) {
            if (allowance > 0) yd.approve(address(membership), 0);
            yd.approve(address(membership), amount);
        }
        membership.stake(amount);
        vm.stopBroadcast();
    }
}
