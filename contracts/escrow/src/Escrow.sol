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

    /**
     * @notice 最终验收后的单个 Agent 分账项。
     * @dev grossAmount 是发布者看到的成交额；feeAmount 从该 Agent 收入中扣除，发布者
     *      不会在托管总额之外再次付费。结构中保留毛额和费用，便于链上事件与数据库
     *      的逐阶段报价快照逐项核对，而不是只记录一个无法解释的净转账金额。
     */
    struct WorkflowPayout {
        address payee;
        uint256 grossAmount;
        uint256 feeAmount;
    }

    // 动态数组必须设置链上上限，防止异常工作流因分账项过多永久超过区块 Gas 上限。
    // 32 不是产品对 Agent 数量的展示限制；相同收款地址可在链下聚合后占用一个分账项。
    uint256 public constant MAX_WORKFLOW_PAYOUTS = 32;

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
    event WorkflowPayoutReleased(
        bytes32 indexed taskId,
        uint256 indexed payoutIndex,
        address indexed payee,
        uint256 grossAmount,
        uint256 feeAmount,
        uint256 netAmount
    );
    event WorkflowSettled(
        bytes32 indexed taskId,
        bytes32 indexed settlementManifestHash,
        bytes32 indexed evidenceRoot,
        address payer,
        uint256 escrowAmount,
        uint256 totalGrossAmount,
        uint256 totalFeeAmount,
        uint256 payerRefundAmount
    );
    event Refunded(
        bytes32 indexed taskId,
        address indexed payer,
        uint256 escrowAmount,
        uint256 releasedAmount,
        uint256 payerRefundAmount
    );
    event DisputeRefunded(
        bytes32 indexed taskId,
        bytes32 indexed decisionHash,
        bytes32 indexed evidenceRoot,
        address payer,
        uint256 escrowAmount,
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
     * @notice 全部工作流阶段完成并由发布者最终验收后，原子完成所有 Agent 分账。
     * @dev 合约先校验完整清单和金额守恒，再进入终态并执行 ERC20 转账；任一转账失败会
     *      回滚整笔交易，所以不会出现部分 Agent 已到账、任务却仍可发起资金仲裁的状态。
     *      settlementManifestHash 锚定收款清单，evidenceRoot 锚定链下交付与验收证据；
     *      完整内容不上链，以控制 Gas 并保护任务隐私。
     */
    function settleWorkflow(
        bytes32 taskId,
        WorkflowPayout[] calldata payouts,
        bytes32 settlementManifestHash,
        bytes32 evidenceRoot
    ) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
        EscrowRecord storage record = escrows[taskId];
        if (record.state != EscrowState.Deposited) revert EscrowNotDeposited(taskId);
        if (
            payouts.length == 0 || payouts.length > MAX_WORKFLOW_PAYOUTS || settlementManifestHash == bytes32(0)
                || evidenceRoot == bytes32(0)
        ) revert InvalidAmount();

        uint256 totalGrossAmount;
        uint256 totalFeeAmount;
        for (uint256 index = 0; index < payouts.length; ++index) {
            WorkflowPayout calldata payout = payouts[index];
            if (payout.payee == address(0) || payout.grossAmount == 0 || payout.feeAmount > payout.grossAmount) {
                revert InvalidAmount();
            }
            totalGrossAmount += payout.grossAmount;
            totalFeeAmount += payout.feeAmount;
        }
        if (totalGrossAmount > record.amount) revert InvalidAmount();

        // 先封闭托管状态，再调用外部 Token。SafeERC20 任一转账失败都会让状态和此前
        // 已执行的转账一起回滚，从 EVM 事务层保证“全部成功或全部失败”。
        record.releasedAmount = totalGrossAmount;
        record.state = EscrowState.Released;
        for (uint256 index = 0; index < payouts.length; ++index) {
            WorkflowPayout calldata payout = payouts[index];
            uint256 netAmount = payout.grossAmount - payout.feeAmount;
            if (netAmount > 0) paymentToken.safeTransfer(payout.payee, netAmount);
            emit WorkflowPayoutReleased(taskId, index, payout.payee, payout.grossAmount, payout.feeAmount, netAmount);
        }
        if (totalFeeAmount > 0) paymentToken.safeTransfer(feeReceiver, totalFeeAmount);
        uint256 payerRefundAmount = record.amount - totalGrossAmount;
        if (payerRefundAmount > 0) paymentToken.safeTransfer(record.payer, payerRefundAmount);
        emit WorkflowSettled(
            taskId,
            settlementManifestHash,
            evidenceRoot,
            record.payer,
            record.amount,
            totalGrossAmount,
            totalFeeAmount,
            payerRefundAmount
        );
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

    /**
     * @notice DAO 决定全额退款时，在同一笔交易中退款并锚定裁决及证据摘要。
     * @dev 新工作流在最终结算前不会有已释放里程碑，因此要求 releasedAmount 为零；这
     *      避免旧版部分付款任务被错误包装成“全额退款”并掩盖已经无法追回的资金。
     */
    function refundDispute(bytes32 taskId, bytes32 decisionHash, bytes32 evidenceRoot)
        external
        onlyRole(OPERATOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        EscrowRecord storage record = escrows[taskId];
        if (record.state != EscrowState.Deposited) revert EscrowNotDeposited(taskId);
        if (record.releasedAmount != 0 || decisionHash == bytes32(0) || evidenceRoot == bytes32(0)) {
            revert InvalidAmount();
        }
        address payer = record.payer;
        uint256 payerRefundAmount = record.amount;
        record.state = EscrowState.Refunded;
        paymentToken.safeTransfer(payer, payerRefundAmount);
        emit DisputeRefunded(taskId, decisionHash, evidenceRoot, payer, record.amount, payerRefundAmount);
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
