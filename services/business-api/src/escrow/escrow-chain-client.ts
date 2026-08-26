import {
  getAddress,
  Interface,
  JsonRpcProvider,
  keccak256,
  toUtf8Bytes,
  type Log,
} from "ethers";

const ESCROW_ABI = [
  "event Deposited(bytes32 indexed taskId,address indexed payer,uint256 amount)",
  "event Released(bytes32 indexed taskId,address indexed payee,uint256 escrowAmount,uint256 agentGrossAmount,uint256 feeAmount,uint256 payerRefundAmount)",
  "event Refunded(bytes32 indexed taskId,address indexed payer,uint256 amount)",
  "function deposit(bytes32 taskId) payable",
  "function release(bytes32 taskId,address payee,uint256 agentGrossAmount,uint256 feeAmount)",
  "function refund(bytes32 taskId)",
  "function escrowOf(bytes32 taskId) view returns ((address payer,uint256 amount,uint8 state))",
] as const;

const escrowInterface = new Interface(ESCROW_ABI);

export type EscrowEventPayload =
  | Readonly<{ type: "Deposited"; payer: string; escrowAmountWei: bigint }>
  | Readonly<{
    type: "Released";
    payee: string;
    escrowAmountWei: bigint;
    agentGrossAmountWei: bigint;
    feeAmountWei: bigint;
    payerRefundAmountWei: bigint;
  }>
  | Readonly<{ type: "Refunded"; payer: string; escrowAmountWei: bigint }>;

export type ObservedEscrowEvent = Readonly<{
  chainId: bigint;
  contractAddress: string;
  taskKey: string;
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockHash: string;
  payload: EscrowEventPayload;
}>;

export type OnchainEscrowRecord = Readonly<{
  payer: string;
  amountWei: bigint;
  state: "none" | "deposited" | "released" | "refunded";
}>;

export interface EscrowChainClient {
  readonly chainId: bigint;
  readonly contractAddress: string;
  getHeadBlockNumber(): Promise<bigint>;
  getBlockHash(blockNumber: bigint): Promise<string | null>;
  getEvents(fromBlock: bigint, toBlock: bigint): Promise<readonly ObservedEscrowEvent[]>;
  getEscrow(taskKey: string): Promise<OnchainEscrowRecord>;
}

/**
 * 生产 JSON-RPC 适配器只负责把 ethers 的动态 Result/Log 转成可信领域类型。
 * 游标、确认数、幂等和任务迁移全部留在服务/仓储层，避免网络 SDK 语义泄漏到业务代码。
 */
export class EthersEscrowChainClient implements EscrowChainClient {
  readonly contractAddress: string;

  constructor(
    private readonly provider: JsonRpcProvider,
    readonly chainId: bigint,
    contractAddress: string,
  ) {
    this.contractAddress = normalizeAddress(contractAddress);
  }

  async getHeadBlockNumber(): Promise<bigint> {
    return BigInt(await this.provider.getBlockNumber());
  }

  async getBlockHash(blockNumber: bigint): Promise<string | null> {
    const block = await this.provider.getBlock(blockNumber);
    return block?.hash?.toLowerCase() ?? null;
  }

  async getEvents(fromBlock: bigint, toBlock: bigint): Promise<readonly ObservedEscrowEvent[]> {
    if (fromBlock < 0n || toBlock < fromBlock) throw new Error("INVALID_BLOCK_RANGE");
    const logs = await this.provider.getLogs({
      address: this.contractAddress,
      fromBlock,
      toBlock,
      topics: [[
        eventTopic("Deposited"),
        eventTopic("Released"),
        eventTopic("Refunded"),
      ]],
    });
    return logs.map((log) => parseEscrowLog(log, this.chainId, this.contractAddress));
  }

  async getEscrow(taskKey: string): Promise<OnchainEscrowRecord> {
    assertBytes32(taskKey, "INVALID_TASK_KEY");
    const encoded = escrowInterface.encodeFunctionData("escrowOf", [taskKey]);
    const raw = await this.provider.call({ to: this.contractAddress, data: encoded });
    const decoded = escrowInterface.decodeFunctionResult("escrowOf", raw);
    const tuple = decoded[0];
    if (!isTupleResult(tuple)) throw new Error("INVALID_ESCROW_RESPONSE");
    const state = toEscrowState(Number(tuple[2]));
    return { payer: normalizeAddress(String(tuple[0])), amountWei: BigInt(String(tuple[1])), state };
  }
}

/** 合约与前端共同使用的确定性 taskId→bytes32 规则，禁止各调用方自行散列。 */
export function taskKeyForTaskId(taskId: string): string {
  const normalized = taskId.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new Error("INVALID_TASK_ID");
  }
  return keccak256(toUtf8Bytes(normalized));
}

/** 前端只接收已编码 calldata，不需要复制 ABI 或 taskKey 派生规则。 */
export function encodeDepositCall(taskKey: string): string {
  assertBytes32(taskKey, "INVALID_TASK_KEY");
  return escrowInterface.encodeFunctionData("deposit", [taskKey]);
}

export function encodeReleaseCall(taskKey: string, payee: string, agentGrossAmount: bigint, feeAmount: bigint): string {
  assertBytes32(taskKey, "INVALID_TASK_KEY");
  if (agentGrossAmount < 0n || feeAmount < 0n || feeAmount > agentGrossAmount) throw new Error("INVALID_RELEASE_AMOUNT");
  return escrowInterface.encodeFunctionData("release", [taskKey, normalizeAddress(payee), agentGrossAmount, feeAmount]);
}

export function encodeRefundCall(taskKey: string): string {
  assertBytes32(taskKey, "INVALID_TASK_KEY");
  return escrowInterface.encodeFunctionData("refund", [taskKey]);
}

function parseEscrowLog(log: Log, chainId: bigint, contractAddress: string): ObservedEscrowEvent {
  const parsed = escrowInterface.parseLog(log);
  if (parsed === null) throw new Error("UNKNOWN_ESCROW_EVENT");
  const taskKey = String(parsed.args[0]).toLowerCase();
  assertBytes32(taskKey, "INVALID_TASK_KEY");
  const common = {
    chainId,
    contractAddress,
    taskKey,
    txHash: normalizedHash(log.transactionHash),
    logIndex: log.index,
    blockNumber: BigInt(log.blockNumber),
    blockHash: normalizedHash(log.blockHash),
  };
  if (parsed.name === "Deposited") {
    return { ...common, payload: { type: "Deposited", payer: normalizeAddress(String(parsed.args[1])), escrowAmountWei: BigInt(String(parsed.args[2])) } };
  }
  if (parsed.name === "Released") {
    return {
      ...common,
      payload: {
        type: "Released",
        payee: normalizeAddress(String(parsed.args[1])),
        escrowAmountWei: BigInt(String(parsed.args[2])),
        agentGrossAmountWei: BigInt(String(parsed.args[3])),
        feeAmountWei: BigInt(String(parsed.args[4])),
        payerRefundAmountWei: BigInt(String(parsed.args[5])),
      },
    };
  }
  if (parsed.name === "Refunded") {
    return { ...common, payload: { type: "Refunded", payer: normalizeAddress(String(parsed.args[1])), escrowAmountWei: BigInt(String(parsed.args[2])) } };
  }
  throw new Error("UNKNOWN_ESCROW_EVENT");
}

function normalizeAddress(value: string): string {
  return getAddress(value).toLowerCase();
}
function normalizedHash(value: string): string {
  const normalized = value.toLowerCase();
  assertBytes32(normalized, "INVALID_CHAIN_HASH");
  return normalized;
}
function assertBytes32(value: string, code: string): void {
  if (!/^0x[0-9a-f]{64}$/.test(value)) throw new Error(code);
}
function isTupleResult(value: unknown): value is Readonly<{ 0: unknown; 1: unknown; 2: unknown }> {
  return typeof value === "object" && value !== null && 0 in value && 1 in value && 2 in value;
}
function toEscrowState(value: number): OnchainEscrowRecord["state"] {
  if (value === 0) return "none";
  if (value === 1) return "deposited";
  if (value === 2) return "released";
  if (value === 3) return "refunded";
  throw new Error("INVALID_ESCROW_STATE");
}

function eventTopic(name: "Deposited" | "Released" | "Refunded"): string {
  const fragment = escrowInterface.getEvent(name);
  if (fragment === null) throw new Error("ESCROW_ABI_EVENT_NOT_FOUND");
  return fragment.topicHash;
}

export function createJsonRpcEscrowClient(input: Readonly<{ rpcUrl: string; chainId: bigint; contractAddress: string }>): EscrowChainClient {
  return new EthersEscrowChainClient(new JsonRpcProvider(input.rpcUrl, Number(input.chainId), { staticNetwork: true }), input.chainId, input.contractAddress);
}
