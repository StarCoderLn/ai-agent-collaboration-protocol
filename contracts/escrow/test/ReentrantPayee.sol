// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Escrow} from "../src/Escrow.sol";

contract ReentrantPayee {
    Escrow private immutable target;
    bytes32 private activeTask;

    constructor(Escrow escrow) {
        target = escrow;
    }

    function attack(bytes32 taskId) external {
        activeTask = taskId;
        target.release(taskId, payable(address(this)), 1 ether, 0);
    }

    receive() external payable {
        target.release(activeTask, payable(address(this)), 1 ether, 0);
    }
}
