// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ArbitrationDAO} from "../src/ArbitrationDAO.sol";
import {ArbitrationCases} from "../src/ArbitrationCases.sol";
import {ArbitrationRewards} from "../src/ArbitrationRewards.sol";
import {Escrow} from "../src/Escrow.sol";
import {IVRFV2PlusCoordinator} from "../src/interfaces/IVRFV2PlusCoordinator.sol";
import {TestYD} from "./TestYD.sol";
import {TestUSDC} from "./TestUSDC.sol";

/**
 * @notice 仅用于测试消费端状态机的协调器替身，不产生或验证真实 Chainlink VRF 证明。
 * @dev 显式校验 v2.5 结构及 nativePayment 标签，避免“测试接口正常、正式网络 ABI 错误”。
 */
contract CaseVrfCoordinatorTestDouble is IVRFV2PlusCoordinator {
    uint256 public nextId;
    mapping(uint256 id => address consumer) private consumers;

    function requestRandomWords(RandomWordsRequest calldata request) external returns (uint256 id) {
        require(request.numWords == 1 && request.subId == 42 && request.requestConfirmations >= 3);
        require(
            keccak256(request.extraArgs)
                == keccak256(abi.encodeWithSelector(bytes4(keccak256("VRF ExtraArgsV1")), false))
        );
        id = ++nextId;
        consumers[id] = msg.sender;
    }

    /// @notice 测试显式触发异步返回，用于验证迟到、重复回调和不同请求的隔离。
    function fulfill(uint256 id, uint256 word) external {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        ArbitrationCases(consumers[id]).rawFulfillRandomWords(id, words);
    }
}

/**
 * @notice 覆盖整条链上资金约束：首审不能付款、申诉阻断付款、终审比例不可篡改，
 * 奖励和保证金与任务预算隔离。测试金额仅为断言数据，不是产品默认费率。
 */
contract ArbitrationCasesTest is Test {
    ArbitrationCases private court;
    ArbitrationRewards private pool;
    ArbitrationDAO private dao;
    CaseVrfCoordinatorTestDouble private vrf;
    TestYD private yd;
    TestUSDC private usdc;
    Escrow private escrow;
    address private publisher = address(0x100);
    address private provider = address(0x200);
    address private treasury = address(0x300);
    bytes32 private constant CASE = keccak256("case");
    bytes32 private constant TASK = keccak256("task");
    bytes32 private constant ROOT = keccak256("evidence");
    bytes32 private constant REASON = keccak256("reason");

    function setUp() public {
        yd = new TestYD();
        usdc = new TestUSDC();
        dao = new ArbitrationDAO(address(this), address(this), address(this), address(yd), 1000 ether, 7 days);
        pool = new ArbitrationRewards(address(this), address(yd));
        vrf = new CaseVrfCoordinatorTestDouble();
        court = new ArbitrationCases(
            address(this),
            address(dao),
            address(pool),
            address(usdc),
            address(vrf),
            treasury,
            ArbitrationCases.VrfConfig(keccak256("keyHash"), 42, 3, 200_000, false),
            ArbitrationCases.TimingConfig(1 days, 3 days, 2 days, 1 days, 10 days, 0)
        );
        court.grantRole(court.REGISTRAR_ROLE(), address(this));
        court.grantRole(court.RECOVERY_ROLE(), address(this));
        pool.grantRole(pool.CASE_ROLE(), address(court));
        pool.grantRole(pool.AWARD_ROLE(), address(this));
        court.configureTerms(
            ArbitrationCases.Terms(10 ether, 2_000_000, 1_000_000, ArbitrationCases.BondPolicy.ReturnOnChangedDecision)
        );
        yd.mint(address(this), 1000 ether);
        yd.approve(address(pool), type(uint256).max);
        pool.fund(1000 ether);
        for (uint160 i = 1; i <= 10; ++i) {
            yd.mint(address(i), 1000 ether);
            vm.startPrank(address(i));
            yd.approve(address(dao), 1000 ether);
            dao.stake(1000 ether);
            vm.stopPrank();
        }
        escrow = new Escrow(address(this), address(this), address(this), address(this), treasury, address(usdc));
        escrow.bindArbitrationCases(address(court));
        usdc.mint(publisher, 200_000_000);
        vm.startPrank(publisher);
        usdc.approve(address(escrow), 100_000_000);
        escrow.deposit(TASK, 100_000_000);
        usdc.approve(address(court), 100_000_000);
        vm.stopPrank();
    }

    /// @notice 证据期、投票期和申诉期都必须阻断所有旧式和新式付款入口。
    function testFirstDecisionDoesNotPayUntilAppealDeadline() public {
        _open();
        _assertFrozen();
        address[] memory panel = _panel(1);
        _assertFrozen();
        _castAll(panel, 5000);
        court.closeRound(CASE);
        assertEq(uint256(court.caseOf(CASE).status), uint256(ArbitrationCases.Status.AppealWindow));
        _assertFrozen();
        vm.expectRevert(ArbitrationCases.InvalidState.selector);
        court.finalizeUnappealed(CASE);
        vm.warp(court.caseOf(CASE).deadline);
        court.finalizeUnappealed(CASE);
        _settle(50_000_000, ROOT);
        assertEq(usdc.balanceOf(provider), 50_000_000);
        assertEq(usdc.balanceOf(publisher), 150_000_000);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    /// @notice 只有独立五人组能给出申诉终审，改判退保证金，费用没有从托管预算中扣。
    function testAppealUsesFiveNewJurorsAndIndependentBond() public {
        _open();
        address[] memory first = _panel(1);
        _castAll(first, 10_000);
        court.closeRound(CASE);
        vm.prank(publisher);
        court.appeal(CASE);
        assertEq(usdc.balanceOf(address(escrow)), 100_000_000);
        assertEq(court.lockedBonds(), 2_000_000);
        _assertFrozen();
        address[] memory second = _panel(2);
        assertEq(second.length, 5);
        for (uint256 i; i < second.length; ++i) {
            for (uint256 j; j < first.length; ++j) {
                assertTrue(second[i] != first[j]);
            }
        }
        _castAll(second, 5000);
        court.closeRound(CASE);
        assertEq(court.usdcCredit(publisher), 2_000_000);
        assertEq(court.usdcCredit(treasury), 1_000_000);
        assertEq(court.lockedBonds(), 0);
        vm.prank(publisher);
        court.claimUsdc();
        vm.expectRevert(ArbitrationCases.InvalidState.selector);
        vm.prank(publisher);
        court.appeal(CASE);
        _settle(50_000_000, ROOT);
    }

    /// @notice 终审参与不足先进入公开恢复期，恢复期结束后任何人都能执行预先配置的退款兜底。
    function testTerminalTimeoutHasBoundedRecoveryAndFallback() public {
        _open();
        _panel(1);
        vm.warp(court.caseOf(CASE).deadline);
        court.closeRound(CASE);
        assertEq(court.caseOf(CASE).round, 2);
        assertEq(court.lockedBonds(), 0);
        _panel(2);
        vm.warp(court.caseOf(CASE).deadline);
        court.closeRound(CASE);
        assertEq(uint256(court.caseOf(CASE).status), uint256(ArbitrationCases.Status.Recovery));
        _assertFrozen();
        vm.expectRevert(ArbitrationCases.InvalidState.selector);
        court.finalizeRecovery(CASE);
        vm.warp(court.caseOf(CASE).deadline);
        court.finalizeRecovery(CASE);
        assertEq(uint256(court.caseOf(CASE).status), uint256(ArbitrationCases.Status.Final));
        assertEq(court.caseOf(CASE).outcome, 0);
        escrow.refundDispute(TASK, REASON, ROOT);
        assertEq(usdc.balanceOf(publisher), 200_000_000);
        assertEq(pool.available(), 1000 ether);
    }

    /// @notice 恢复角色可在硬截止前依据证据给出比例裁决，普通地址和零理由不能释放资金。
    function testStalledRecoveryRequiresRoleAndReason() public {
        _open();
        _panel(1);
        vm.warp(court.caseOf(CASE).deadline);
        court.closeRound(CASE);
        _panel(2);
        vm.warp(court.caseOf(CASE).deadline);
        court.closeRound(CASE);

        vm.expectRevert();
        vm.prank(publisher);
        court.resolveRecovery(CASE, 5000, REASON);
        vm.expectRevert(ArbitrationCases.InvalidInput.selector);
        court.resolveRecovery(CASE, 5000, bytes32(0));
        court.resolveRecovery(CASE, 5000, REASON);
        assertEq(uint256(court.caseOf(CASE).status), uint256(ArbitrationCases.Status.Final));
        assertEq(court.caseOf(CASE).outcome, 5000);
        _settle(50_000_000, ROOT);
    }

    /// @notice 达到三票法定人数后按全部有效比例的中位数裁决，意见分类分散也不会卡死。
    function testTerminalQuorumUsesMedianOutcome() public {
        _open();
        _panel(1);
        vm.warp(court.caseOf(CASE).deadline);
        court.closeRound(CASE);
        address[] memory panel = _panel(2);
        uint16[5] memory outcomes = [uint16(0), 2000, 5000, 8000, 10_000];
        for (uint256 i; i < panel.length; ++i) {
            vm.prank(panel[i]);
            court.vote(CASE, outcomes[i], REASON);
        }
        court.closeRound(CASE);
        assertEq(uint256(court.caseOf(CASE).status), uint256(ArbitrationCases.Status.Final));
        assertEq(court.caseOf(CASE).outcome, 5000);
    }

    /// @notice 截止时四票也达到法定人数，偶数中位数使用中间两票平均且明确向下舍入。
    function testTerminalEvenVoteMedianIsDeterministic() public {
        _open();
        _panel(1);
        vm.warp(court.caseOf(CASE).deadline);
        court.closeRound(CASE);
        address[] memory panel = _panel(2);
        uint16[4] memory outcomes = [uint16(0), 2001, 8000, 10_000];
        for (uint256 i; i < outcomes.length; ++i) {
            vm.prank(panel[i]);
            court.vote(CASE, outcomes[i], REASON);
        }
        vm.warp(court.caseOf(CASE).deadline);
        court.closeRound(CASE);
        assertEq(court.caseOf(CASE).outcome, 5000);
    }

    /// @notice VRF 永不回调也只能冻结到全案硬期限，进入恢复时释放未使用的投票奖励预留。
    function testHardCaseTimeoutRecoversExternalDependencyFailure() public {
        _open();
        vm.warp(court.caseOf(CASE).evidenceDeadline);
        court.requestPanel(CASE, _candidates(1));
        vm.expectRevert(ArbitrationCases.InvalidState.selector);
        court.enterRecovery(CASE);
        vm.warp(court.recoveryEligibleAt(CASE));
        court.enterRecovery(CASE);
        assertEq(uint256(court.caseOf(CASE).status), uint256(ArbitrationCases.Status.Recovery));
        assertEq(pool.reserved(), 0);
        vm.warp(court.caseOf(CASE).deadline);
        court.finalizeRecovery(CASE);
        escrow.refundDispute(TASK, REASON, ROOT);
    }

    /// @notice 全案硬期限必须容纳举证、两轮投票和申诉窗口，错误配置不能提前截断正常流程。
    function testCaseTimeoutCannotCutAcrossNormalWindows() public {
        vm.expectRevert(ArbitrationCases.InvalidInput.selector);
        new ArbitrationCases(
            address(this),
            address(dao),
            address(pool),
            address(usdc),
            address(vrf),
            treasury,
            ArbitrationCases.VrfConfig(keccak256("keyHash"), 42, 3, 200_000, false),
            ArbitrationCases.TimingConfig(1 days, 3 days, 2 days, 1 days, 9 days, 0)
        );
    }

    /// @notice 普通地址、重复回调和重复请求不能改变一次已承诺的抽签结果。
    function testVrfAuthenticityAndReplayProtection() public {
        _open();
        vm.warp(court.caseOf(CASE).evidenceDeadline);
        court.requestPanel(CASE, _candidates(1));
        uint256[] memory words = new uint256[](1);
        vm.expectRevert(ArbitrationCases.NotCoordinator.selector);
        court.rawFulfillRandomWords(1, words);
        address[] memory candidates = _candidates(1);
        vm.expectRevert(ArbitrationCases.InvalidState.selector);
        court.requestPanel(CASE, candidates);
        vrf.fulfill(1, 0);
        vrf.fulfill(1, 999);
        court.selectPanel(CASE);
        assertEq(court.roundOf(CASE, 1).randomWord, 0);
        assertEq(court.roundOf(CASE, 1).panel.length, 3);
        vrf.fulfill(1, 123);
        assertEq(uint256(court.caseOf(CASE).status), uint256(ArbitrationCases.Status.Voting));
    }

    /// @notice 候选必须满足即时链上资格且去重；成员不足不能悄悄退化为一人仲裁。
    function testCandidateBoundsAndLiveExitEligibility() public {
        _open();
        vm.warp(court.caseOf(CASE).evidenceDeadline);
        address[] memory candidates = _candidates(1);
        vm.prank(candidates[0]);
        dao.requestExit();
        vm.expectRevert(ArbitrationCases.InvalidPanel.selector);
        court.requestPanel(CASE, candidates);
        candidates = new address[](2);
        candidates[0] = address(2);
        candidates[1] = address(3);
        vm.expectRevert(ArbitrationCases.InvalidPanel.selector);
        court.requestPanel(CASE, candidates);
        assertEq(vrf.nextId(), 0);
    }

    /// @notice 证据只能由当事人提交；内容被换掉会产生不同承诺，ID 不可覆写且截止后拒收。
    function testEvidenceIsAppendOnlyAndPartyBound() public {
        _open();
        bytes32 evidenceId = keccak256("document");
        vm.expectRevert(ArbitrationCases.NotParty.selector);
        court.submitEvidence(CASE, evidenceId, REASON);
        vm.prank(publisher);
        court.submitEvidence(CASE, evidenceId, REASON);
        assertEq(court.caseOf(CASE).evidenceRoot, keccak256(abi.encode(ROOT, evidenceId, publisher, REASON)));
        vm.expectRevert(ArbitrationCases.InvalidInput.selector);
        vm.prank(publisher);
        court.submitEvidence(CASE, evidenceId, ROOT);
        vm.warp(court.caseOf(CASE).evidenceDeadline);
        vm.expectRevert(ArbitrationCases.InvalidState.selector);
        vm.prank(provider);
        court.submitEvidence(CASE, REASON, ROOT);
    }

    /// @notice 平台可代发一次、重复调用不重复付款；未投票无奖励，普通钱包不能虚构活动奖励。
    function testRewardsHaveNoPublicFaucetAndConservePool() public {
        _open();
        address[] memory panel = _panel(1);
        vm.prank(panel[0]);
        court.vote(CASE, 10_000, REASON);
        vm.prank(panel[1]);
        court.vote(CASE, 10_000, REASON);
        vm.warp(court.caseOf(CASE).deadline);
        court.closeRound(CASE);
        assertEq(pool.claimable(panel[0]), 10 ether);
        assertEq(pool.claimable(panel[2]), 0);
        assertEq(pool.available() + pool.reserved() + pool.owed(), yd.balanceOf(address(pool)));
        bytes32 source = keccak256(abi.encode(block.chainid, address(court), CASE, uint8(1)));
        uint256 beforeBalance = yd.balanceOf(panel[0]);
        pool.payReward(source, panel[0]);
        pool.payReward(source, panel[0]);
        assertEq(yd.balanceOf(panel[0]), beforeBalance + 10 ether);
        assertEq(pool.claimable(panel[0]), 0);
        vm.expectRevert();
        vm.prank(publisher);
        pool.award(ROOT, publisher, 1 ether, ArbitrationRewards.RewardKind.Activity);
        pool.award(ROOT, publisher, 1 ether, ArbitrationRewards.RewardKind.Activity);
        vm.expectRevert(ArbitrationRewards.InvalidInput.selector);
        pool.award(ROOT, publisher, 1 ether, ArbitrationRewards.RewardKind.Activity);
        assertEq(pool.available() + pool.reserved() + pool.owed(), yd.balanceOf(address(pool)));
    }

    /// @notice 当奖励池不足以承担五人终审时，不收申诉费也不消耗用户 allowance。
    function testUnderfundedAppealRollsBackWithoutCharging() public {
        _open();
        _castAll(_panel(1), 10_000);
        court.closeRound(CASE);
        pool.award(ROOT, treasury, pool.available(), ArbitrationRewards.RewardKind.Activity);
        uint256 beforeBalance = usdc.balanceOf(publisher);
        vm.expectRevert(ArbitrationRewards.InsufficientPool.selector);
        vm.prank(publisher);
        court.appeal(CASE);
        assertEq(usdc.balanceOf(publisher), beforeBalance);
        assertEq(uint256(court.caseOf(CASE).status), uint256(ArbitrationCases.Status.AppealWindow));
    }

    /// @notice 当前案件条款已快照；管理员调整新案配置不能追加本案费用。
    function testTermsAreSnapshottedAndVotesCannotBeChanged() public {
        _open();
        court.configureTerms(
            ArbitrationCases.Terms(20 ether, 9_000_000, 9_000_000, ArbitrationCases.BondPolicy.ReturnAlways)
        );
        assertEq(court.caseOf(CASE).terms.appealBond, 2_000_000);
        address[] memory panel = _panel(1);
        vm.prank(panel[0]);
        court.vote(CASE, 2000, REASON);
        vm.expectRevert(ArbitrationCases.InvalidPanel.selector);
        vm.prank(panel[0]);
        court.vote(CASE, 9000, REASON);
        vm.prank(panel[1]);
        court.vote(CASE, 8000, REASON);
        vm.prank(panel[2]);
        court.vote(CASE, 5000, REASON);
        court.closeRound(CASE);
        assertEq(court.caseOf(CASE).outcome, 5000);
    }

    /// @notice 裁决即使已终审，错误比例、错误证据根和第二次支付仍必须拒绝。
    function testFinalSettlementRejectsWrongAmountRootAndReplay() public {
        _open();
        _castAll(_panel(1), 5000);
        court.closeRound(CASE);
        vm.warp(court.caseOf(CASE).deadline);
        court.finalizeUnappealed(CASE);
        vm.expectRevert(abi.encodeWithSelector(Escrow.ArbitrationMismatch.selector, TASK));
        _settle(60_000_000, ROOT);
        vm.expectRevert(abi.encodeWithSelector(Escrow.ArbitrationMismatch.selector, TASK));
        _settle(50_000_000, REASON);
        _settle(50_000_000, ROOT);
        vm.expectRevert();
        _settle(50_000_000, ROOT);
        vm.expectRevert(Escrow.InvalidAddress.selector);
        escrow.bindArbitrationCases(address(court));
    }

    /// @notice 统一建立当事人有序集合，测试入口与生产合约约束一致。
    function _open() private {
        address[] memory parties = new address[](2);
        parties[0] = publisher;
        parties[1] = provider;
        court.openCase(CASE, TASK, parties, parties, ROOT);
    }

    /// @notice 选择候选时剔除第一轮成员，保持二审独立且排序稳定。
    function _candidates(uint8 round) private view returns (address[] memory) {
        address[] memory first = court.roundOf(CASE, 1).panel;
        address[] memory result = new address[](round == 1 ? 10 : 7);
        uint256 cursor;
        for (uint160 i = 1; i <= 10; ++i) {
            bool exclude;
            if (round == 2) {
                for (uint256 j; j < first.length; ++j) {
                    if (first[j] == address(i)) exclude = true;
                }
            }
            if (!exclude) result[cursor++] = address(i);
        }
        return result;
    }

    /// @notice 显式分开请求、回调和选组，模拟 VRF 真实异步边界而非一个同步随机函数。
    function _panel(uint8 round) private returns (address[] memory) {
        if (round == 1) vm.warp(court.caseOf(CASE).evidenceDeadline);
        court.requestPanel(CASE, _candidates(round));
        vrf.fulfill(court.roundOf(CASE, round).requestId, uint256(keccak256(abi.encode(round))));
        court.selectPanel(CASE);
        return court.roundOf(CASE, round).panel;
    }

    /// @notice 每票由自己的钱包提交，禁止以测试管理员身份绕过成员验证。
    function _castAll(address[] memory panel, uint16 bps) private {
        for (uint256 i; i < panel.length; ++i) {
            vm.prank(panel[i]);
            court.vote(CASE, bps, REASON);
        }
    }

    /// @notice 覆盖四个付款入口，而非只验证新 UI 对按钮做了禁用。
    function _assertFrozen() private {
        vm.expectRevert();
        escrow.release(TASK, provider, 100_000_000, 0);
        vm.expectRevert();
        escrow.refund(TASK);
        vm.expectRevert();
        escrow.refundDispute(TASK, REASON, ROOT);
        vm.expectRevert();
        _settle(100_000_000, ROOT);
    }

    /// @notice 一条分账已足以测试总额与证据约束，多 Agent 舍入仍由已有 Escrow 测试覆盖。
    function _settle(uint256 amount, bytes32 root) private {
        Escrow.WorkflowPayout[] memory payouts = new Escrow.WorkflowPayout[](1);
        payouts[0] = Escrow.WorkflowPayout(provider, amount, 0);
        escrow.settleWorkflow(TASK, payouts, REASON, root);
    }
}
