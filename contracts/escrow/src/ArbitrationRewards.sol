// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @notice 与任务 USDC 托管、成员 YD 质押彻底分离的仲裁奖励金库。
 * @dev YD 先充值、再按案件预留，最后产生固定收款人的待发奖励；后台单独付费广播发放。
 * 活动/完成任务奖励必须有唯一业务凭证和授权分配者，不存在按钱包直接领取新手币入口。
 * 本合约不铸币，不接管成员质押，所有额度均以代币最小单位整数表示。
 */
contract ArbitrationRewards is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant CASE_ROLE = keccak256("CASE_ROLE");
    bytes32 public constant AWARD_ROLE = keccak256("AWARD_ROLE");
    IERC20 public immutable ydToken;
    uint256 public available;
    uint256 public reserved;
    uint256 public owed;
    mapping(bytes32 reservationId => uint256 amount) public reservations;
    mapping(bytes32 reservationId => bool used) private usedReservations;
    mapping(bytes32 awardId => bool used) public awarded;
    mapping(address recipient => uint256 amount) public claimable;
    enum RewardKind {
        Arbitration,
        Task,
        Activity
    }
    mapping(bytes32 sourceId => mapping(address recipient => uint256 amount)) public credits;
    mapping(bytes32 sourceId => mapping(address recipient => uint256 amount)) public paidRewards;

    error InvalidInput();
    error InsufficientPool();
    event Funded(address indexed funder, uint256 amount);
    event Reserved(bytes32 indexed reservationId, uint256 amount);
    event RewardAllocated(bytes32 indexed sourceId, address indexed recipient, uint256 amount, RewardKind kind);
    event ReservationClosed(bytes32 indexed reservationId, uint256 returnedAmount);
    event RewardPaid(bytes32 indexed sourceId, address indexed recipient, uint256 amount);

    constructor(address admin, address token) {
        if (admin == address(0) || token.code.length == 0) revert InvalidInput();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        ydToken = IERC20(token);
    }

    /// @notice 任何人均可为独立奖励池充值；仅实际到账额计入可分配余额，拒绝扣税代币。
    function fund(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidInput();
        uint256 beforeBalance = ydToken.balanceOf(address(this));
        ydToken.safeTransferFrom(msg.sender, address(this), amount);
        if (ydToken.balanceOf(address(this)) - beforeBalance != amount) revert InvalidInput();
        available += amount;
        emit Funded(msg.sender, amount);
    }

    /// @notice 接案前锁定整轮最大奖励，禁止先让成员工作、到兑现时才发现池子没有钱。
    function reserve(bytes32 id, uint256 amount) external onlyRole(CASE_ROLE) {
        if (id == bytes32(0) || amount == 0 || usedReservations[id]) revert InvalidInput();
        if (available < amount) revert InsufficientPool();
        usedReservations[id] = true;
        reservations[id] = amount;
        available -= amount;
        reserved += amount;
        emit Reserved(id, amount);
    }

    /// @notice 案件合约按实际有效参与者发奖；未投票者没有奖励，多数/少数意见不影响参与奖励。
    function allocate(bytes32 id, address recipient, uint256 amount) external onlyRole(CASE_ROLE) {
        if (recipient == address(0) || amount == 0 || reservations[id] < amount) revert InvalidInput();
        reservations[id] -= amount;
        reserved -= amount;
        _credit(id, recipient, amount, RewardKind.Arbitration);
    }

    /// @notice 轮次关闭后回收未使用预留；领取账户中的已赚取奖励不会被回收。
    function close(bytes32 id) external onlyRole(CASE_ROLE) {
        uint256 amount = reservations[id];
        reservations[id] = 0;
        reserved -= amount;
        available += amount;
        emit ReservationClosed(id, amount);
    }

    /// @notice 业务凭证只可使用一次；旧版仲裁票也由授权边界迁移发放，不接受用户自报完成。
    function award(bytes32 awardId, address recipient, uint256 amount, RewardKind kind) external onlyRole(AWARD_ROLE) {
        if (awardId == bytes32(0) || awarded[awardId] || recipient == address(0) || amount == 0) revert InvalidInput();
        if (available < amount) revert InsufficientPool();
        awarded[awardId] = true;
        available -= amount;
        _credit(awardId, recipient, amount, kind);
    }

    /**
     * @notice 后台代付 Gas，将已记账奖励自动转给固定受益人，用户不需要签名领取。
     * @dev 任何人可代为推进，但不能选择金额或改收款人；重复调用已支付奖励是无副作用的。
     * 单笔失败仅回滚该奖励，不影响已经计票的仲裁。先更新账本再转账，拒绝重入重复付款。
     */
    function payReward(bytes32 sourceId, address recipient) external nonReentrant {
        uint256 amount = credits[sourceId][recipient];
        if (amount == 0) return;
        credits[sourceId][recipient] = 0;
        paidRewards[sourceId][recipient] = amount;
        claimable[recipient] -= amount;
        owed -= amount;
        ydToken.safeTransfer(recipient, amount);
        emit RewardPaid(sourceId, recipient, amount);
    }

    /// @dev 统一增加应付账，保持 available + reserved + owed 不超过实际 YD 余额。
    function _credit(bytes32 sourceId, address recipient, uint256 amount, RewardKind kind) private {
        // 一个业务凭证对同一受益人只可记账一次，即使已支付也不能再次复用，便于跨服务去重。
        if (credits[sourceId][recipient] != 0 || paidRewards[sourceId][recipient] != 0) revert InvalidInput();
        credits[sourceId][recipient] = amount;
        claimable[recipient] += amount;
        owed += amount;
        emit RewardAllocated(sourceId, recipient, amount, kind);
    }
}
