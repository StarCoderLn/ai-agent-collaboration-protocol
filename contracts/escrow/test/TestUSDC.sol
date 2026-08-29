// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Escrow} from "../src/Escrow.sol";

/**
 * @notice 仅供合约测试使用的 6 位精度 USDC 替身。
 * @dev 可选的重入钩子模拟不可信 ERC-20 在转账期间回调 Escrow；正式部署必须传入
 *      目标网络配置中经过核对的官方 USDC 地址，而不是部署本测试合约。
 */
contract TestUSDC is ERC20 {
    Escrow private reentryTarget;
    bytes32 private reentryTaskId;
    bool private reentryEnabled;

    constructor() ERC20("Test USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function configureReentry(Escrow target, bytes32 taskId) external {
        reentryTarget = target;
        reentryTaskId = taskId;
        reentryEnabled = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (reentryEnabled && from == address(reentryTarget)) {
            reentryEnabled = false;
            reentryTarget.refund(reentryTaskId);
        }
    }
}
