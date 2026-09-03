// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @notice 仅供 AICP 本地 Anvil 使用的 YD 测试代币。
 * @dev Sepolia 和正式网络必须注入 yd-web3-university 已确认部署的 YD 地址；本合约的
 *      无权限 mint 只能存在于本地开发部署路径，不能作为公共网络资产。
 */
contract TestYD is ERC20 {
    constructor() ERC20("Local YD Token", "YD") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}
