import test from "node:test";
import assert from "node:assert/strict";
import { assertDoubaoWorkPort, DOUBAOWORK_BINARY, DOUBAOWORK_BROWSER_BINARY } from "../src/app-identity.mjs";
import { discoverCdpPort } from "../src/runtime.mjs";

function inspect(executables) {
  return async (command, args) => {
    if (command === "lsof") {
      assert.ok(args.includes("-sTCP:LISTEN"));
      assert.ok(args.includes("-iTCP:9342"));
      return { stdout: executables.map((_, i) => `p${i + 100}\nf5`).join("\n") };
    }
    assert.equal(command, "ps");
    assert.deepEqual(args.slice(2), ["-o", "comm="]);
    return { stdout: `${executables[Number(args[1]) - 100]}\n` };
  };
}

test("端口只接受豆包工作主进程或独立浏览器的实际可执行文件", async () => {
  for (const executable of [DOUBAOWORK_BINARY, DOUBAOWORK_BROWSER_BINARY]) {
    await assertDoubaoWorkPort(9342, { execFileImpl: inspect([executable]) });
  }
});

test("拒绝 Chrome、冒用名称、shell 包装与混合监听进程", async () => {
  for (const executables of [
    ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    [`${DOUBAOWORK_BROWSER_BINARY} Helper`],
    ["/tmp/DoubaoWork"],
    [`/bin/sh -c ${DOUBAOWORK_BINARY}`],
    [DOUBAOWORK_BINARY, "/usr/bin/node"],
  ]) {
    await assert.rejects(assertDoubaoWorkPort(9342, { execFileImpl: inspect(executables) }), /已拒绝连接/);
  }
});

test("没有监听进程或身份检查失败时拒绝连接", async () => {
  for (const execFileImpl of [
    inspect([]),
    async () => { throw new Error("permission denied"); },
    async command => { if (command === "ps") throw new Error("process exited"); return { stdout: "p100\n" }; },
  ]) {
    await assert.rejects(assertDoubaoWorkPort(9342, { execFileImpl }), /已拒绝连接/);
  }
});

test("自动发现跳过其他应用占用的端口，不向其发送 CDP 请求", async () => {
  const requests = [];
  const port = await discoverCdpPort(9342, {
    assertPortOwner: async port => { if (port !== 9343) throw new Error("other application"); },
    fetchImpl: async url => { requests.push(url); return { ok: true, json: async () => ({ Browser: "Chromium" }) }; },
  });
  assert.equal(port, 9343);
  assert.deepEqual(requests, ["http://127.0.0.1:9343/json/version"]);
});

test("只有其他应用的 CDP 时发现结果为空，即使声称自己是豆包工作", async () => {
  const port = await discoverCdpPort(9342, {
    assertPortOwner: () => assertDoubaoWorkPort(9342, { execFileImpl: inspect(["/usr/bin/node"]) }),
    fetchImpl: async () => assert.fail("身份不符不能读取 CDP 自报信息"),
  });
  assert.equal(port, null);
});

test("macOS 上仅大小写不同的伪造路径必须被拒绝", async () => {
  if (process.platform === "win32") return; // Windows 文件系统不区分大小写
  const fake = DOUBAOWORK_BINARY.replace("DoubaoWork", "DOUBAOWORK");
  await assert.rejects(assertDoubaoWorkPort(9342, { execFileImpl: inspect([fake]) }), /已拒绝连接/);
});
