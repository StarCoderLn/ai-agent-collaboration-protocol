// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AICP 托管合约
 * @notice 为一个链下 taskId 锁定原生 ETH，并由受限角色执行验收结算或退款。
 * @dev 业务验收、争议与手续费公式位于链下；合约只负责金额守恒、权限、终态和重入保护。
 */
contract Escrow is AccessControl, Pausable, ReentrancyGuard {
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
        EscrowState state;
    }

    mapping(bytes32 taskId => EscrowRecord) private escrows;
    address public feeReceiver;

    error InvalidAddress();
    error InvalidAmount();
    error EscrowAlreadyExists(bytes32 taskId);
    error EscrowNotDeposited(bytes32 taskId);
    error TransferFailed(address recipient, uint256 amount);

    event Deposited(bytes32 indexed taskId, address indexed payer, uint256 amount);
    event Released(
        bytes32 indexed taskId,
        address indexed payee,
        uint256 escrowAmount,
        uint256 agentGrossAmount,
        uint256 feeAmount,
        uint256 payerRefundAmount
    );
    event Refunded(bytes32 indexed taskId, address indexed payer, uint256 amount);
    event FeeReceiverUpdated(address indexed oldReceiver, address indexed newReceiver);

    constructor(address admin, address operator, address pauser, address treasury, address initialFeeReceiver) {
        if (
            admin == address(0) || operator == address(0) || pauser == address(0) || treasury == address(0)
                || initialFeeReceiver == address(0)
        ) revert InvalidAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, operator);
        _grantRole(PAUSER_ROLE, pauser);
        _grantRole(TREASURY_ROLE, treasury);
        feeReceiver = initialFeeReceiver;
    }

    function deposit(bytes32 taskId) external payable whenNotPaused {
        if (msg.value == 0) revert InvalidAmount();
        if (escrows[taskId].state != EscrowState.None) revert EscrowAlreadyExists(taskId);
        escrows[taskId] = EscrowRecord({payer: msg.sender, amount: msg.value, state: EscrowState.Deposited});
        emit Deposited(taskId, msg.sender, msg.value);
    }

    function release(bytes32 taskId, address payable payee, uint256 agentGrossAmount, uint256 feeAmount)
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
        if (agentGrossAmount > record.amount || feeAmount > agentGrossAmount) revert InvalidAmount();

        // Effects 在任何外部调用之前完成；即使接收方回调，终态与 nonReentrant 都会阻止重复结算。
        uint256 escrowAmount = record.amount;
        record.state = EscrowState.Released;

        uint256 payeeAmount = agentGrossAmount - feeAmount;
        uint256 payerRefundAmount = escrowAmount - agentGrossAmount;
        if (payeeAmount > 0) _send(payee, payeeAmount);
        if (feeAmount > 0) _send(payable(feeReceiver), feeAmount);
        if (payerRefundAmount > 0) _send(payable(record.payer), payerRefundAmount);
        emit Released(taskId, payee, escrowAmount, agentGrossAmount, feeAmount, payerRefundAmount);
    }

    function refund(bytes32 taskId) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
        EscrowRecord storage record = escrows[taskId];
        if (record.state != EscrowState.Deposited) revert EscrowNotDeposited(taskId);
        address payable payer = payable(record.payer);
        uint256 amount = record.amount;
        record.state = EscrowState.Refunded;
        _send(payer, amount);
        emit Refunded(taskId, payer, amount);
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

    function _send(address payable recipient, uint256 amount) private {
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed(recipient, amount);
    }
}
