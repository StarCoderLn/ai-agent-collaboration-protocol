// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @notice Chainlink VRF v2.5 的最小消费端接口，不实现或替代协调器的证明验证。
 * @dev 请求字段顺序与 Chainlink contracts 1.5.0 的 VRFV2PlusClient 完全一致。
 * 只保留本项目使用的 ABI，避免为一个请求引入协调器、LINK 代币和其他预言机实现。
 * extraArgs 使用 bytes4(keccak256("VRF ExtraArgsV1")) + abi.encode(bool)。
 */
interface IVRFV2PlusCoordinator {
    // 官方来源：https://cdn.jsdelivr.net/npm/@chainlink/contracts@1.5.0/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol
    struct RandomWordsRequest {
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }

    function requestRandomWords(RandomWordsRequest calldata request) external returns (uint256 requestId);
}
