// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ArbitrationDAO} from "./ArbitrationDAO.sol";
import {ArbitrationRewards} from "./ArbitrationRewards.sol";
import {IVRFV2PlusCoordinator} from "./interfaces/IVRFV2PlusCoordinator.sol";

/**
 * @notice 独立链上案件账本：证据承诺、VRF 分案、三人首审、五人终审及申诉费用。
 * @dev 此合约不持有任务预算，也不能调用成员质押提款。正文保留在受权限保护的链下，
 * 当事人亲自提交的内容哈希不可覆写。链上哈希证明提交与一致性，不证明证据本身真实。
 * VRF 只负责在已冻结候选中抽样；候选名单仍由平台注册角色提交，并非完全无许可分案。
 */
contract ArbitrationCases is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");
    bytes32 public constant RECOVERY_ROLE = keccak256("RECOVERY_ROLE");
    uint256 public constant MAX_CANDIDATES = 256;
    uint256 public constant MAX_PARTIES = 65;

    enum Status {
        None,
        Evidence,
        AwaitingPanel,
        AwaitingRandomness,
        RandomnessReady,
        Voting,
        AppealWindow,
        Final,
        Stalled,
        Recovery
    }
    // 金额和保证金处分必须显式配置；部署后没有默认收费，Unconfigured 不接受新案。
    enum BondPolicy {
        Unconfigured,
        ReturnAlways,
        ReturnOnChangedDecision
    }

    struct Terms {
        uint256 rewardPerVote;
        uint256 appealBond;
        uint256 appealFee;
        BondPolicy bondPolicy;
    }

    struct VrfConfig {
        bytes32 keyHash;
        uint256 subscriptionId;
        uint16 confirmations;
        uint32 callbackGasLimit;
        bool nativePayment;
    }

    struct TimingConfig {
        uint64 evidenceWindow;
        uint64 votingWindow;
        uint64 appealWindow;
        uint64 recoveryWindow;
        uint64 caseTimeout;
        uint16 timeoutFallbackBps;
    }

    struct CaseRecord {
        bytes32 taskId;
        bytes32 evidenceRoot;
        Status status;
        uint8 round;
        uint64 evidenceDeadline;
        uint64 deadline;
        uint16 firstOutcome;
        uint16 outcome;
        bool firstHasMajority;
        address appellant;
        Terms terms;
    }

    struct Round {
        uint256 requestId;
        uint256 randomWord;
        bool fulfilled;
        bool rewardsClosed;
        bytes32 candidatesHash;
        address[] candidates;
        address[] panel;
        uint8 votes;
    }

    struct Vote {
        bool cast;
        uint16 releaseBps;
        bytes32 reasoningHash;
    }

    struct RequestRef {
        bytes32 caseId;
        uint8 round;
    }

    ArbitrationDAO public immutable membership;
    ArbitrationRewards public immutable rewards;
    IERC20 public immutable usdc;
    IVRFV2PlusCoordinator public immutable coordinator;
    address public immutable feeTreasury;
    uint64 public immutable evidenceWindow;
    uint64 public immutable votingWindow;
    uint64 public immutable appealWindow;
    uint64 public immutable recoveryWindow;
    uint64 public immutable caseTimeout;
    uint16 public immutable timeoutFallbackBps;
    VrfConfig public vrfConfig;
    Terms public terms;
    mapping(bytes32 caseId => CaseRecord) private cases;
    mapping(bytes32 taskId => bytes32 caseId) public caseForTask;
    mapping(bytes32 caseId => mapping(address party => bool allowed)) public isParty;
    // 收款钱包可能是独立财务地址：应排除其担任陪审员，但不能因此自动授予卷宗/申诉权限。
    mapping(bytes32 caseId => mapping(address actor => bool excluded)) public hasConflict;
    mapping(bytes32 caseId => mapping(bytes32 evidenceId => bool used)) private evidenceIds;
    mapping(bytes32 caseId => mapping(uint8 round => Round)) private rounds;
    mapping(bytes32 caseId => mapping(uint8 round => mapping(address member => Vote))) public votes;
    mapping(uint256 requestId => RequestRef) public requests;
    mapping(address recipient => uint256 amount) public usdcCredit;
    mapping(bytes32 caseId => bool settled) private bondSettled;
    mapping(bytes32 caseId => uint64 deadline) public recoveryEligibleAt;
    uint256 public lockedBonds;
    uint256 public owedUsdc;

    error InvalidInput();
    error InvalidState();
    error NotParty();
    error InvalidPanel();
    error NotCoordinator();
    error TermsNotConfigured();
    event TermsUpdated(uint256 rewardPerVote, uint256 appealBond, uint256 appealFee, BondPolicy bondPolicy);
    event CaseOpened(bytes32 indexed caseId, bytes32 indexed taskId, bytes32 evidenceRoot, uint64 evidenceDeadline);
    event EvidenceAnchored(
        bytes32 indexed caseId, bytes32 indexed evidenceId, address indexed submitter, bytes32 contentHash, bytes32 root
    );
    event RandomnessRequested(
        bytes32 indexed caseId, uint8 indexed round, uint256 indexed requestId, bytes32 candidatesHash
    );
    event RandomnessReceived(uint256 indexed requestId);
    event PanelSelected(bytes32 indexed caseId, uint8 indexed round, address[] panel, uint64 deadline);
    event VoteCast(
        bytes32 indexed caseId, uint8 indexed round, address indexed voter, uint16 releaseBps, bytes32 reasoningHash
    );
    event ProvisionalDecision(bytes32 indexed caseId, uint16 releaseBps, uint64 appealDeadline);
    event AppealOpened(bytes32 indexed caseId, address indexed appellant, uint256 bond, uint256 serviceFee);
    event RoundInconclusive(bytes32 indexed caseId, uint8 indexed round);
    event RecoveryDecision(bytes32 indexed caseId, uint16 releaseBps, bytes32 reasoningHash, address indexed resolver);
    event TimeoutFallback(bytes32 indexed caseId, uint16 releaseBps);
    event RecoveryOpened(bytes32 indexed caseId, uint64 deadline);
    event FinalDecision(bytes32 indexed caseId, uint16 releaseBps, bytes32 evidenceRoot);
    event UsdcClaimed(address indexed recipient, uint256 amount);

    constructor(
        address admin,
        address memberContract,
        address rewardContract,
        address paymentToken,
        address vrfCoordinator,
        address treasury,
        VrfConfig memory initialVrf,
        TimingConfig memory timing
    ) {
        uint256 minimumCaseTimeout = uint256(timing.evidenceWindow) + uint256(timing.votingWindow) * 2
            + uint256(timing.appealWindow);
        if (
            admin == address(0) || treasury == address(0) || memberContract.code.length == 0
                || rewardContract.code.length == 0 || paymentToken.code.length == 0 || vrfCoordinator.code.length == 0
                || timing.evidenceWindow == 0 || timing.votingWindow == 0 || timing.appealWindow == 0
                || timing.recoveryWindow == 0 || timing.caseTimeout <= minimumCaseTimeout
                || timing.timeoutFallbackBps > 10_000 || initialVrf.keyHash == bytes32(0)
                || initialVrf.subscriptionId == 0 || initialVrf.confirmations < 3
                || initialVrf.callbackGasLimit < 100_000
        ) revert InvalidInput();
        membership = ArbitrationDAO(memberContract);
        rewards = ArbitrationRewards(rewardContract);
        if (address(rewards.ydToken()) != address(membership.ydToken())) revert InvalidInput();
        usdc = IERC20(paymentToken);
        coordinator = IVRFV2PlusCoordinator(vrfCoordinator);
        feeTreasury = treasury;
        evidenceWindow = timing.evidenceWindow;
        votingWindow = timing.votingWindow;
        appealWindow = timing.appealWindow;
        recoveryWindow = timing.recoveryWindow;
        caseTimeout = timing.caseTimeout;
        timeoutFallbackBps = timing.timeoutFallbackBps;
        vrfConfig = initialVrf;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CONFIG_ROLE, admin);
    }

    /// @notice 只影响以后案件，已开案费率、保证金及奖励不会随管理员配置变化。
    function configureTerms(Terms calldata next) external onlyRole(CONFIG_ROLE) {
        if (
            next.rewardPerVote == 0 || next.rewardPerVote > type(uint256).max / 5
                || next.bondPolicy == BondPolicy.Unconfigured
        ) revert InvalidInput();
        terms = next;
        emit TermsUpdated(next.rewardPerVote, next.appealBond, next.appealFee, next.bondPolicy);
    }

    /**
     * @notice 平台先冻结业务资金，再登记任务参与方和已有交付证据根；所有运营及收款钱包
     * 都应纳入 parties。任务只能有一个案件，不允许换 caseId 绕过原裁决或重新抽签。
     * @dev 当事人名单是平台信任边界；独立合约无法自行证明链下任务属于哪些提供者。
     */
    function openCase(
        bytes32 caseId,
        bytes32 taskId,
        address[] calldata parties,
        address[] calldata excluded,
        bytes32 initialRoot
    ) external onlyRole(REGISTRAR_ROLE) nonReentrant {
        if (terms.bondPolicy == BondPolicy.Unconfigured) revert TermsNotConfigured();
        if (
            caseId == bytes32(0) || taskId == bytes32(0) || initialRoot == bytes32(0)
                || cases[caseId].status != Status.None || caseForTask[taskId] != bytes32(0) || parties.length == 0
                || parties.length > MAX_PARTIES || excluded.length < parties.length || excluded.length > MAX_PARTIES
        ) revert InvalidInput();
        for (uint256 i; i < excluded.length; ++i) {
            if (excluded[i] == address(0) || (i > 0 && excluded[i] <= excluded[i - 1])) revert InvalidInput();
            hasConflict[caseId][excluded[i]] = true;
        }
        for (uint256 i; i < parties.length; ++i) {
            if (!hasConflict[caseId][parties[i]] || (i > 0 && parties[i] <= parties[i - 1])) revert InvalidInput();
            isParty[caseId][parties[i]] = true;
        }
        CaseRecord storage c = cases[caseId];
        c.taskId = taskId;
        c.evidenceRoot = initialRoot;
        c.status = Status.Evidence;
        c.round = 1;
        c.evidenceDeadline = uint64(block.timestamp) + evidenceWindow;
        recoveryEligibleAt[caseId] = uint64(block.timestamp) + caseTimeout;
        c.terms = terms;
        caseForTask[taskId] = caseId;
        rewards.reserve(_reservation(caseId, 1), terms.rewardPerVote * 3);
        emit CaseOpened(caseId, taskId, initialRoot, c.evidenceDeadline);
    }

    /// @notice 当事人钱包自己提交承诺，记录提交者、证据 ID 与内容哈希；正文不公开上链。
    function submitEvidence(bytes32 caseId, bytes32 evidenceId, bytes32 contentHash) external {
        CaseRecord storage c = cases[caseId];
        if (!isParty[caseId][msg.sender]) revert NotParty();
        if (c.status != Status.Evidence || block.timestamp >= c.evidenceDeadline) revert InvalidState();
        if (evidenceId == bytes32(0) || contentHash == bytes32(0) || evidenceIds[caseId][evidenceId]) {
            revert InvalidInput();
        }
        evidenceIds[caseId][evidenceId] = true;
        c.evidenceRoot = keccak256(abi.encode(c.evidenceRoot, evidenceId, msg.sender, contentHash));
        emit EvidenceAnchored(caseId, evidenceId, msg.sender, contentHash, c.evidenceRoot);
    }

    /**
     * @notice 证据截止后冻结候选集合并发出唯一 VRF 请求。链上逐个核对当前质押资格、
     * 排除全部当事人及首审成员。名单排序保证去重，最多 256 人使 Gas 成本有明确上限。
     * @dev 候选不足时不发请求、也不降到小组人数以下。随机数请求失败整笔回滚，可原样
     * 重试；请求成功后没有取消、换名单或重新抽签入口，防止平台选择有利的随机结果。
     */
    function requestPanel(bytes32 caseId, address[] calldata candidates)
        external
        onlyRole(REGISTRAR_ROLE)
        nonReentrant
    {
        CaseRecord storage c = cases[caseId];
        if (c.status == Status.Evidence && block.timestamp >= c.evidenceDeadline) c.status = Status.AwaitingPanel;
        if (c.status != Status.AwaitingPanel) revert InvalidState();
        uint8 count = c.round == 1 ? 3 : 5;
        if (candidates.length < count || candidates.length > MAX_CANDIDATES) revert InvalidPanel();
        Round storage r = rounds[caseId][c.round];
        for (uint256 i; i < candidates.length; ++i) {
            address candidate = candidates[i];
            if (
                (i > 0 && candidate <= candidates[i - 1]) || !membership.isEligible(candidate)
                    || hasConflict[caseId][candidate] || (c.round == 2 && _inPanel(caseId, 1, candidate))
            ) revert InvalidPanel();
            r.candidates.push(candidate);
        }
        r.candidatesHash = keccak256(abi.encode(candidates));
        c.status = Status.AwaitingRandomness;
        VrfConfig memory config = vrfConfig;
        uint256 requestId = coordinator.requestRandomWords(
            IVRFV2PlusCoordinator.RandomWordsRequest({
                keyHash: config.keyHash,
                subId: config.subscriptionId,
                requestConfirmations: config.confirmations,
                callbackGasLimit: config.callbackGasLimit,
                numWords: 1,
                extraArgs: abi.encodeWithSelector(bytes4(keccak256("VRF ExtraArgsV1")), config.nativePayment)
            })
        );
        if (requestId == 0 || requests[requestId].caseId != bytes32(0)) revert InvalidInput();
        r.requestId = requestId;
        requests[requestId] = RequestRef(caseId, c.round);
        emit RandomnessRequested(caseId, c.round, requestId, r.candidatesHash);
    }

    /**
     * @notice 官方 VRF 协调器验证证明后调用此入口；普通钱包不能伪造随机结果。
     * @dev 回调只存随机数，不转账、不遍历候选、不依赖外部服务。未知/重复回调安全忽略，
     * 避免低 Gas 或重复交付把案件卡死。零随机数合法，使用 fulfilled 单独区分未返回。
     */
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata words) external {
        if (msg.sender != address(coordinator)) revert NotCoordinator();
        RequestRef memory ref = requests[requestId];
        if (ref.caseId == bytes32(0) || words.length != 1) return;
        Round storage r = rounds[ref.caseId][ref.round];
        if (r.fulfilled) return;
        r.randomWord = words[0];
        r.fulfilled = true;
        cases[ref.caseId].status = Status.RandomnessReady;
        emit RandomnessReceived(requestId);
    }

    /// @notice 任何人可推进已回调的案件；抽样只依赖已冻结输入，与交易发送者及区块无关。
    function selectPanel(bytes32 caseId) external {
        CaseRecord storage c = cases[caseId];
        if (c.status != Status.RandomnessReady) revert InvalidState();
        Round storage r = rounds[caseId][c.round];
        address[] memory remaining = r.candidates;
        uint256 count = c.round == 1 ? 3 : 5;
        for (uint256 i; i < count; ++i) {
            uint256 size = remaining.length - i;
            uint256 sample = uint256(keccak256(abi.encode(r.randomWord, caseId, c.round, i)));
            // 拒绝采样消除模偏差；派生新样本也不使用区块或调用者可影响的信息。
            uint256 threshold = (type(uint256).max - size + 1) % size;
            while (sample < threshold) sample = uint256(keccak256(abi.encode(sample)));
            uint256 selected = sample % size;
            r.panel.push(remaining[selected]);
            remaining[selected] = remaining[size - 1];
        }
        c.status = Status.Voting;
        c.deadline = uint64(block.timestamp) + votingWindow;
        emit PanelSelected(caseId, c.round, r.panel, c.deadline);
    }

    /// @notice 投票绑定当前钱包、案件、轮次，已投不可覆写。退出质押不抹掉既有案件的义务。
    function vote(bytes32 caseId, uint16 releaseBps, bytes32 reasoningHash) external {
        CaseRecord storage c = cases[caseId];
        if (c.status != Status.Voting || block.timestamp >= c.deadline) revert InvalidState();
        if (!_inPanel(caseId, c.round, msg.sender) || votes[caseId][c.round][msg.sender].cast) revert InvalidPanel();
        if (releaseBps > 10_000 || reasoningHash == bytes32(0)) revert InvalidInput();
        votes[caseId][c.round][msg.sender] = Vote(true, releaseBps, reasoningHash);
        rounds[caseId][c.round].votes++;
        emit VoteCast(caseId, c.round, msg.sender, releaseBps, reasoningHash);
    }

    /**
     * @notice 全员投票或期限结束后才计票，保障每名成员的参与机会。类型多数：全退、
     * 部分付、全付；部分支付取多数类型中的上中位数，避免浮点与非确定性舍入。
     * @dev 首审无多数免费升级五人终审；终审仍无多数进入 Stalled，绝不默认退款。
     * 奖励池不足时升级事务回滚，保留到期首审并可充值后重试，不会提前结算。
     */
    function closeRound(bytes32 caseId) external nonReentrant {
        CaseRecord storage c = cases[caseId];
        Round storage r = rounds[caseId][c.round];
        if (c.status != Status.Voting || (block.timestamp < c.deadline && r.votes < r.panel.length)) {
            revert InvalidState();
        }
        (bool majority, uint16 outcome) = _outcome(caseId, c.round);
        _payParticipation(caseId, c.round);
        if (c.round == 1) {
            c.firstHasMajority = majority;
            c.firstOutcome = outcome;
            if (majority) {
                c.outcome = outcome;
                c.status = Status.AppealWindow;
                c.deadline = uint64(block.timestamp) + appealWindow;
                emit ProvisionalDecision(caseId, outcome, c.deadline);
            } else {
                _startAppealRound(caseId);
                emit RoundInconclusive(caseId, 1);
            }
        } else if (majority) {
            c.outcome = outcome;
            _finalize(caseId);
        } else {
            _enterRecovery(caseId, c);
            emit RoundInconclusive(caseId, 2);
        }
    }

    /**
     * @notice 抽签、成员或外部服务长期故障超过全案硬期限时，任何人都能转入有限恢复期。
     * @dev 该入口不直接决定资金归属，只终止无法推进的普通流程并结清已投票者奖励预留。
     */
    function enterRecovery(bytes32 caseId) external nonReentrant {
        CaseRecord storage c = cases[caseId];
        if (
            c.status == Status.None || c.status == Status.Final || c.status == Status.Stalled
                || c.status == Status.Recovery || block.timestamp < recoveryEligibleAt[caseId]
        ) revert InvalidState();
        _enterRecovery(caseId, c);
    }

    /**
     * @notice 终审参与不足时，恢复角色可在硬截止前依据完整卷宗作出可审计裁决。
     * @dev 生产环境应把 RECOVERY_ROLE 交给独立多签；理由只上链保存承诺，正文仍留在私密卷宗。
     */
    function resolveRecovery(bytes32 caseId, uint16 releaseBps, bytes32 reasoningHash)
        external
        onlyRole(RECOVERY_ROLE)
        nonReentrant
    {
        CaseRecord storage c = cases[caseId];
        if (c.status != Status.Recovery || block.timestamp >= c.deadline) revert InvalidState();
        if (releaseBps > 10_000 || reasoningHash == bytes32(0)) revert InvalidInput();
        c.outcome = releaseBps;
        emit RecoveryDecision(caseId, releaseBps, reasoningHash, msg.sender);
        _finalize(caseId);
    }

    /// @notice 恢复窗口结束后任何人都能执行部署时公开的兜底比例，资金不会永久冻结。
    function finalizeRecovery(bytes32 caseId) external nonReentrant {
        CaseRecord storage c = cases[caseId];
        if (c.status != Status.Recovery || block.timestamp < c.deadline) revert InvalidState();
        c.outcome = timeoutFallbackBps;
        emit TimeoutFallback(caseId, c.outcome);
        _finalize(caseId);
    }

    /// @notice 当事人最多申诉一次，USDC 保证金和服务费单独入账，永不读取或扣减任务预算。
    function appeal(bytes32 caseId) external nonReentrant {
        CaseRecord storage c = cases[caseId];
        if (!isParty[caseId][msg.sender]) revert NotParty();
        if (c.status != Status.AppealWindow || block.timestamp >= c.deadline) revert InvalidState();
        _startAppealRound(caseId);
        c.appellant = msg.sender;
        uint256 total = c.terms.appealBond + c.terms.appealFee;
        lockedBonds += c.terms.appealBond;
        _creditUsdc(feeTreasury, c.terms.appealFee);
        if (total > 0) {
            uint256 beforeBalance = usdc.balanceOf(address(this));
            usdc.safeTransferFrom(msg.sender, address(this), total);
            if (usdc.balanceOf(address(this)) - beforeBalance != total) revert InvalidInput();
        }
        emit AppealOpened(caseId, msg.sender, c.terms.appealBond, c.terms.appealFee);
    }

    /// @notice 未申诉且窗口到期才可确定首审结果；任何角色都没有跳过等待窗口的入口。
    function finalizeUnappealed(bytes32 caseId) external nonReentrant {
        CaseRecord storage c = cases[caseId];
        if (c.status != Status.AppealWindow || block.timestamp < c.deadline) revert InvalidState();
        _finalize(caseId);
    }

    /// @notice 提取已记账的保证金退款或服务费；提款失败不影响案件终审结果。
    function claimUsdc() external nonReentrant {
        uint256 amount = usdcCredit[msg.sender];
        if (amount == 0) revert InvalidInput();
        usdcCredit[msg.sender] = 0;
        owedUsdc -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit UsdcClaimed(msg.sender, amount);
    }

    /// @notice 供托管执行端读取唯一链上裁决；非 Final 必须保持冻结。
    function settlementFor(bytes32 taskId)
        external
        view
        returns (bool exists, bool finalDecision, uint16 releaseBps, bytes32 root)
    {
        bytes32 id = caseForTask[taskId];
        CaseRecord storage c = cases[id];
        return (id != bytes32(0), c.status == Status.Final, c.outcome, c.evidenceRoot);
    }

    /// @notice 查询公开状态；业务正文和附件永不从合约返回。
    function caseOf(bytes32 caseId) external view returns (CaseRecord memory) {
        return cases[caseId];
    }

    /// @notice 返回抽签审计所需的候选快照和小组，前端可自行复算 VRF 派生抽样结果。
    function roundOf(bytes32 caseId, uint8 round) external view returns (Round memory) {
        return rounds[caseId][round];
    }

    /// @dev 在收取申诉费用之前先预留终审奖励，失败则保持首审状态与当事人余额不变。
    function _startAppealRound(bytes32 caseId) private {
        CaseRecord storage c = cases[caseId];
        rewards.reserve(_reservation(caseId, 2), c.terms.rewardPerVote * 5);
        c.round = 2;
        c.status = Status.AwaitingPanel;
    }

    /// @dev 每轮预留最多结清一次；未投票席位的余额立即回到奖励池，不与任务 USDC 混用。
    function _enterRecovery(bytes32 caseId, CaseRecord storage c) private {
        Round storage first = rounds[caseId][1];
        if (!first.rewardsClosed) _payParticipation(caseId, 1);
        if (c.round == 2) {
            Round storage second = rounds[caseId][2];
            if (!second.rewardsClosed) _payParticipation(caseId, 2);
        }
        c.status = Status.Recovery;
        c.deadline = uint64(block.timestamp) + recoveryWindow;
        // 无终审结论不能认定申诉败诉。退回保证金，服务费仍按开案条款留在独立池。
        _releaseBond(caseId, c, c.appellant);
        emit RecoveryOpened(caseId, c.deadline);
    }

    /// @dev 结案先归还或转记保证金，只有最终结果才可被资金执行端消费。
    function _finalize(bytes32 caseId) private {
        CaseRecord storage c = cases[caseId];
        c.status = Status.Final;
        if (c.appellant != address(0)) {
            bool refund = c.terms.bondPolicy == BondPolicy.ReturnAlways || c.outcome != c.firstOutcome;
            _releaseBond(caseId, c, refund ? c.appellant : feeTreasury);
        }
        emit FinalDecision(caseId, c.outcome, c.evidenceRoot);
    }

    /// @dev 保证金只在申诉方存在时预留，首审自动升级没有收费或虚构保证金。
    function _releaseBond(bytes32 caseId, CaseRecord storage c, address recipient) private {
        if (c.appellant == address(0) || bondSettled[caseId]) return;
        bondSettled[caseId] = true;
        uint256 amount = c.terms.appealBond;
        lockedBonds -= amount;
        _creditUsdc(recipient, amount);
    }

    /// @dev 应付账与仍锁定的保证金分账，余额不得靠任务托管补足。
    function _creditUsdc(address recipient, uint256 amount) private {
        usdcCredit[recipient] += amount;
        owedUsdc += amount;
    }

    /// @dev 使用域、合约和轮次构造预留 ID，跨案件/跨合约不能复用同一笔预算。
    function _reservation(bytes32 caseId, uint8 round) private view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), caseId, round));
    }

    /// @dev 成员查询至多五次，避免将可变大小候选扫描放在每次投票路径。
    function _inPanel(bytes32 caseId, uint8 round, address member) private view returns (bool) {
        address[] storage panel = rounds[caseId][round].panel;
        for (uint256 i; i < panel.length; ++i) {
            if (panel[i] == member) return true;
        }
        return false;
    }

    /// @dev 发奖使用一次性标记与金库预留双重保护，重放 closeRound 不会重复增加领取余额。
    function _payParticipation(bytes32 caseId, uint8 round) private {
        Round storage r = rounds[caseId][round];
        if (r.rewardsClosed) revert InvalidState();
        r.rewardsClosed = true;
        bytes32 reservation = _reservation(caseId, round);
        for (uint256 i; i < r.panel.length; ++i) {
            if (votes[caseId][round][r.panel[i]].cast) {
                rewards.allocate(reservation, r.panel[i], cases[caseId].terms.rewardPerVote);
            }
        }
        rewards.close(reservation);
    }

    /// @dev 首审保持类型多数；五人终审达到三票后取全部比例中位数，避免 2-2-1 分类僵局。
    function _outcome(bytes32 caseId, uint8 round) private view returns (bool, uint16) {
        address[] storage panel = rounds[caseId][round].panel;
        if (round == 2) return _medianOutcome(caseId, panel);
        uint8[3] memory counts;
        uint16[5] memory partialVotes;
        for (uint256 i; i < panel.length; ++i) {
            Vote memory v = votes[caseId][round][panel[i]];
            if (!v.cast) continue;
            if (v.releaseBps == 0) {
                counts[0]++;
            } else if (v.releaseBps == 10_000) {
                counts[2]++;
            } else {
                partialVotes[counts[1]] = v.releaseBps;
                counts[1]++;
            }
        }
        uint256 quorum = panel.length / 2 + 1;
        if (counts[0] >= quorum) return (true, 0);
        if (counts[2] >= quorum) return (true, 10_000);
        if (counts[1] < quorum) return (false, 0);
        for (uint256 i = 1; i < counts[1]; ++i) {
            uint16 value = partialVotes[i];
            uint256 j = i;
            while (j > 0 && partialVotes[j - 1] > value) {
                partialVotes[j] = partialVotes[j - 1];
                --j;
            }
            partialVotes[j] = value;
        }
        return (true, partialVotes[counts[1] / 2]);
    }

    /// @dev 终审小组固定最多五人；偶数票取中间两票的向下平均，舍入规则不依赖链下实现。
    function _medianOutcome(bytes32 caseId, address[] storage panel) private view returns (bool, uint16) {
        uint16[5] memory cast;
        uint256 count;
        for (uint256 i; i < panel.length; ++i) {
            Vote memory current = votes[caseId][2][panel[i]];
            if (current.cast) cast[count++] = current.releaseBps;
        }
        if (count < panel.length / 2 + 1) return (false, 0);
        for (uint256 i = 1; i < count; ++i) {
            uint16 value = cast[i];
            uint256 j = i;
            while (j > 0 && cast[j - 1] > value) {
                cast[j] = cast[j - 1];
                --j;
            }
            cast[j] = value;
        }
        if (count % 2 == 1) return (true, cast[count / 2]);
        return (true, uint16((uint256(cast[count / 2 - 1]) + cast[count / 2]) / 2));
    }
}
