import assert from "node:assert/strict";
import test from "node:test";

process.env.AICP_LOCAL_MVP_TEST_MODE = "true";

const { assertPortsAvailable, isReadyWebHtml, waitForService } = await import("./local-mvp.mjs");

test("端口门禁会列出占用服务并在启动副作用之前失败", async () => {
  const probes = [];
  await assert.rejects(
    assertPortsAvailable(
      [
        ["Web", 3001, "AICP_WEB_PORT"],
        ["Business API", 3100, "AICP_BUSINESS_API_PORT"],
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
