// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AICP 托管合约
 * @notice 为一个链下 taskId 锁定部署时指定的 USDC，并由受限角色执行验收结算或退款。
 * @dev 每次部署只绑定一个支付代币，调用者不能自行传入 Token 地址，避免任务资金混用。
 *      业务验收、争议与手续费公式位于链下；合约只负责金额守恒、权限、终态和重入保护。
 */
contract Escrow is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");

    enum EscrowState {
        None,
        Deposited,
        Released,
        Refunded
    }

    struct EscrowRecord {
        address payer;
        uint256 amount;
        uint256 releasedAmount;
        EscrowState state;
    }

    mapping(bytes32 taskId => EscrowRecord) private escrows;
    IERC20 public immutable paymentToken;
    address public feeReceiver;

    error InvalidAddress();
    error InvalidAmount();
    error EscrowAlreadyExists(bytes32 taskId);
    error EscrowNotDeposited(bytes32 taskId);
    error TokenAmountMismatch(uint256 expectedAmount, uint256 receivedAmount);

    event Deposited(bytes32 indexed taskId, address indexed payer, uint256 amount);
    event Released(
        bytes32 indexed taskId,
        address indexed payee,
        uint256 escrowAmount,
        uint256 agentGrossAmount,
        uint256 feeAmount,
        uint256 payerRefundAmount
    );
    event MilestoneReleased(
        bytes32 indexed taskId,
        address indexed payee,
        uint256 escrowAmount,
        uint256 milestoneGrossAmount,
        uint256 feeAmount,
        uint256 totalReleasedAmount,
        uint256 remainingAmount
    );
    event Finalized(
        bytes32 indexed taskId,
        address indexed payer,
        uint256 escrowAmount,
        uint256 releasedAmount,
        uint256 payerRefundAmount
    );
    event Refunded(
        bytes32 indexed taskId,
        address indexed payer,
        uint256 escrowAmount,
        uint256 releasedAmount,
        uint256 payerRefundAmount
    );
    event FeeReceiverUpdated(address indexed oldReceiver, address indexed newReceiver);

    constructor(
        address admin,
        address operator,
        address pauser,
        address treasury,
        address initialFeeReceiver,
        address initialPaymentToken
    ) {
        if (
            admin == address(0) || operator == address(0) || pauser == address(0) || treasury == address(0)
                || initialFeeReceiver == address(0) || initialPaymentToken == address(0)
        ) revert InvalidAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, operator);
        _grantRole(PAUSER_ROLE, pauser);
        _grantRole(TREASURY_ROLE, treasury);
        feeReceiver = initialFeeReceiver;
        paymentToken = IERC20(initialPaymentToken);
    }

    function deposit(bytes32 taskId, uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (escrows[taskId].state != EscrowState.None) revert EscrowAlreadyExists(taskId);

        // 先写入状态再调用外部 Token 合约，失败时整笔交易会自动回滚。余额差校验拒绝
        // 扣税/通缩代币，确保账面托管额始终等于合约实际收到的 USDC。
        escrows[taskId] =
            EscrowRecord({payer: msg.sender, amount: amount, releasedAmount: 0, state: EscrowState.Deposited});
        uint256 balanceBefore = paymentToken.balanceOf(address(this));
        paymentToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 receivedAmount = paymentToken.balanceOf(address(this)) - balanceBefore;
        if (receivedAmount != amount) revert TokenAmountMismatch(amount, receivedAmount);
        emit Deposited(taskId, msg.sender, amount);
    }

    function release(bytes32 taskId, address payee, uint256 agentGrossAmount, uint256 feeAmount)
        external
        onlyRole(OPERATOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        EscrowRecord storage record = escrows[taskId];
        if (record.state != EscrowState.Deposited) revert EscrowNotDeposited(taskId);
        if (payee == address(0)) revert InvalidAddress();
        // 任务按预算上限托管，但 Agent 可以用更低报价成交。合约必须同时限制成交额和
        // 手续费，避免链下错误参数多付给 Agent，或把手续费转嫁给发布者。
        uint256 remainingAmount = record.amount - record.releasedAmount;
        if (agentGrossAmount > remainingAmount || feeAmount > agentGrossAmount) revert InvalidAmount();

        // Effects 在任何外部调用之前完成；即使接收方回调，终态与 nonReentrant 都会阻止重复结算。
        uint256 escrowAmount = record.amount;
        record.releasedAmount += agentGrossAmount;
        record.state = EscrowState.Released;

        uint256 payeeAmount = agentGrossAmount - feeAmount;
        uint256 payerRefundAmount = remainingAmount - agentGrossAmount;
        if (payeeAmount > 0) paymentToken.safeTransfer(payee, payeeAmount);
        if (feeAmount > 0) paymentToken.safeTransfer(feeReceiver, feeAmount);
        if (payerRefundAmount > 0) paymentToken.safeTransfer(record.payer, payerRefundAmount);
        emit Released(taskId, payee, escrowAmount, agentGrossAmount, feeAmount, payerRefundAmount);
    }

    /**
     * @notice 验收一个里程碑后只释放该节点成交金额，任务其余预算继续留在托管中。
     * @dev 已释放金额只增不减；后续节点失败时 refund 只能退还余额，不能追回已验收节点收入。
     */
    function releaseMilestone(bytes32 taskId, address payee, uint256 agentGrossAmount, uint256 feeAmount)
        external
        onlyRole(OPERATOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        EscrowRecord storage record = escrows[taskId];
        if (record.state != EscrowState.Deposited) revert EscrowNotDeposited(taskId);
        if (payee == address(0)) revert InvalidAddress();
        uint256 remainingAmount = record.amount - record.releasedAmount;
        if (agentGrossAmount == 0 || agentGrossAmount > remainingAmount || feeAmount > agentGrossAmount) {
            revert InvalidAmount();
        }

        // 先记账再调用外部 Token；任何转账失败都会回滚 releasedAmount，保持金额守恒。
        record.releasedAmount += agentGrossAmount;
        uint256 payeeAmount = agentGrossAmount - feeAmount;
        if (payeeAmount > 0) paymentToken.safeTransfer(payee, payeeAmount);
        if (feeAmount > 0) paymentToken.safeTransfer(feeReceiver, feeAmount);
        emit MilestoneReleased(
            taskId,
            payee,
            record.amount,
            agentGrossAmount,
            feeAmount,
            record.releasedAmount,
            record.amount - record.releasedAmount
        );
    }

    /**
     * @notice 所有计划节点完成后关闭托管，并把未成交或拆分取整产生的余额退给发布者。
     */
    function finalize(bytes32 taskId) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
        EscrowRecord storage record = escrows[taskId];
        if (record.state != EscrowState.Deposited) revert EscrowNotDeposited(taskId);
        uint256 payerRefundAmount = record.amount - record.releasedAmount;
        record.state = EscrowState.Released;
        if (payerRefundAmount > 0) paymentToken.safeTransfer(record.payer, payerRefundAmount);
        emit Finalized(taskId, record.payer, record.amount, record.releasedAmount, payerRefundAmount);
    }

    function refund(bytes32 taskId) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
        EscrowRecord storage record = escrows[taskId];
        if (record.state != EscrowState.Deposited) revert EscrowNotDeposited(taskId);
        address payer = record.payer;
        uint256 payerRefundAmount = record.amount - record.releasedAmount;
        record.state = EscrowState.Refunded;
        if (payerRefundAmount > 0) paymentToken.safeTransfer(payer, payerRefundAmount);
        emit Refunded(taskId, payer, record.amount, record.releasedAmount, payerRefundAmount);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function setFeeReceiver(address newReceiver) external onlyRole(TREASURY_ROLE) {
        if (newReceiver == address(0)) revert InvalidAddress();
        address oldReceiver = feeReceiver;
        feeReceiver = newReceiver;
        emit FeeReceiverUpdated(oldReceiver, newReceiver);
    }

    function escrowOf(bytes32 taskId) external view returns (EscrowRecord memory) {
        return escrows[taskId];
    }
}
