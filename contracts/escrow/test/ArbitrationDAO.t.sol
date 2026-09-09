// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ArbitrationDAO} from "../src/ArbitrationDAO.sol";
import {TestYD} from "./TestYD.sol";

/**
 * DAO 合约测试聚焦链上可强制执行的不变量：达到门槛才获得资格、申请退出立即失去新分案
 * 资格、冷静期内资金不可取回，以及配置与暂停权限不能被普通成员绕过。
 */
contract ArbitrationDAOTest is Test {
    uint256 private constant ONE_YD = 1 ether;
    uint64 private constant EXIT_DELAY = 7 days;

    ArbitrationDAO private dao;
    TestYD private yd;
    address private admin = makeAddr("admin");
    address private config = makeAddr("config");
    address private pauser = makeAddr("pauser");
    address private member = makeAddr("member");

    function setUp() public {
        yd = new TestYD();
        dao = new ArbitrationDAO(admin, config, pauser, address(yd), 1_000 * ONE_YD, EXIT_DELAY);
        yd.mint(member, 2_000 * ONE_YD);
        vm.prank(member);
        yd.approve(address(dao), type(uint256).max);
    }

    function testStakeCreatesOnchainEligibilityOnlyAfterMinimum() public {
        // 先验证门槛下方不会提前获得资格，再补足最后 1 YD，避免只测试“足额质押”正常路径。
        vm.prank(member);
        dao.stake(999 * ONE_YD);
        assertFalse(dao.isEligible(member));
        vm.prank(member);
        dao.stake(ONE_YD);
        assertTrue(dao.isEligible(member));
        assertEq(yd.balanceOf(address(dao)), 1_000 * ONE_YD);
    }

    function testExitImmediatelyStopsNewEligibilityButKeepsStakeLocked() public {
        // 退出请求对分案立即生效，但资金必须继续锁定到冷静期结束，两个时间语义不能混为一谈。
        vm.prank(member);
        dao.stake(1_000 * ONE_YD);
        vm.prank(member);
        dao.requestExit();
        assertFalse(dao.isEligible(member));
        vm.expectRevert();
        vm.prank(member);
        dao.withdraw();

        vm.warp(block.timestamp + EXIT_DELAY);
        vm.prank(member);
        dao.withdraw();
        assertEq(yd.balanceOf(member), 2_000 * ONE_YD);
        assertEq(yd.balanceOf(address(dao)), 0);
    }

    function testAddingStakeCancelsPendingExit() public {
        // 追加质押代表成员主动恢复参与，合约必须清掉旧退出时间，避免同一成员处于矛盾状态。
        vm.prank(member);
        dao.stake(1_000 * ONE_YD);
        vm.prank(member);
        dao.requestExit();
        vm.prank(member);
        dao.stake(ONE_YD);
        assertTrue(dao.isEligible(member));
        ArbitrationDAO.Membership memory membership = dao.membershipOf(member);
        assertEq(membership.exitAvailableAt, 0);
    }

    function testOnlyConfiguredRolesCanChangeThresholdOrPause() public {
        // 普通成员不能降低门槛或暂停合约，只有部署时授予的独立角色可以改变全局配置。
        vm.expectRevert();
        vm.prank(member);
        dao.setMinimumStake(500 * ONE_YD);
        vm.prank(config);
        dao.setMinimumStake(500 * ONE_YD);
        assertEq(dao.minimumStake(), 500 * ONE_YD);

        vm.prank(pauser);
        dao.pause();
        vm.expectRevert();
        vm.prank(member);
        dao.stake(ONE_YD);
    }

    function testLoweringMinimumTo100EnforcesNewBoundaryWithoutMovingExistingStake() public {
        // 复现已有 1000 YD 部署降门槛：配置交易只改资格条件，不退还或扣除原成员资金。
        vm.prank(member);
        dao.stake(1_000 * ONE_YD);
        uint256 previousBalance = yd.balanceOf(address(dao));
        vm.prank(config);
        dao.setMinimumStake(100 * ONE_YD);
        assertEq(dao.minimumStake(), 100 * ONE_YD);
        assertEq(dao.membershipOf(member).stakedAmount, 1_000 * ONE_YD);
        assertEq(yd.balanceOf(address(dao)), previousBalance);
        assertTrue(dao.isEligible(member));

        // 新成员必须实际补足 100 YD；降低门槛不能把不足额质押误判成可分案。
        address newcomer = makeAddr("newcomer");
        yd.mint(newcomer, 100 * ONE_YD);
        vm.startPrank(newcomer);
        yd.approve(address(dao), 100 * ONE_YD);
        dao.stake(99 * ONE_YD);
        assertFalse(dao.isEligible(newcomer));
        dao.stake(ONE_YD);
        assertTrue(dao.isEligible(newcomer));
        vm.stopPrank();
    }

    function testLoweringMinimumDoesNotCancelExitOrReduceWithdrawal() public {
        // 已申请退出的人仍不能进入新案件；7 天到期后取回的是原始 1000 YD，不是新门槛。
        vm.prank(member);
        dao.stake(1_000 * ONE_YD);
        vm.prank(member);
        dao.requestExit();
        uint64 availableAt = dao.membershipOf(member).exitAvailableAt;
        vm.prank(config);
        dao.setMinimumStake(100 * ONE_YD);
        assertFalse(dao.isEligible(member));
        assertEq(dao.membershipOf(member).exitAvailableAt, availableAt);
        vm.warp(availableAt);
        vm.prank(member);
        dao.withdraw();
        assertEq(yd.balanceOf(member), 2_000 * ONE_YD);
    }
}
