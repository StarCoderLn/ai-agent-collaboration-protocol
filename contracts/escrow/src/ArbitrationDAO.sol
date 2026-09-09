// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AICP DAO 仲裁成员质押
 * @notice 用户通过锁定 YD 获得 DAO 仲裁候选资格，退出需要等待冷静期。
 * @dev 本合约只负责成员准入与退出资金。旧版案件留在业务层，新版案件由独立
 *      ArbitrationCases 管理证据承诺、VRF 分案与投票，不把案件状态混入成员账本。
 *      这样不会把敏感任务内容公开，同时平台也不能
 *      在没有真实 YD 质押的情况下把普通钱包伪装成 DAO 仲裁员。
 */
contract ArbitrationDAO is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    struct Membership {
        uint256 stakedAmount;
        uint64 exitAvailableAt;
    }

    IERC20 public immutable ydToken;
    uint256 public minimumStake;
    uint64 public immutable exitDelay;
    mapping(address member => Membership) private memberships;

    error InvalidAddress();
    error InvalidAmount();
    error ExitNotRequested();
    error ExitDelayNotElapsed(uint64 availableAt);

    event StakeAdded(address indexed member, uint256 amount, uint256 totalStake);
    event ExitRequested(address indexed member, uint64 availableAt);
    event ExitCancelled(address indexed member);
    event StakeWithdrawn(address indexed member, uint256 amount);
    event MinimumStakeUpdated(uint256 previousAmount, uint256 newAmount);

    constructor(
        address admin,
        address config,
        address pauser,
        address initialYdToken,
        uint256 initialMinimumStake,
        uint64 initialExitDelay
    ) {
        if (admin == address(0) || config == address(0) || pauser == address(0) || initialYdToken == address(0)) {
            revert InvalidAddress();
        }
        if (initialMinimumStake == 0 || initialExitDelay == 0) revert InvalidAmount();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CONFIG_ROLE, config);
        _grantRole(PAUSER_ROLE, pauser);
        ydToken = IERC20(initialYdToken);
        minimumStake = initialMinimumStake;
        exitDelay = initialExitDelay;
    }

    /**
     * 增加质押会自动取消退出请求，避免同一钱包同时处于加入和退出两种状态。
     */
    function stake(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert InvalidAmount();
        Membership storage membership = memberships[msg.sender];
        membership.exitAvailableAt = 0;
        membership.stakedAmount += amount;
        ydToken.safeTransferFrom(msg.sender, address(this), amount);
        emit StakeAdded(msg.sender, amount, membership.stakedAmount);
    }

    /**
     * 请求退出后立即停止进入新仲裁小组，但 YD 仍锁定到冷静期结束。
     */
    function requestExit() external whenNotPaused {
        Membership storage membership = memberships[msg.sender];
        if (membership.stakedAmount == 0) revert InvalidAmount();
        uint64 availableAt = uint64(block.timestamp) + exitDelay;
        membership.exitAvailableAt = availableAt;
        emit ExitRequested(msg.sender, availableAt);
    }

    /**
     * @notice 取消尚未完成的退出请求，恢复进入新仲裁小组的资格。
     * @dev 这里只清除冷静期时间，不移动 YD；实际资格仍同时取决于当前质押是否达到门槛。
     */
    function cancelExit() external whenNotPaused {
        Membership storage membership = memberships[msg.sender];
        if (membership.exitAvailableAt == 0) revert ExitNotRequested();
        membership.exitAvailableAt = 0;
        emit ExitCancelled(msg.sender);
    }

    /**
     * @notice 冷静期结束后一次性取回当前钱包的全部 YD。
     * @dev 先删除成员状态再转账，配合 nonReentrant 保证外部代币调用不能重复领取。
     */
    function withdraw() external whenNotPaused nonReentrant {
        Membership storage membership = memberships[msg.sender];
        uint64 availableAt = membership.exitAvailableAt;
        if (availableAt == 0) revert ExitNotRequested();
        if (block.timestamp < availableAt) revert ExitDelayNotElapsed(availableAt);
        uint256 amount = membership.stakedAmount;
        delete memberships[msg.sender];
        ydToken.safeTransfer(msg.sender, amount);
        emit StakeWithdrawn(msg.sender, amount);
    }

    /**
     * @notice 调整后续资格判断使用的最低质押门槛。
     * @dev 门槛变化不会移动任何成员资金；已有成员会在下一次 isEligible 查询时按新门槛判断。
     */
    function setMinimumStake(uint256 newAmount) external onlyRole(CONFIG_ROLE) {
        if (newAmount == 0) revert InvalidAmount();
        uint256 previousAmount = minimumStake;
        minimumStake = newAmount;
        emit MinimumStakeUpdated(previousAmount, newAmount);
    }

    /**
     * 紧急暂停所有成员资金操作，已锁定的 YD 不会被管理员转移。
     */
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /**
     * 风险解除后恢复成员资金操作，仅独立暂停角色可以执行。
     */
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /**
     * 返回成员的链上质押额与退出可领取时间，供服务端按交易区块核验资格。
     */
    function membershipOf(address member) external view returns (Membership memory) {
        return memberships[member];
    }

    /**
     * 只有达到门槛且未申请退出的钱包，才可成为新案件的仲裁候选人。
     */
    function isEligible(address member) external view returns (bool) {
        Membership memory membership = memberships[member];
        return membership.stakedAmount >= minimumStake && membership.exitAvailableAt == 0;
    }
}
