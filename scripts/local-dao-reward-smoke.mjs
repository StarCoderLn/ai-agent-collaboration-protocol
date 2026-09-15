#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/apps/server/package.json", import.meta.url));
const { Contract, JsonRpcProvider, getAddress, id } = require("ethers");
const { SiweMessage } = require("siwe");
const backgroundOnly = process.argv.slice(2).includes("--background");
assert.ok(process.argv.slice(2).every((arg) => arg === "--background"), "只接受 --background 验收模式");

/**
 * 本地真实发奖验收：复用正式 HTTP 登录、奖励查询、后台支付与已读接口，不直接改数据库造到账。
 * 只允许 loopback / 31337 / 已登记 TestYD，且固定向第 8 个 Anvil 开发账户奖励 1 TestYD。
 * 唯一测试凭证跨重跑保留；不会重新部署、清库、重置链、覆盖旧质押或产生真实模型费用。
 * API .env.local 需先配置已部署奖励目录；该脚本本身不会开启新版任务仲裁。
 */
const rpcUrl = process.env.LOCAL_REWARD_SMOKE_RPC_URL ?? "http://127.0.0.1:8545";
const apiUrl = process.env.LOCAL_REWARD_SMOKE_API_URL ?? "http://127.0.0.1:3100";
for (const url of [rpcUrl, apiUrl]) {
  assert.equal(new URL(url).protocol, "http:", "本地验收只允许 HTTP loopback");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname), "禁止连接公共网络");
}
const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
let cookie;

/** 会话和签名只在本进程内使用，不写文件、不输出凭据；所有请求有明确超时。 */
async function request(path, options = {}) {
  return fetch(`${apiUrl}${path}`, { ...options, signal: AbortSignal.timeout(20_000) });
}
async function history() {
  const response = await request("/api/dao/rewards", { headers: { cookie } });
  assert.equal(response.status, 200, "奖励查询必须通过实际 HTTP 返回成功");
  const body = await response.json();
  assert.equal(body.status, "ready", "奖励目录必须已启用，不能把占位响应当成通过");
  return body;
}
async function advance() {
  // 后台模式绝不主动调用 worker，用自然轮询证明启动器真的在持续调度，而不是脚本代劳。
  if (backgroundOnly) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { enabled: true, status: "background_wait" };
  }
  const response = await request("/api/internal/workers/dao-rewards", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.DISPATCH_INTERNAL_TOKEN ?? "aicp-local-internal-token-2026"}` },
  });
  assert.equal(response.status, 200, "后台发奖接口不可用");
  const result = await response.json();
  assert.equal(result.enabled, true, "后台发奖必须已启用");
  return result;
}

try {
  assert.equal((await provider.getNetwork()).chainId, 31337n);
  const deployment = JSON.parse(await readFile(new URL("../.local/anvil/deployment.json", import.meta.url), "utf8"));
  const rewardDeployment = JSON.parse(await readFile(new URL("../.local/anvil/dao-reward-deployment.json", import.meta.url), "utf8"));
  assert.equal(deployment.chainId, 31337);
  assert.equal(rewardDeployment.chainId, 31337);
  const accounts = await provider.send("eth_accounts", []);
  const recipient = getAddress(accounts[7]);
  const admin = await provider.getSigner(getAddress(rewardDeployment.admin));
  assert.equal(getAddress(accounts[8]), await admin.getAddress(), "必须使用专属本地开发管理员");
  const recipientSigner = await provider.getSigner(recipient);
  const token = new Contract(deployment.ydTokenAddress, [
    "function name() view returns(string)", "function balanceOf(address) view returns(uint256)",
    "function mint(address,uint256)", "function approve(address,uint256) returns(bool)",
  ], admin);
  assert.equal(await token.name(), "Local YD Token", "只允许项目本地 TestYD，禁止产品 YD");
  const usdc = new Contract(deployment.paymentTokenAddress, ["function balanceOf(address) view returns(uint256)"], provider);
  const before = { stake: await token.balanceOf(deployment.arbitrationDaoAddress), escrow: await usdc.balanceOf(deployment.escrowAddress), gas: await provider.getBalance(recipient) };
  const pool = new Contract(rewardDeployment.poolAddress, [
    "function ydToken() view returns(address)", "function available() view returns(uint256)",
    "function fund(uint256)", "function awarded(bytes32) view returns(bool)",
    "function award(bytes32,address,uint256,uint8)", "function payReward(bytes32,address)",
    "function paidRewards(bytes32,address) view returns(uint256)",
    "event RewardPaid(bytes32 indexed sourceId,address indexed recipient,uint256 amount)",
  ], admin);
  assert.equal(getAddress(await pool.ydToken()), getAddress(deployment.ydTokenAddress));

  // 登录使用默认开发账户的真实 SIWE 签名，不借用用户浏览器会话，也不绕过认证写入数据。
  const nonceResponse = await request("/api/auth/nonce");
  assert.equal(nonceResponse.status, 200);
  const nonce = await nonceResponse.json();
  assert.equal(nonce.chainId, 31337);
  const message = new SiweMessage({ ...nonce, address: recipient, version: "1", issuedAt: new Date().toISOString() }).prepareMessage();
  const signature = await recipientSigner.signMessage(message);
  const login = await request("/api/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, signature }) });
  assert.equal(login.status, 200, "开发钱包 SIWE 登录失败");
  cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "登录必须签发真实会话");
  assert.equal((await request("/api/dao/rewards")).status, 401, "不能匿名读取奖励");
  const initial = await history();
  assert.equal(getAddress(initial.poolAddress), getAddress(rewardDeployment.poolAddress));
  assert.equal(getAddress(initial.actorId), recipient);

  const sourceId = id(`aicp:local:reward-smoke:v1${backgroundOnly ? ":background" : ""}:${rewardDeployment.poolAddress.toLowerCase()}:${recipient.toLowerCase()}`);
  const amount = 10n ** 18n;
  const alreadyPaid = await pool.paidRewards(sourceId, recipient);
  assert.ok(alreadyPaid === 0n || alreadyPaid === amount, "测试凭证金额不能被改变");
  const balanceBefore = await token.balanceOf(recipient);
  if (!await pool.awarded(sourceId)) {
    // 只按这一次测试的缺口铸造本地 TestYD；正式合约自身不能铸币，也不写平台奖励费率。
    const available = await pool.available();
    if (available < amount) {
      const shortfall = amount - available;
      await (await token.mint(await admin.getAddress(), shortfall)).wait();
      await (await token.approve(rewardDeployment.poolAddress, shortfall)).wait();
      await (await pool.fund(shortfall)).wait();
    }
    const receipt = await (await pool.award(sourceId, recipient, amount, 2)).wait();
    assert.equal(receipt.status, 1);
    // 仅在看到真实奖励记账回执后补一块确认，不改时间、不重置已有链状态。
    await provider.send("anvil_mine", ["0x1"]);
  }

  let paid;
  for (let attempt = 0; attempt < (backgroundOnly ? 40 : 12); attempt += 1) {
    const progress = await advance();
    const records = await history();
    paid = records.items.find((item) => item.sourceId === sourceId && item.status === "paid");
    if (paid) break;
    assert.notEqual(progress.status, "needs_review", "后台进入人工恢复，不能声明通过");
    assert.notEqual(progress.status, "retry_pending", "真实付款准备/广播失败，需排查而非跳过");
    if (progress.txHash && await provider.getTransactionReceipt(progress.txHash)) {
      // 有交易回执但尚未确认时，页面不得产生到账通知；下一块确认后再让事件索引推进。
      assert.ok(!records.items.some((item) => item.sourceId === sourceId && item.unread));
      await provider.send("anvil_mine", ["0x1"]);
    }
  }
  assert.ok(paid, "限定次数内必须读到确认到账记录");
  assert.equal(paid.amountMinor, amount.toString());
  if (alreadyPaid === 0n) {
    assert.equal(paid.unread, true, "首次到账必须产生未读通知");
    assert.equal(await token.balanceOf(recipient) - balanceBefore, amount);
  }
  const read = await request("/api/dao/rewards", { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ ids: [paid.id] }) });
  assert.equal(read.status, 200);

  // 重跑同一付款凭证必须无副作用；既有通知已读状态也不能因后台再次扫描而复活。
  await (await pool.payReward(sourceId, recipient)).wait();
  await provider.send("anvil_mine", ["0x1"]);
  await advance();
  await advance();
  const final = await history();
  const rows = final.items.filter((item) => item.sourceId === sourceId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].unread, false);
  assert.equal(await pool.paidRewards(sourceId, recipient), amount);
  const payments = await pool.queryFilter(pool.filters.RewardPaid(sourceId, recipient), rewardDeployment.startBlock);
  assert.equal(payments.length, 1, "同一业务凭证只能产生一次实际付款事件");
  assert.equal(await token.balanceOf(deployment.arbitrationDaoAddress), before.stake);
  assert.equal(await usdc.balanceOf(deployment.escrowAddress), before.escrow);
  assert.equal(await provider.getBalance(recipient), before.gas, "收款人不承担发奖 Gas");
  console.log(JSON.stringify({ status: "passed", backgroundOnly, recipient, amountTestYd: "1", poolAddress: rewardDeployment.poolAddress, sourceId, paymentTxHash: paid.txHash, unreadAfterRead: rows[0].unread, paymentEventCount: payments.length, oldEscrowAndStakeUnchanged: true, repeatRun: alreadyPaid > 0n }, null, 2));
} finally {
  // 只注销本脚本新建的开发账户会话，不操作用户钱包或其他登录会话。
  try { if (cookie) await request("/api/auth/session", { method: "DELETE", headers: { cookie } }); }
  finally { provider.destroy(); }
}
