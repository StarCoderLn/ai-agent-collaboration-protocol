import { getAddress, Interface, JsonRpcProvider } from "ethers";

const DAO_ABI = [
  "event StakeAdded(address indexed member,uint256 amount,uint256 totalStake)",
  "event ExitRequested(address indexed member,uint64 availableAt)",
  "event ExitCancelled(address indexed member)",
  "event StakeWithdrawn(address indexed member,uint256 amount)",
  "function ydToken() view returns (address)",
  "function minimumStake() view returns (uint256)",
  "function membershipOf(address member) view returns ((uint256 stakedAmount,uint64 exitAvailableAt))",
  "function isEligible(address member) view returns (bool)",
] as const;

const daoInterface = new Interface(DAO_ABI);

export type DaoMembershipAction = "stake" | "request_exit" | "cancel_exit" | "withdraw";

export type DaoMembershipSnapshot = Readonly<{
  actorId: string;
  chainId: bigint;
  contractAddress: string;
  ydTokenAddress: string;
  stakedAmountMinor: bigint;
  minimumStakeMinor: bigint;
  eligible: boolean;
  exitAvailableAt: Date | null;
  syncTxHash: string;
  syncBlockNumber: bigint;
  action: DaoMembershipAction;
}>;

type DaoReceipt = Readonly<{
  status: number | null;
  to: string | null;
  blockNumber: number;
  logs: readonly Readonly<{ address: string; topics: readonly string[]; data: string }>[];
}>;

/**
 * 只暴露 DAO 适配器实际需要的 RPC 能力，测试可以注入确定性实现，也避免业务层依赖
 * ethers 的完整 Provider 接口。区块标签必须与会员交易回执一致，防止用未来状态替换
 * 当次质押交易所证明的链上事实。
 */
export interface DaoRpcProvider {
  getTransactionReceipt(txHash: string): Promise<DaoReceipt | null>;
  getBlockNumber(): Promise<number>;
  call(transaction: Readonly<{ to: string; data: string }>, blockTag?: number): Promise<string>;
}

export interface DaoMembershipChainClient {
  readonly chainId: bigint;
  readonly contractAddress: string;
  readonly ydTokenAddress: string;
  verifyMembershipTransaction(txHash: string, actorId: string): Promise<DaoMembershipSnapshot>;
}

/**
 * 会员同步不是“相信浏览器上报余额”，而是由服务端核验成功回执、事件成员、确认数，
 * 再在该回执区块读取完整 membership。这样普通钱包无法仅提交任意交易哈希获得仲裁权。
 */
export class EthersDaoMembershipChainClient implements DaoMembershipChainClient {
  readonly contractAddress: string;
  readonly ydTokenAddress: string;

  constructor(
    private readonly provider: DaoRpcProvider,
    readonly chainId: bigint,
    contractAddress: string,
    ydTokenAddress: string,
    private readonly requiredConfirmations: bigint,
  ) {
    this.contractAddress = normalizedAddress(contractAddress);
    this.ydTokenAddress = normalizedAddress(ydTokenAddress);
    if (chainId <= 0n || requiredConfirmations <= 0n) throw new Error("INVALID_DAO_CHAIN_CONFIG");
  }

  async verifyMembershipTransaction(txHash: string, actorId: string): Promise<DaoMembershipSnapshot> {
    const normalizedTxHash = normalizedHash(txHash);
    const normalizedActor = normalizedAddress(actorId);
    const receipt = await this.provider.getTransactionReceipt(normalizedTxHash);
    if (receipt === null) throw new Error("DAO_TRANSACTION_NOT_FOUND");
    if (receipt.status !== 1) throw new Error("DAO_TRANSACTION_REVERTED");
    if (receipt.to === null || normalizedAddress(receipt.to) !== this.contractAddress) {
      throw new Error("DAO_TRANSACTION_CONTRACT_MISMATCH");
    }
    const confirmations = BigInt(await this.provider.getBlockNumber() - receipt.blockNumber + 1);
    if (confirmations < this.requiredConfirmations) throw new Error("DAO_TRANSACTION_NOT_CONFIRMED");
    const action = membershipActionFromReceipt(receipt.logs, this.contractAddress, normalizedActor);

    // 所有读取都固定在交易回执区块，确保返回的是“该交易确认后的成员快照”，而不是
    // 随后另一笔退出或追加质押交易产生的最新状态。
    const [membershipResult, eligibleResult, minimumStakeResult, ydTokenResult] = await Promise.all([
      this.callAt("membershipOf", [normalizedActor], receipt.blockNumber),
      this.callAt("isEligible", [normalizedActor], receipt.blockNumber),
      this.callAt("minimumStake", [], receipt.blockNumber),
      this.callAt("ydToken", [], receipt.blockNumber),
    ]);
    const membership = membershipResult[0];
    if (!tupleHasTwoValues(membership)) throw new Error("DAO_MEMBERSHIP_RESPONSE_INVALID");
    const exitTimestamp = BigInt(String(membership[1]));
    const resolvedYdToken = normalizedAddress(String(ydTokenResult[0]));
    if (resolvedYdToken !== this.ydTokenAddress) throw new Error("DAO_YD_TOKEN_MISMATCH");
    return {
      actorId: normalizedActor,
      chainId: this.chainId,
      contractAddress: this.contractAddress,
      ydTokenAddress: this.ydTokenAddress,
      stakedAmountMinor: BigInt(String(membership[0])),
      minimumStakeMinor: BigInt(String(minimumStakeResult[0])),
      eligible: Boolean(eligibleResult[0]),
      exitAvailableAt: exitTimestamp === 0n ? null : unixSecondsToDate(exitTimestamp),
      syncTxHash: normalizedTxHash,
      syncBlockNumber: BigInt(receipt.blockNumber),
      action,
    };
  }

  private async callAt(functionName: string, args: readonly unknown[], blockNumber: number) {
    const data = daoInterface.encodeFunctionData(functionName, [...args]);
    const raw = await this.provider.call({ to: this.contractAddress, data }, blockNumber);
    return daoInterface.decodeFunctionResult(functionName, raw);
  }
}

export function createJsonRpcDaoMembershipClient(input: Readonly<{
  rpcUrl: string;
  chainId: bigint;
  contractAddress: string;
  ydTokenAddress: string;
  requiredConfirmations: bigint;
}>): DaoMembershipChainClient {
  return new EthersDaoMembershipChainClient(
    new JsonRpcProvider(input.rpcUrl, Number(input.chainId), { staticNetwork: true }),
    input.chainId,
    input.contractAddress,
    input.ydTokenAddress,
    input.requiredConfirmations,
  );
}

function membershipActionFromReceipt(
  logs: readonly Readonly<{ address: string; topics: readonly string[]; data: string }>[],
  contractAddress: string,
  actorId: string,
): DaoMembershipAction {
  // 交易成功并不等于完成了当前用户的成员操作：同一回执必须包含 DAO 合约发出、且
  // indexed member 与登录钱包一致的事件，防止借用他人的成功交易同步资格。
  for (const log of logs) {
    if (normalizedAddress(log.address) !== contractAddress) continue;
    const parsed = daoInterface.parseLog(log);
    if (parsed === null || normalizedAddress(String(parsed.args[0])) !== actorId) continue;
    if (parsed.name === "StakeAdded") return "stake";
    if (parsed.name === "ExitRequested") return "request_exit";
    if (parsed.name === "ExitCancelled") return "cancel_exit";
    if (parsed.name === "StakeWithdrawn") return "withdraw";
  }
  throw new Error("DAO_MEMBERSHIP_EVENT_NOT_FOUND");
}

function normalizedAddress(value: string): string {
  return getAddress(value).toLowerCase();
}

function normalizedHash(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error("INVALID_TRANSACTION_HASH");
  return normalized;
}

function tupleHasTwoValues(value: unknown): value is Readonly<{ 0: unknown; 1: unknown }> {
  return typeof value === "object" && value !== null && 0 in value && 1 in value;
}

function unixSecondsToDate(value: bigint): Date {
  if (value > BigInt(Math.floor(8_640_000_000_000_000 / 1_000))) throw new Error("DAO_EXIT_TIME_INVALID");
  return new Date(Number(value) * 1_000);
}
