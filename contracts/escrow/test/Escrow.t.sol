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

    Escrow private escrow;
    TestUSDC private usdc;
    address private admin = makeAddr("admin");
    address private operator = makeAddr("operator");
    address private pauser = makeAddr("pauser");
    address private treasury = makeAddr("treasury");
    address private feeReceiver = makeAddr("feeReceiver");
    address private payer = makeAddr("payer");
    address private payee = makeAddr("payee");
    address private secondPayee = makeAddr("second-payee");
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

    function testWorkflowSettlementAtomicallyPaysEveryAgentAndAnchorsEvidence() public {
        vm.prank(payer);
        escrow.deposit(taskId, 3 * ONE_USDC);

        Escrow.WorkflowPayout[] memory payouts = new Escrow.WorkflowPayout[](2);
        payouts[0] = Escrow.WorkflowPayout({payee: payee, grossAmount: ONE_USDC, feeAmount: 10_000});
        payouts[1] = Escrow.WorkflowPayout({payee: secondPayee, grossAmount: 500_000, feeAmount: 5_000});
        bytes32 manifestHash = keccak256("settlement-manifest");
        bytes32 evidenceRoot = keccak256("accepted-evidence");

        vm.expectEmit(true, true, true, true, address(escrow));
        emit WorkflowPayoutReleased(taskId, 0, payee, ONE_USDC, 10_000, 990_000);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit WorkflowPayoutReleased(taskId, 1, secondPayee, 500_000, 5_000, 495_000);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit WorkflowSettled(taskId, manifestHash, evidenceRoot, payer, 3 * ONE_USDC, 1_500_000, 15_000, 1_500_000);
        vm.prank(operator);
        escrow.settleWorkflow(taskId, payouts, manifestHash, evidenceRoot);

        Escrow.EscrowRecord memory record = escrow.escrowOf(taskId);
        assertEq(record.amount, 3 * ONE_USDC);
        assertEq(record.releasedAmount, 1_500_000);
        assertEq(uint256(record.state), uint256(Escrow.EscrowState.Released));
        assertEq(usdc.balanceOf(payee), 990_000);
        assertEq(usdc.balanceOf(secondPayee), 495_000);
        assertEq(usdc.balanceOf(feeReceiver), 15_000);
        assertEq(usdc.balanceOf(payer), 8_500_000);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function testWorkflowSettlementRejectsInvalidListAndCannotRunTwice() public {
        vm.prank(payer);
        escrow.deposit(taskId, 2 * ONE_USDC);
        Escrow.WorkflowPayout[] memory payouts = new Escrow.WorkflowPayout[](2);
        payouts[0] = Escrow.WorkflowPayout({payee: payee, grossAmount: ONE_USDC, feeAmount: 0});
        payouts[1] = Escrow.WorkflowPayout({payee: secondPayee, grossAmount: ONE_USDC + 1, feeAmount: 0});
        vm.expectRevert(Escrow.InvalidAmount.selector);
        vm.prank(operator);
        escrow.settleWorkflow(taskId, payouts, keccak256("manifest"), keccak256("evidence"));

        payouts[1].grossAmount = ONE_USDC;
        vm.prank(operator);
        escrow.settleWorkflow(taskId, payouts, keccak256("manifest"), keccak256("evidence"));
        vm.expectRevert(abi.encodeWithSelector(Escrow.EscrowNotDeposited.selector, taskId));
        vm.prank(operator);
        escrow.settleWorkflow(taskId, payouts, keccak256("manifest"), keccak256("evidence"));
    }

    function testWorkflowSettlementRequiresNonzeroManifestAndEvidenceHashes() public {
        _depositOneUsdc();
        Escrow.WorkflowPayout[] memory payouts = new Escrow.WorkflowPayout[](1);
        payouts[0] = Escrow.WorkflowPayout({payee: payee, grossAmount: ONE_USDC, feeAmount: 0});
        vm.expectRevert(Escrow.InvalidAmount.selector);
        vm.prank(operator);
        escrow.settleWorkflow(taskId, payouts, bytes32(0), keccak256("evidence"));
        vm.expectRevert(Escrow.InvalidAmount.selector);
        vm.prank(operator);
        escrow.settleWorkflow(taskId, payouts, keccak256("manifest"), bytes32(0));
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

    function testDisputeRefundAnchorsDecisionAndEvidence() public {
        _depositOneUsdc();
        bytes32 decisionHash = keccak256("dao-decision");
        bytes32 evidenceRoot = keccak256("dispute-evidence");
        vm.prank(operator);
        escrow.refundDispute(taskId, decisionHash, evidenceRoot);

        Escrow.EscrowRecord memory record = escrow.escrowOf(taskId);
        assertEq(uint256(record.state), uint256(Escrow.EscrowState.Refunded));
        assertEq(record.releasedAmount, 0);
        assertEq(usdc.balanceOf(payer), 10 * ONE_USDC);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function testDisputeRefundRejectsMissingEvidenceHash() public {
        _depositOneUsdc();
        vm.expectRevert(Escrow.InvalidAmount.selector);
        vm.prank(operator);
        escrow.refundDispute(taskId, bytes32(0), keccak256("evidence"));
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
