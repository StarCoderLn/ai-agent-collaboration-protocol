// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @notice 托管只读取案件是否存在、是否终审、释放比例及证据根，不了解 VRF 或投票细节。
 * @dev 此边界阻止业务 operator 绕过申诉期，原有无争议任务继续使用原结算路径。
 */
interface IArbitrationCases {
    function settlementFor(bytes32 taskId)
        external
        view
        returns (bool exists, bool finalDecision, uint16 releaseBps, bytes32 evidenceRoot);
}
