import test from "node:test";
import assert from "node:assert/strict";
import { assertDoubaoWorkPort, discoverWinInstallCached, _resetWinInstallCacheForTest, DOUBAOWORK_BINARY, DOUBAOWORK_BROWSER_BINARY } from "../src/app-identity.mjs";
import { discoverCdpPort } from "../src/runtime.mjs";

const WIN_MAIN = "C:\\Users\\tester\\AppData\\Local\\DoubaoWork\\Application\\app\\DoubaoWork.exe";
const WIN_HELPER = "C:\\Users\\tester\\AppData\\Local\\DoubaoWork\\Application\\app\\DoubaoWork Browser.exe";

test("Windows 真实现：9342 监听进程在白名单内则通过（只读）", async (t) => {
  if (process.platform !== "win32") { t.skip("仅 Windows"); return; }
  // 仅在 9342 实际监听时运行（CI/未开调试端口时跳过，不报错）
  const { execFileSync } = await import("node:child_process");
  let listening = false;
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8", timeout: 5000 });
    listening = /:\b9342\b.*LISTENING/i.test(out);
  } catch { listening = false; }
  if (!listening) { t.skip("9342 未监听（豆包工作未开调试端口），跳过真机校验"); return; }
  await assertDoubaoWorkPort(9342);
});

test("Windows mock：主/helper 通过，大小写不敏感", async () => {
  const base = {
    platformName: "win32",
    discoverAppInstall: async () => ({ mainBinary: WIN_MAIN, helperBinary: WIN_HELPER }),
  };
  for (const exe of [WIN_MAIN, WIN_HELPER, WIN_MAIN.toUpperCase()]) {
    await assert.doesNotReject(assertDoubaoWorkPort(9342, {
      ...base, findListeningPids: async () => [5132], getProcessExecutable: async () => exe,
    }));
  }
});

test("Windows mock：Chrome/相邻后缀/空路径/无监听被拒", async () => {
  const base = {
    platformName: "win32",
    discoverAppInstall: async () => ({ mainBinary: WIN_MAIN, helperBinary: WIN_HELPER }),
  };
  for (const exe of [
    "C:\\Program Files\\Google\\Chrome\\Chrome.exe",
    WIN_MAIN + ".bak",
    "",
  ]) {
    await assert.rejects(assertDoubaoWorkPort(9342, {
      ...base, findListeningPids: async () => [999], getProcessExecutable: async () => exe,
    }), /已拒绝连接/);
  }
  await assert.rejects(assertDoubaoWorkPort(9342, {
    ...base, findListeningPids: async () => [], getProcessExecutable: async () => WIN_MAIN,
  }), /已拒绝连接/);
});

test("darwin mock：主/helper 通过，其他被拒", async () => {
  const base = { platformName: "darwin", findListeningPids: async () => [100] };
  for (const exe of [DOUBAOWORK_BINARY, DOUBAOWORK_BROWSER_BINARY]) {
    await assert.doesNotReject(assertDoubaoWorkPort(9342, { ...base, getProcessExecutable: async () => exe }));
  }
  for (const exe of ["/usr/bin/node", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) {
    await assert.rejects(assertDoubaoWorkPort(9342, { ...base, getProcessExecutable: async () => exe }), /已拒绝连接/);
  }
});

test("macOS 上仅大小写不同的伪造路径必须被拒绝", async (t) => {
  if (process.platform === "win32") { t.skip("Windows 不区分大小写"); return; }
  const fake = DOUBAOWORK_BINARY.replace("DoubaoWork", "DOUBAOWORK");
  await assert.rejects(assertDoubaoWorkPort(9342, {
    platformName: "darwin", findListeningPids: async () => [100], getProcessExecutable: async () => fake,
  }), /已拒绝连接/);
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
    assertPortOwner: async () => { throw new Error("not ours"); },
    fetchImpl: async () => assert.fail("身份不符不能读取 CDP 自报信息"),
  });
  assert.equal(port, null);
});

test("M6：discoverWinInstallCached 30 秒内复用缓存；reset 后重新发现", async () => {
  _resetWinInstallCacheForTest();
  let calls = 0;
  const install = { mainBinary: WIN_MAIN, helperBinary: WIN_HELPER };
  const discover = async () => { calls += 1; return install; };
  assert.equal(await discoverWinInstallCached(discover), install);
  assert.equal(await discoverWinInstallCached(discover), install);
  assert.equal(calls, 1, "TTL 内应只调用一次 discover（避免重复 spawn powershell）");
  _resetWinInstallCacheForTest();
  assert.equal(await discoverWinInstallCached(discover), install);
  assert.equal(calls, 2, "reset 缓存后应重新调用 discover");
  _resetWinInstallCacheForTest();
});
