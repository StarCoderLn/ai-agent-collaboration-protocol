import assert from "node:assert/strict";
import test from "node:test";

process.env.AICP_LOCAL_MVP_TEST_MODE = "true";

const {
  LOCAL_DAO_MINIMUM_STAKE_MINOR,
  isLocalRewardWorkerEnabled,
  formatLocalYd,
  advanceLocalSettlementOnce,
  assertPortsAvailable,
  buildAnvilArguments,
  isReadyWebHtml,
  parseLocalDeployment,
  parseLocalMvpCommand,
  resolveLocalChainMode,
  terminateManagedProcesses,
  validateLocalDeployment,
  waitForService,
} = await import("./local-mvp.mjs");

const PAYMENT_TOKEN_ADDRESS = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const ESCROW_ADDRESS = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
const YD_TOKEN_ADDRESS = "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0";
const DAO_ADDRESS = "0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9";
const VALID_DEPLOYMENT = Object.freeze({
  version: 2,
  chainId: 31_337,
  paymentTokenAddress: PAYMENT_TOKEN_ADDRESS,
  escrowAddress: ESCROW_ADDRESS,
  ydTokenAddress: YD_TOKEN_ADDRESS,
  arbitrationDaoAddress: DAO_ADDRESS,
  daoMinimumStakeMinor: "100000000000000000000",
  createdAt: "2026-08-30T10:00:00.000Z",
});

test("奖励独立目录恢复调度，不要求同时启用新案件，也不在缺少 operator 时付款", () => {
  assert.equal(isLocalRewardWorkerEnabled({ DAO_REWARD_CASE_ADDRESS: DAO_ADDRESS, DAO_REWARD_OPERATOR_ADDRESS: ESCROW_ADDRESS }), true);
  assert.equal(isLocalRewardWorkerEnabled({ ARBITRATION_CASES_CONTRACT_ADDRESS: DAO_ADDRESS, DAO_REWARD_OPERATOR_ADDRESS: ESCROW_ADDRESS }), true);
  assert.equal(isLocalRewardWorkerEnabled({ DAO_REWARD_CASE_ADDRESS: DAO_ADDRESS }), false);
  assert.equal(isLocalRewardWorkerEnabled({ DAO_REWARD_OPERATOR_ADDRESS: ESCROW_ADDRESS }), false);
  assert.equal(isLocalRewardWorkerEnabled({ DAO_REWARD_CASE_ADDRESS: " ", DAO_REWARD_OPERATOR_ADDRESS: ESCROW_ADDRESS }), false);
});

test("新 DAO 默认 100 YD，恢复旧部署不暗改门槛，日志按实际金额显示", () => {
  // 1000 YD 是历史部署兼容样例，不是新的产品默认值；恢复启动不能代替管理员发配置交易。
  assert.equal(LOCAL_DAO_MINIMUM_STAKE_MINOR, "100000000000000000000");
  const legacy = parseLocalDeployment(JSON.stringify({ ...VALID_DEPLOYMENT, daoMinimumStakeMinor: "1000000000000000000000" }));
  assert.equal(legacy.daoMinimumStakeMinor, "1000000000000000000000");
  assert.equal(formatLocalYd(LOCAL_DAO_MINIMUM_STAKE_MINOR), "100");
  assert.equal(formatLocalYd(legacy.daoMinimumStakeMinor), "1000");
  assert.equal(formatLocalYd("100000000000000000001"), "100.000000000000000001");
});

test("本地链状态与部署清单必须成对出现", () => {
  assert.equal(resolveLocalChainMode(false, false), "fresh");
  assert.equal(resolveLocalChainMode(true, true), "restore");
  assert.throws(() => resolveLocalChainMode(true, false), /状态文件存在.*部署清单缺失/);
  assert.throws(() => resolveLocalChainMode(false, true), /部署清单存在.*状态文件缺失/);
});

test("Anvil 启动参数持续保存并恢复项目私有状态", () => {
  assert.deepEqual(
    buildAnvilArguments({ host: "127.0.0.1", port: 8545, chainId: 31_337, statePath: "/project/.local/anvil/state.json" }),
    [
      "--host", "127.0.0.1",
      "--port", "8545",
      "--chain-id", "31337",
      "--state", "/project/.local/anvil/state.json",
      "--state-interval", "1",
      "--preserve-historical-states",
    ],
  );
});

test("部署清单只接受当前版本、固定链和规范合约地址", () => {
  assert.deepEqual(parseLocalDeployment(JSON.stringify(VALID_DEPLOYMENT)), VALID_DEPLOYMENT);
  assert.equal(parseLocalDeployment(JSON.stringify({
    version: 1,
    chainId: 31_337,
    paymentTokenAddress: PAYMENT_TOKEN_ADDRESS,
    escrowAddress: ESCROW_ADDRESS,
    createdAt: VALID_DEPLOYMENT.createdAt,
  })).version, 1);
  assert.throws(
    () => parseLocalDeployment(JSON.stringify({ ...VALID_DEPLOYMENT, chainId: 1 })),
    /部署清单无效/,
  );
  assert.throws(() => parseLocalDeployment("not-json"), /部署清单不是有效 JSON/);
});

test("恢复启动会校验链、合约代码、USDC 精度和 Escrow 绑定", async () => {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === "eth_chainId") return "0x7a69";
    if (method === "eth_getCode") return "0x6001600055";
    if (params[0].data === "0x3013ce29") return `0x${"0".repeat(24)}${PAYMENT_TOKEN_ADDRESS.slice(2)}`;
    if (params[0].data === "0xb9c5c022") return `0x${"0".repeat(24)}${YD_TOKEN_ADDRESS.slice(2)}`;
    if (params[0].data === "0xec5ffac2") return `0x${BigInt(VALID_DEPLOYMENT.daoMinimumStakeMinor).toString(16).padStart(64, "0")}`;
    if (params[0].data === "0x313ce567") {
      const decimals = params[0].to === YD_TOKEN_ADDRESS ? 18n : 6n;
      return `0x${decimals.toString(16).padStart(64, "0")}`;
    }
    throw new Error(`unexpected RPC ${method}`);
  };

  await validateLocalDeployment(VALID_DEPLOYMENT, rpc);
  assert.deepEqual(calls.map(([method]) => method), [
    "eth_chainId",
    "eth_getCode",
    "eth_getCode",
    "eth_call",
    "eth_call",
    "eth_getCode",
    "eth_getCode",
    "eth_call",
    "eth_call",
    "eth_call",
  ]);
});

test("恢复启动拒绝缺失合约和绑定错误的旧链", async () => {
  await assert.rejects(
    validateLocalDeployment(VALID_DEPLOYMENT, async (method, params) => {
      if (method === "eth_chainId") return "0x7a69";
      if (method === "eth_getCode" && params[0] === ESCROW_ADDRESS) return "0x";
      return "0x6001600055";
    }),
    /Escrow 合约代码不存在/,
  );

  await assert.rejects(
    validateLocalDeployment(VALID_DEPLOYMENT, async (method, params) => {
      if (method === "eth_chainId") return "0x7a69";
      if (method === "eth_getCode") return "0x6001600055";
      if (params[0].data === "0x3013ce29") return `0x${"0".repeat(24)}${"1".repeat(40)}`;
      return `0x${"0".repeat(63)}6`;
    }),
    /绑定的 USDC 地址与部署清单不一致/,
  );
});

test("本地启动器只接受启动或显式重置命令", () => {
  assert.equal(parseLocalMvpCommand([]), "start");
  assert.equal(parseLocalMvpCommand(["--reset-chain"]), "reset-chain");
  assert.throws(() => parseLocalMvpCommand(["--unknown"]), /未知参数/);
});

test("关闭启动器会等待 Anvil 等子进程真正退出", async () => {
  const events = [];
  let finishExit;
  const exit = new Promise((resolve) => { finishExit = resolve; });
  const stopping = terminateManagedProcesses([{
    child: {
      killed: false,
      kill: (signal) => { events.push(`kill:${signal}`); return true; },
    },
    exit,
  }], 1_000);

  await new Promise((resolve) => setImmediate(resolve));
  events.push("before-exit");
  finishExit({ code: 0, signal: "SIGTERM" });
  await stopping;
  events.push("after-exit");
  assert.deepEqual(events, ["kill:SIGTERM", "before-exit", "after-exit"]);
});

test("端口门禁会列出占用服务并在启动副作用之前失败", async () => {
  const probes = [];
  await assert.rejects(
    assertPortsAvailable(
      [
        ["Web", 3001, "AICP_WEB_PORT"],
        ["Marketplace API", 3100, "AICP_MARKETPLACE_API_PORT"],
      ],
      async (port) => {
        probes.push(port);
        return port === 3001;
      },
    ),
    /Web 使用的 3001.*AICP_WEB_PORT/s,
  );
  assert.deepEqual(probes, [3001, 3100]);
});

test("子进程在 readiness 之前退出时必须立即失败", async () => {
  const managed = {
    exit: Promise.resolve({ code: 23, signal: null }),
  };
  await assert.rejects(
    waitForService(managed, "Test Service", async () => false),
    /exited before becoming ready with code 23/,
  );
});

test("只有服务级 readiness 契约通过才算启动成功", async () => {
  let probes = 0;
  const managed = { exit: new Promise(() => undefined) };
  await waitForService(managed, "Test Service", async () => {
    probes += 1;
    return probes === 2;
  });
  assert.equal(probes, 2);
});

test("Web 就绪契约不依赖中英文营销文案", () => {
  const navigation = '<a href="/tasks">tasks</a><a href="/agents">agents</a>';
  assert.equal(isReadyWebHtml(`<title>AICP · 可信 Agent 协作网络</title>${navigation}`), true);
  assert.equal(isReadyWebHtml(`<title>AICP · Verifiable Agent Network</title>${navigation}`), true);
  // 只有品牌文字但缺少产品导航的错误页不能被误认为完整 Web 应用。
  assert.equal(isReadyWebHtml("<title>AICP · Error</title>"), false);
});

test("本地结算只在资金 worker 广播交易后挖块并同步", async () => {
  const calls = [];
  const advanced = await advanceLocalSettlementOnce(
    async (path) => {
      calls.push(path);
      return path.endsWith("escrow-execution")
        ? { claimed: true, status: "submitted" }
        : { processed: 2 };
    },
    async () => { calls.push("mine"); },
  );
  assert.equal(advanced, true);
  assert.deepEqual(calls, [
    "/api/internal/workers/escrow-execution",
    "mine",
    "/api/internal/workers/escrow-sync",
  ]);

  calls.length = 0;
  const idle = await advanceLocalSettlementOnce(
    async (path) => { calls.push(path); return { claimed: false, status: "idle" }; },
    async () => { calls.push("mine"); },
  );
  assert.equal(idle, false);
  assert.deepEqual(calls, ["/api/internal/workers/escrow-execution"]);

  // worker 已领取任务并不等于交易已经广播。重试和死信都必须保留原状态，不能通过
  // 挖块或同步把失败任务伪装成已确认结算。
  for (const status of ["retry_pending", "dead_letter"]) {
    calls.length = 0;
    const failed = await advanceLocalSettlementOnce(
      async (path) => { calls.push(path); return { claimed: true, status }; },
      async () => { calls.push("mine"); },
    );
    assert.equal(failed, false);
    assert.deepEqual(calls, ["/api/internal/workers/escrow-execution"]);
  }
});
