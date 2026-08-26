import { describe, expect, it } from "vitest";

import { createJsonRpcEscrowClient, taskKeyForTaskId } from "./escrow-chain-client";

const RPC_URL = process.env.ESCROW_TEST_RPC_URL;
const CONTRACT_ADDRESS = process.env.ESCROW_TEST_CONTRACT_ADDRESS;
const integration = RPC_URL === undefined || CONTRACT_ADDRESS === undefined ? describe.skip : describe;
const TASK_ID = "11111111-1111-4111-8111-111111111111";

/**
 * 该测试需要本机 Anvil 和已部署合约，因此默认跳过。它验证的不是 mock，而是 ethers
 * 对真实 receipt 日志、ABI tuple 返回值和 bytes32 taskKey 的完整解析。
 */
integration("escrow Anvil contract adapter", () => {
  it("reads a real Deposited log and escrowOf record", async () => {
    const client = createJsonRpcEscrowClient({
      rpcUrl: required(RPC_URL),
      chainId: 31_337n,
      contractAddress: required(CONTRACT_ADDRESS),
    });
    const head = await client.getHeadBlockNumber();
    const events = await client.getEvents(0n, head);
    const deposit = events.find((event) => event.taskKey === taskKeyForTaskId(TASK_ID));
    expect(deposit).toMatchObject({
      chainId: 31_337n,
      contractAddress: required(CONTRACT_ADDRESS).toLowerCase(),
      taskKey: "0x31e5891f6803041a37cfae842c5bf47aa89df5130d6a8ba235cdd9041744763f",
      logIndex: 0,
      payload: {
        type: "Deposited",
        payer: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        escrowAmountWei: 2_000_000_000_000_000_000n,
      },
    });
    await expect(client.getEscrow(taskKeyForTaskId(TASK_ID))).resolves.toEqual({
      payer: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      amountWei: 2_000_000_000_000_000_000n,
      state: "deposited",
    });
  });
});

function required(value: string | undefined): string {
  if (value === undefined) throw new Error("ANVIL_TEST_ENV_REQUIRED");
  return value;
}
