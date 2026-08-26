// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../src/Escrow.sol";
import {ReentrantPayee} from "./ReentrantPayee.sol";

contract EscrowTest is Test {
    event Released(
        bytes32 indexed taskId,
        address indexed payee,
        uint256 escrowAmount,
        uint256 agentGrossAmount,
        uint256 feeAmount,
        uint256 payerRefundAmount
    );
    Escrow private escrow;
    address private admin = makeAddr("admin");
    address private operator = makeAddr("operator");
    address private pauser = makeAddr("pauser");
    address private treasury = makeAddr("treasury");
    address private feeReceiver = makeAddr("feeReceiver");
    address private payer = makeAddr("payer");
    address payable private payee = payable(makeAddr("payee"));
    bytes32 private taskId = keccak256("task-1");

    function setUp() public {
        escrow = new Escrow(admin, operator, pauser, treasury, feeReceiver);
        vm.deal(payer, 10 ether);
    }

    function testReleasePaysAgreedAmountAndRefundsUnusedBudget() public {
        vm.prank(payer);
        escrow.deposit{value: 2 ether}(taskId);
        uint256 payeeBefore = payee.balance;
        uint256 feeBefore = feeReceiver.balance;
        uint256 payerBefore = payer.balance;
        vm.expectEmit(true, true, false, true, address(escrow));
        emit Released(taskId, payee, 2 ether, 1.5 ether, 0.02 ether, 0.5 ether);
        vm.prank(operator);
        escrow.release(taskId, payee, 1.5 ether, 0.02 ether);
        assertEq(payee.balance - payeeBefore, 1.48 ether);
        assertEq(feeReceiver.balance - feeBefore, 0.02 ether);
        assertEq(payer.balance - payerBefore, 0.5 ether);
        assertEq(
            (payee.balance - payeeBefore) + (feeReceiver.balance - feeBefore) + (payer.balance - payerBefore), 2 ether
        );
        assertEq(uint256(escrow.escrowOf(taskId).state), uint256(Escrow.EscrowState.Released));
    }

    function testReleaseRejectsGrossAmountAboveEscrow() public {
        vm.prank(payer);
        escrow.deposit{value: 1 ether}(taskId);
        vm.expectRevert(Escrow.InvalidAmount.selector);
        vm.prank(operator);
        escrow.release(taskId, payee, 1.01 ether, 0);
    }

    function testReleaseRejectsFeeAboveAgentGrossAmount() public {
        vm.prank(payer);
        escrow.deposit{value: 1 ether}(taskId);
        vm.expectRevert(Escrow.InvalidAmount.selector);
        vm.prank(operator);
        escrow.release(taskId, payee, 0.5 ether, 0.51 ether);
    }

    function testRefundReturnsFundsAndRejectsDuplicateTerminalAction() public {
        vm.prank(payer);
        escrow.deposit{value: 1 ether}(taskId);
        uint256 payerBefore = payer.balance;
        vm.prank(operator);
        escrow.refund(taskId);
        assertEq(payer.balance - payerBefore, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(Escrow.EscrowNotDeposited.selector, taskId));
        vm.prank(operator);
        escrow.refund(taskId);
    }

    function testRejectsDuplicateDepositAndUnauthorizedOperator() public {
        vm.prank(payer);
        escrow.deposit{value: 1 ether}(taskId);
        vm.expectRevert(abi.encodeWithSelector(Escrow.EscrowAlreadyExists.selector, taskId));
        vm.prank(payer);
        escrow.deposit{value: 1 ether}(taskId);
        vm.expectRevert();
        vm.prank(makeAddr("outsider"));
        escrow.release(taskId, payee, 1 ether, 0);
    }

    function testPauseBlocksMoneyOperationsUntilPauserUnpauses() public {
        vm.prank(pauser);
        escrow.pause();
        vm.expectRevert();
        vm.prank(payer);
        escrow.deposit{value: 1 ether}(taskId);
        vm.prank(pauser);
        escrow.unpause();
        vm.prank(payer);
        escrow.deposit{value: 1 ether}(taskId);
        vm.prank(pauser);
        escrow.pause();
        vm.expectRevert();
        vm.prank(operator);
        escrow.refund(taskId);
    }

    function testTreasuryRoleIsIndependentFromPauserRole() public {
        address replacement = makeAddr("replacement");
        vm.expectRevert();
        vm.prank(pauser);
        escrow.setFeeReceiver(replacement);
        vm.prank(treasury);
        escrow.setFeeReceiver(replacement);
        assertEq(escrow.feeReceiver(), replacement);
    }

    function testReentrantPayeeCannotReleaseTwice() public {
        ReentrantPayee attacker = new ReentrantPayee(escrow);
        // 先读取角色常量再 prank；否则参数求值阶段的外部 getter 会消费一次性 prank。
        bytes32 operatorRole = escrow.OPERATOR_ROLE();
        vm.prank(admin);
        escrow.grantRole(operatorRole, address(attacker));
        vm.prank(payer);
        escrow.deposit{value: 1 ether}(taskId);
        vm.expectRevert();
        attacker.attack(taskId);
        Escrow.EscrowRecord memory record = escrow.escrowOf(taskId);
        assertEq(uint256(record.state), uint256(Escrow.EscrowState.Deposited));
        assertEq(address(escrow).balance, 1 ether);
    }
}
