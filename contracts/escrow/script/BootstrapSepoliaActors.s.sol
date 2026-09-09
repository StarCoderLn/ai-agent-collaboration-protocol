// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @notice 为项目专用 operator 与创始仲裁钱包补足 Sepolia 演示所需 Gas 和质押 YD。
 * @dev 所有转账都采用目标余额语义；脚本恢复或重跑时只补差额，不会再次发放固定数量。
 * 本阶段不代替仲裁钱包质押，后续仍需由每个钱包自行 approve 并调用 DAO stake。
 */
contract BootstrapSepoliaActors is Script {
    using SafeERC20 for IERC20;

    uint256 private constant TARGET_ETH = 0.01 ether;
    uint256 private constant TARGET_ARBITRATOR_YD = 100 ether;

    function run() external {
        require(block.chainid == 11155111, "SEPOLIA_ONLY");
        IERC20 yd = IERC20(vm.envAddress("ARBITRATION_DAO_YD_TOKEN_ADDRESS"));
        address[] memory arbitrators = vm.envAddress("DAO_FOUNDING_ARBITRATOR_ADDRESSES", ",");
        require(arbitrators.length == 8, "EIGHT_ARBITRATORS_REQUIRED");

        address[] memory actors = new address[](12);
        actors[0] = vm.envAddress("ESCROW_OPERATOR_ADDRESS");
        actors[1] = vm.envAddress("ARBITRATION_CASE_OPERATOR_ADDRESS");
        actors[2] = vm.envAddress("DAO_REWARD_OPERATOR_ADDRESS");
        actors[3] = vm.envAddress("DAO_REWARD_AWARD_OPERATOR_ADDRESS");
        for (uint256 i = 0; i < arbitrators.length; i++) {
            actors[i + 4] = arbitrators[i];
        }
        _validateDistinctWallets(actors);

        uint256 ethRequired;
        uint256 ydRequired;
        for (uint256 i = 0; i < actors.length; i++) {
            if (actors[i].balance < TARGET_ETH) ethRequired += TARGET_ETH - actors[i].balance;
        }
        for (uint256 i = 0; i < arbitrators.length; i++) {
            uint256 balance = yd.balanceOf(arbitrators[i]);
            if (balance < TARGET_ARBITRATOR_YD) ydRequired += TARGET_ARBITRATOR_YD - balance;
        }
        require(msg.sender.balance >= ethRequired + 0.005 ether, "ADMIN_ETH_RESERVE_REQUIRED");
        require(yd.balanceOf(msg.sender) >= ydRequired, "ADMIN_YD_INSUFFICIENT");

        vm.startBroadcast();
        for (uint256 i = 0; i < actors.length; i++) {
            uint256 balance = actors[i].balance;
            if (balance < TARGET_ETH) payable(actors[i]).transfer(TARGET_ETH - balance);
        }
        for (uint256 i = 0; i < arbitrators.length; i++) {
            uint256 balance = yd.balanceOf(arbitrators[i]);
            if (balance < TARGET_ARBITRATOR_YD) yd.safeTransfer(arbitrators[i], TARGET_ARBITRATOR_YD - balance);
        }
        vm.stopBroadcast();
    }

    function _validateDistinctWallets(address[] memory actors) private view {
        for (uint256 i = 0; i < actors.length; i++) {
            require(actors[i] != address(0) && actors[i].code.length == 0, "ACTOR_MUST_BE_EOA");
            for (uint256 j = 0; j < i; j++) {
                require(actors[i] != actors[j], "ACTORS_MUST_BE_DISTINCT");
            }
        }
    }
}
