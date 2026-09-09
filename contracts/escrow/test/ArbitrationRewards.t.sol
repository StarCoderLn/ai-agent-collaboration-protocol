// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Test} from "forge-std/Test.sol";
import {ArbitrationRewards} from "../src/ArbitrationRewards.sol";
import {TestYD} from "./TestYD.sol";

/// @dev 模拟单个收款人暂时无法收币，验证失败不会影响其他奖励或消耗已记账余额。
contract RejectingRewardYD is TestYD {
    address public blocked;

    function setBlocked(address recipient) external {
        blocked = recipient;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        require(to != blocked, "RECIPIENT_BLOCKED");
        return super.transfer(to, amount);
    }
}

/**
 *  自动发放只改变到账方式，不新增免费领币、不授予 operator 修改金额或收款人的权限。
 */
contract ArbitrationRewardsTest is Test {
    function testAuthorizedLegacyVoteRewardUsesArbitrationKindOnce() public {
        TestYD yd = new TestYD();
        ArbitrationRewards pool = new ArbitrationRewards(address(this), address(yd));
        pool.grantRole(pool.AWARD_ROLE(), address(this));
        yd.mint(address(this), 20 ether);
        yd.approve(address(pool), 20 ether);
        pool.fund(20 ether);
        address recipient = makeAddr("legacy-arbitrator");
        bytes32 source = keccak256("legacy-vote-id");
        pool.award(source, recipient, 10 ether, ArbitrationRewards.RewardKind.Arbitration);
        vm.expectRevert(ArbitrationRewards.InvalidInput.selector);
        pool.award(source, recipient, 10 ether, ArbitrationRewards.RewardKind.Arbitration);
        pool.payReward(source, recipient);
        assertEq(yd.balanceOf(recipient), 10 ether);
    }

    function testAutomaticPayoutCannotRedirectOrDoublePay() public {
        RejectingRewardYD yd = new RejectingRewardYD();
        ArbitrationRewards pool = new ArbitrationRewards(address(this), address(yd));
        pool.grantRole(pool.AWARD_ROLE(), address(this));
        yd.mint(address(this), 100 ether);
        yd.approve(address(pool), 100 ether);
        pool.fund(100 ether);
        address recipient = makeAddr("recipient");
        address operator = makeAddr("operator");
        bytes32 source = keccak256("verified-task-reward");
        pool.award(source, recipient, 20 ether, ArbitrationRewards.RewardKind.Task);
        vm.startPrank(operator);
        pool.payReward(source, operator);
        pool.payReward(source, recipient);
        pool.payReward(source, recipient);
        vm.stopPrank();
        assertEq(yd.balanceOf(operator), 0);
        assertEq(yd.balanceOf(recipient), 20 ether);
        assertEq(pool.paidRewards(source, recipient), 20 ether);
        assertEq(pool.claimable(recipient), 0);
        assertEq(pool.available() + pool.reserved() + pool.owed(), yd.balanceOf(address(pool)));
    }

    function testBlockedRecipientDoesNotBlockOtherRewardsAndCanRetry() public {
        RejectingRewardYD yd = new RejectingRewardYD();
        ArbitrationRewards pool = new ArbitrationRewards(address(this), address(yd));
        pool.grantRole(pool.AWARD_ROLE(), address(this));
        yd.mint(address(this), 100 ether);
        yd.approve(address(pool), 100 ether);
        pool.fund(100 ether);
        address blocked = makeAddr("blocked");
        address other = makeAddr("other");
        bytes32 first = keccak256("first");
        bytes32 second = keccak256("second");
        pool.award(first, blocked, 20 ether, ArbitrationRewards.RewardKind.Activity);
        pool.award(second, other, 20 ether, ArbitrationRewards.RewardKind.Activity);
        yd.setBlocked(blocked);
        vm.expectRevert();
        pool.payReward(first, blocked);
        assertEq(pool.credits(first, blocked), 20 ether);
        assertEq(pool.paidRewards(first, blocked), 0);
        pool.payReward(second, other);
        assertEq(yd.balanceOf(other), 20 ether);
        yd.setBlocked(address(0));
        pool.payReward(first, blocked);
        assertEq(yd.balanceOf(blocked), 20 ether);
        assertEq(pool.owed(), 0);
    }
}
