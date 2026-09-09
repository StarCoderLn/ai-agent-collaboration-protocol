import { afterEach, describe, expect, it, vi } from "vitest";

/** 奖励先上线不能顺带改变旧任务的仲裁协议；这里只检查配置边界，不连接 RPC 或发交易。 */
describe("奖励与新案件独立启用", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("仅配置奖励目录时，旧任务继续使用原仲裁入口", async () => {
    vi.stubEnv("ARBITRATION_CASES_CONTRACT_ADDRESS", "");
    vi.stubEnv("DAO_REWARD_CASE_ADDRESS", `0x${"11".repeat(20)}`);
    vi.stubEnv("ARBITRATION_DAO_CHAIN_ID", "31337");
    vi.stubEnv("ESCROW_CHAIN_ID", "31337");
    vi.stubEnv("ARBITRATION_CASES_REQUIRED_CONFIRMATIONS", "2");
    vi.stubEnv("ETHEREUM_RPC_URL", "http://127.0.0.1:8545");
    const runtime = await import("./dao-case-runtime");
    expect(runtime.getDaoCaseRuntime()).toBeNull();
    const rewards = runtime.getDaoRewardRuntime();
    expect(rewards?.chain.contractAddress).toBe(`0x${"11".repeat(20)}`);
    expect(runtime.getDaoCaseRuntime()).toBeNull();
    rewards?.provider.destroy();
  });

  it("奖励和正式案件目录同时配置时不得指向不同案件合约", async () => {
    vi.stubEnv("ARBITRATION_CASES_CONTRACT_ADDRESS", `0x${"22".repeat(20)}`);
    vi.stubEnv("DAO_REWARD_CASE_ADDRESS", `0x${"11".repeat(20)}`);
    const runtime = await import("./dao-case-runtime");
    expect(() => runtime.getDaoRewardRuntime()).toThrow("REWARD_CASE_DIRECTORY_MISMATCH");
  });

  it("没有配置任何目录时不隐式创建发奖器", async () => {
    vi.stubEnv("ARBITRATION_CASES_CONTRACT_ADDRESS", "");
    vi.stubEnv("DAO_REWARD_CASE_ADDRESS", "");
    const runtime = await import("./dao-case-runtime");
    expect(runtime.getDaoRewardRuntime()).toBeNull();
    await expect(runtime.createLocalDaoRewardWorker()).resolves.toBeNull();
  });
});
