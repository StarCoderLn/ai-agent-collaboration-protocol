// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {ArbitrationCases} from "../src/ArbitrationCases.sol";
import {ArbitrationRewards} from "../src/ArbitrationRewards.sol";
import {ArbitrationDAO} from "../src/ArbitrationDAO.sol";
import {Escrow} from "../src/Escrow.sol";

/**
 * @notice 独立案件部署接线脚本，默认 forge script 仅模拟，显式 --broadcast 才会广播。
 * @dev 不生成私钥、不创建免费领币入口、不填默认收费、不充值或修改已有成员质押。
 * 必须使用支持 bindArbitrationCases 的新 Escrow 部署；旧不可升级合约不能靠改配置升级。
 * VRF subscription 的充值与 addConsumer 仍由订阅所有者在官方界面确认。
 */
contract DeployArbitrationCases is Script {
    struct DeploymentConfig {
        address admin;
        address registrar;
        address recoveryResolver;
        address treasury;
        ArbitrationDAO membership;
        ArbitrationRewards existingRewards;
        Escrow escrow;
        address coordinator;
        ArbitrationCases.VrfConfig vrf;
        uint64 evidenceWindow;
        uint64 votingWindow;
        uint64 appealWindow;
        uint64 recoveryWindow;
        uint64 caseTimeout;
        uint16 timeoutFallbackBps;
    }

    function run() external returns (ArbitrationCases court, ArbitrationRewards rewards) {
        DeploymentConfig memory deployment = readConfig();
        require(address(deployment.escrow.arbitrationCases()) == address(0), "ESCROW_ALREADY_BOUND");
        require(deployment.registrar != address(0), "REGISTRAR_REQUIRED");
        require(deployment.recoveryResolver != address(0), "RECOVERY_RESOLVER_REQUIRED");

        vm.startBroadcast();
        rewards = deployment.existingRewards;
        if (address(rewards) == address(0)) {
            rewards = new ArbitrationRewards(deployment.admin, address(deployment.membership.ydToken()));
        } else {
            require(address(rewards.ydToken()) == address(deployment.membership.ydToken()), "REWARD_YD_MISMATCH");
        }
        court = new ArbitrationCases(
            deployment.admin,
            address(deployment.membership),
            address(rewards),
            address(deployment.escrow.paymentToken()),
            deployment.coordinator,
            deployment.treasury,
            deployment.vrf,
            ArbitrationCases.TimingConfig({
                evidenceWindow: deployment.evidenceWindow,
                votingWindow: deployment.votingWindow,
                appealWindow: deployment.appealWindow,
                recoveryWindow: deployment.recoveryWindow,
                caseTimeout: deployment.caseTimeout,
                timeoutFallbackBps: deployment.timeoutFallbackBps
            })
        );
        rewards.grantRole(rewards.CASE_ROLE(), address(court));
        court.grantRole(court.REGISTRAR_ROLE(), deployment.registrar);
        court.grantRole(court.RECOVERY_ROLE(), deployment.recoveryResolver);
        deployment.escrow.bindArbitrationCases(address(court));
        vm.stopBroadcast();

        console2.log("ArbitrationCases", address(court));
        console2.log("ArbitrationRewards", address(rewards));
        // 合约创建成功不意味着已启用：条款仍为 Unconfigured，且奖励池尚无资金。
        console2.log(
            "Terms and reward funding require separate explicit approval; VRF consumer registration is required."
        );
    }

    function readConfig() private view returns (DeploymentConfig memory deployment) {
        deployment.admin = vm.envAddress("DAO_CASE_ADMIN");
        deployment.registrar = vm.envAddress("ARBITRATION_CASE_OPERATOR_ADDRESS");
        deployment.recoveryResolver = vm.envAddress("DAO_CASE_RECOVERY_RESOLVER");
        deployment.treasury = vm.envAddress("DAO_CASE_FEE_TREASURY");
        deployment.membership = ArbitrationDAO(vm.envAddress("ARBITRATION_DAO_CONTRACT_ADDRESS"));
        deployment.existingRewards = ArbitrationRewards(vm.envOr("ARBITRATION_REWARDS_CONTRACT_ADDRESS", address(0)));
        deployment.escrow = Escrow(vm.envAddress("ESCROW_CONTRACT_ADDRESS"));
        deployment.coordinator = vm.envAddress("CHAINLINK_VRF_COORDINATOR");
        // 数值先以完整 uint256 读取再检查上界，禁止直接强转导致部署时静默截断配置。
        uint256 confirmations = vm.envUint("CHAINLINK_VRF_REQUEST_CONFIRMATIONS");
        uint256 callbackGas = vm.envUint("CHAINLINK_VRF_CALLBACK_GAS_LIMIT");
        require(confirmations <= type(uint16).max && callbackGas <= type(uint32).max, "VRF_CONFIG_OVERFLOW");
        deployment.vrf = ArbitrationCases.VrfConfig({
            keyHash: vm.envBytes32("CHAINLINK_VRF_KEY_HASH"),
            subscriptionId: vm.envUint("CHAINLINK_VRF_SUBSCRIPTION_ID"),
            confirmations: uint16(confirmations),
            callbackGasLimit: uint32(callbackGas),
            nativePayment: vm.envBool("CHAINLINK_VRF_NATIVE_PAYMENT")
        });
        deployment.evidenceWindow = window("DAO_CASE_EVIDENCE_SECONDS");
        deployment.votingWindow = window("DAO_CASE_VOTING_SECONDS");
        deployment.appealWindow = window("DAO_CASE_APPEAL_SECONDS");
        deployment.recoveryWindow = window("DAO_CASE_RECOVERY_SECONDS");
        deployment.caseTimeout = window("DAO_CASE_TIMEOUT_SECONDS");
        uint256 fallbackBps = vm.envUint("DAO_CASE_TIMEOUT_FALLBACK_BPS");
        require(fallbackBps <= 10_000, "CASE_FALLBACK_INVALID");
        // 上一行已验证 uint16 上界；保留显式窄化以让部署配置结构与链上字段一致。
        // forge-lint: disable-next-line(unsafe-typecast)
        deployment.timeoutFallbackBps = uint16(fallbackBps);
    }

    /// @dev 截止窗口只接受显式正整数，部署脚本不替产品方猜测申诉/举证周期。
    function window(string memory key) private view returns (uint64) {
        uint256 value = vm.envUint(key);
        require(value > 0 && value <= type(uint64).max, "CASE_WINDOW_INVALID");
        return uint64(value);
    }
}
