// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../src/Escrow.sol";
import {TestUSDC} from "./TestUSDC.sol";

contract EscrowTest is Test {
    uint256 private constant ONE_USDC = 1_000_000;

    event Released(
        bytes32 indexed taskId,
        address indexed payee,
        uint256 escrowAmount,
        uint256 agentGrossAmount,
        uint256 feeAmount,
        uint256 payerRefundAmount
    );

    Escrow private escrow;
    TestUSDC private usdc;
    address private admin = makeAddr("admin");
    address private operator = makeAddr("operator");
    address private pauser = makeAddr("pauser");
    address private treasury = makeAddr("treasury");
    address private feeReceiver = makeAddr("feeReceiver");
    address private payer = makeAddr("payer");
    address private payee = makeAddr("payee");
    bytes32 private taskId = keccak256("task-1");

    function setUp() public {
        usdc = new TestUSDC();
        escrow = new Escrow(admin, operator, pauser, treasury, feeReceiver, address(usdc));
        usdc.mint(payer, 10 * ONE_USDC);
        vm.prank(payer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function testDepositPullsApprovedUsdcAndRecordsExactAmount() public {
        vm.prank(payer);
        escrow.deposit(taskId, 2 * ONE_USDC);

        Escrow.EscrowRecord memory record = escrow.escrowOf(taskId);
        assertEq(record.payer, payer);
        assertEq(record.amount, 2 * ONE_USDC);
        assertEq(record.releasedAmount, 0);
        assertEq(uint256(record.state), uint256(Escrow.EscrowState.Deposited));
        assertEq(usdc.balanceOf(address(escrow)), 2 * ONE_USDC);
    }

    function testDepositRejectsInsufficientAllowanceWithoutRecordingEscrow() public {
        bytes32 anotherTask = keccak256("insufficient-allowance");
        vm.prank(payer);
        usdc.approve(address(escrow), ONE_USDC - 1);

        vm.expectRevert();
        vm.prank(payer);
        escrow.deposit(anotherTask, ONE_USDC);

        assertEq(uint256(escrow.escrowOf(anotherTask).state), uint256(Escrow.EscrowState.None));
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function testDepositRejectsInsufficientBalanceWithoutRecordingEscrow() public {
        bytes32 anotherTask = keccak256("insufficient-balance");
        address unfundedPayer = makeAddr("unfunded-payer");
        vm.prank(unfundedPayer);
        usdc.approve(address(escrow), ONE_USDC);

        vm.expectRevert();
        vm.prank(unfundedPayer);
        escrow.deposit(anotherTask, ONE_USDC);

        assertEq(uint256(escrow.escrowOf(anotherTask).state), uint256(Escrow.EscrowState.None));
    }

    function testReleasePaysAgreedAmountAndRefundsUnusedBudget() public {
        vm.prank(payer);
        escrow.deposit(taskId, 2 * ONE_USDC);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit Released(taskId, payee, 2 * ONE_USDC, 1_500_000, 20_000, 500_000);

        vm.prank(operator);
        escrow.release(taskId, payee, 1_500_000, 20_000);

        assertEq(usdc.balanceOf(payee), 1_480_000);
        assertEq(usdc.balanceOf(feeReceiver), 20_000);
        assertEq(usdc.balanceOf(payer), 8_500_000);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(uint256(escrow.escrowOf(taskId).state), uint256(Escrow.EscrowState.Released));
    }

    function testReleaseRejectsGrossAmountAboveEscrow() public {
        _depositOneUsdc();
        vm.expectRevert(Escrow.InvalidAmount.selector);
        vm.prank(operator);
        escrow.release(taskId, payee, ONE_USDC + 1, 0);
    }

    function testReleaseRejectsFeeAboveAgentGrossAmount() public {
        _depositOneUsdc();
        vm.expectRevert(Escrow.InvalidAmount.selector);
        vm.prank(operator);
        escrow.release(taskId, payee, 500_000, 500_001);
    }

    function testMilestonesReleaseIndependentlyAndFinalizeRefundsOnlyRemainingBudget() public {
        vm.prank(payer);
        escrow.deposit(taskId, 3 * ONE_USDC);

        vm.startPrank(operator);
        escrow.releaseMilestone(taskId, payee, ONE_USDC, 10_000);
        escrow.releaseMilestone(taskId, payee, 500_000, 5_000);
        escrow.finalize(taskId);
        vm.stopPrank();

        Escrow.EscrowRecord memory record = escrow.escrowOf(taskId);
        assertEq(record.amount, 3 * ONE_USDC);
        assertEq(record.releasedAmount, 1_500_000);
        assertEq(uint256(record.state), uint256(Escrow.EscrowState.Released));
        assertEq(usdc.balanceOf(payee), 1_485_000);
        assertEq(usdc.balanceOf(feeReceiver), 15_000);
        assertEq(usdc.balanceOf(payer), 8_500_000);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function testMilestoneCannotExceedRemainingBudgetOrBeReleasedTwiceAfterFinalize() public {
        _depositOneUsdc();
        vm.prank(operator);
        escrow.releaseMilestone(taskId, payee, 750_000, 10_000);

        vm.expectRevert(Escrow.InvalidAmount.selector);
        vm.prank(operator);
        escrow.releaseMilestone(taskId, payee, 250_001, 0);

        vm.prank(operator);
        escrow.finalize(taskId);
        vm.expectRevert(abi.encodeWithSelector(Escrow.EscrowNotDeposited.selector, taskId));
        vm.prank(operator);
        escrow.releaseMilestone(taskId, payee, 1, 0);
    }

    function testRefundAfterAcceptedMilestoneReturnsOnlyUnreleasedBalance() public {
        vm.prank(payer);
        escrow.deposit(taskId, 2 * ONE_USDC);
        vm.startPrank(operator);
        escrow.releaseMilestone(taskId, payee, 600_000, 10_000);
        escrow.refund(taskId);
        vm.stopPrank();

        Escrow.EscrowRecord memory record = escrow.escrowOf(taskId);
        assertEq(record.releasedAmount, 600_000);
        assertEq(uint256(record.state), uint256(Escrow.EscrowState.Refunded));
        assertEq(usdc.balanceOf(payee), 590_000);
        assertEq(usdc.balanceOf(feeReceiver), 10_000);
        assertEq(usdc.balanceOf(payer), 9_400_000);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function testRefundReturnsFundsAndRejectsDuplicateTerminalAction() public {
        _depositOneUsdc();
        vm.prank(operator);
        escrow.refund(taskId);

        assertEq(usdc.balanceOf(payer), 10 * ONE_USDC);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        vm.expectRevert(abi.encodeWithSelector(Escrow.EscrowNotDeposited.selector, taskId));
        vm.prank(operator);
        escrow.refund(taskId);
    }

    function testRejectsDuplicateDepositAndUnauthorizedOperator() public {
        _depositOneUsdc();
        vm.expectRevert(abi.encodeWithSelector(Escrow.EscrowAlreadyExists.selector, taskId));
        vm.prank(payer);
        escrow.deposit(taskId, ONE_USDC);
        vm.expectRevert();
        vm.prank(makeAddr("outsider"));
        escrow.release(taskId, payee, ONE_USDC, 0);
    }

    function testPauseBlocksMoneyOperationsUntilPauserUnpauses() public {
        vm.prank(pauser);
        escrow.pause();
        vm.expectRevert();
        vm.prank(payer);
        escrow.deposit(taskId, ONE_USDC);
        vm.prank(pauser);
        escrow.unpause();
        _depositOneUsdc();
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

    function testMaliciousTokenCannotReenterSettlement() public {
        // 正式 USDC 不会在 transfer 中回调，但支付代币是外部合约，测试仍证明即使它
        // 变成恶意实现，结算也不会跨过 nonReentrant 重复进入资金终态。
        _depositOneUsdc();
        bytes32 operatorRole = escrow.OPERATOR_ROLE();
        vm.prank(admin);
        escrow.grantRole(operatorRole, address(usdc));
        usdc.configureReentry(escrow, taskId);

        vm.expectRevert();
        vm.prank(operator);
        escrow.release(taskId, payee, ONE_USDC, 0);

        assertEq(uint256(escrow.escrowOf(taskId).state), uint256(Escrow.EscrowState.Deposited));
        assertEq(usdc.balanceOf(address(escrow)), ONE_USDC);
    }

    function _depositOneUsdc() private {
        vm.prank(payer);
        escrow.deposit(taskId, ONE_USDC);
    }
}
