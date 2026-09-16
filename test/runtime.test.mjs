import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createRuntimePaths,
  DOUBAOWORK_BROWSER_BINARY,
  discoverCdpPort,
  findDoubaoWorkBrowserPids,
  findOwnedWatchProcesses,
  inspectWatchProcess,
  normalizeRuntimeState,
  readRuntimeState,
  selectAvailablePort,
  stopWatchProcess,
  stopDoubaoWork,
  writeRuntimeState,
  clearRuntimeState,
  readPreferredTheme,
  rememberTheme,
} from "../src/runtime.mjs";

async function withTempRuntime(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "doubao-work-skin-runtime-"));
  const paths = createRuntimePaths(root);
  try {
    return await fn(paths);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("旧状态在内存中升级 schema 并推导 skinName", () => {
  const state = normalizeRuntimeState({
    port: 9342,
    injectorPid: 123,
    skinDir: "/repo/skins/default",
    startedAt: "2026-09-13T00:00:00Z",
  });
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.skinName, "default");
  assert.equal(state.themeId, null);
});

test("损坏状态返回诊断错误且不被覆盖", async () => {
  await withTempRuntime(async (paths) => {
    await fs.writeFile(paths.state, "{bad json", { mode: 0o600 });
    await assert.rejects(readRuntimeState({ paths }), /运行状态损坏/);
    assert.equal(await fs.readFile(paths.state, "utf8"), "{bad json");
  });
});

test("清理运行状态保留上次选择，偏好文件采用私人权限", async () => {
  await withTempRuntime(async paths => {
    assert.equal(await readPreferredTheme({ paths }), null);
    await rememberTheme("my-garden", { paths });
    await fs.writeFile(paths.state, "{}");
    await clearRuntimeState({ paths });
    assert.equal(await readPreferredTheme({ paths }), "my-garden");
    assert.equal((await fs.stat(paths.preferences)).mode & 0o777, 0o600);
    await assert.rejects(rememberTheme("../outside", { paths }), /无效/);
    await fs.writeFile(paths.preferences, "bad json");
    assert.equal(await readPreferredTheme({ paths }), null);
    await fs.writeFile(paths.preferences, "null");
    assert.equal(await readPreferredTheme({ paths }), null);
  });
});

test("原子状态写入使用 schema 1 和 0600 权限", async () => {
  await withTempRuntime(async (paths) => {
    await writeRuntimeState({
      port: 9342,
      injectorPid: 321,
      doubaoWorkPid: 654,
      skinName: "default",
      skinDir: "/repo/skins/default",
      themeId: "gothic-void-refined",
      startedAt: "2026-09-13T00:00:00Z",
      switchedAt: null,
    }, { paths });
    const state = await readRuntimeState({ paths });
    const stat = await fs.stat(paths.state);
    assert.equal(state.schemaVersion, 1);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.deepEqual((await fs.readdir(paths.root)).filter((name) => name.endsWith(".tmp")), []);
  });
});

test("只认绝对注入器路径和项目 cwd 的 Node watch", async () => {
  const projectRoot = "/repo";
  const injectorPath = "/repo/src/injector.mjs";
  const inspect = async (pid) => {
    if (pid === 1) return { command: "/Applications/Runtime With Space/bin/node /repo/src/injector.mjs --watch --port 9342 --skin /repo/skins/default", cwd: "/repo" };
    if (pid === 2) return { command: "/bin/sh -c node /repo/src/injector.mjs --watch --port 9342 --skin /repo/skins/default", cwd: "/repo" };
    if (pid === 3) return { command: "/usr/bin/node /other/src/injector.mjs --watch --port 9342 --skin /other/skins/default", cwd: "/other" };
    throw new Error("missing");
  };
  assert.equal((await inspectWatchProcess(1, { inspectProcess: inspect, projectRoot, injectorPath })).pid, 1);
  assert.equal(await inspectWatchProcess(2, { inspectProcess: inspect, projectRoot, injectorPath }), null);
  assert.equal(await inspectWatchProcess(3, { inspectProcess: inspect, projectRoot, injectorPath }), null);
  const owned = await findOwnedWatchProcesses({
    listProcesses: async () => [1, 2, 3].map((pid) => ({ pid, command: "injector.mjs --watch" })),
    inspectProcess: inspect,
    projectRoot,
    injectorPath,
  });
  assert.deepEqual(owned.map((entry) => entry.pid), [1]);
});

test("stopWatchProcess 只停止所有权已验证的 PID", async () => {
  const signals = [];
  const stopped = await stopWatchProcess({
    state: { injectorPid: 9 },
    findOwned: async () => [{ pid: 9 }, { pid: 10 }],
    signal: (pid, signal) => signals.push([pid, signal]),
    waitForExit: async () => true,
  });
  assert.deepEqual(stopped.map((entry) => entry.pid), [9, 10]);
  assert.deepEqual(signals, [[9, "SIGTERM"], [10, "SIGTERM"]]);
});

test("安装版 watch 能识别带空格的程序路径和个人皮肤路径", async () => {
  const projectRoot = "/Users/test user/Applications/DoubaoWorkSkin.app/Contents/Resources/project";
  const injectorPath = `${projectRoot}/src/injector.mjs`;
  const skinDir = "/Users/test user/Library/Application Support/DoubaoWorkSkin/skins/my-garden";
  const entry = await inspectWatchProcess(9, {
    projectRoot,
    injectorPath,
    inspectProcess: async () => ({
      command: `/Users/test user/Applications/DoubaoWorkSkin.app/Contents/Resources/runtime/bin/node ${injectorPath} --watch --port 9342 --skin ${skinDir}`,
      cwd: projectRoot,
    }),
  });
  assert.equal(entry.skinDir, skinDir);
  assert.equal(entry.port, 9342);
});

test("端口选择跳过已占用端口", async () => {
  const occupied = new Set([9342, 9343]);
  assert.equal(await selectAvailablePort(9342, { isPortListening: async (port) => occupied.has(port) }), 9344);
});

test("只识别独立浏览器主进程，不匹配 helper 和 shell 命令", async () => {
  const binary = DOUBAOWORK_BROWSER_BINARY;
  const pids = await findDoubaoWorkBrowserPids({ execFileImpl: async () => ({ stdout: [
    `  10 ${binary} --saman-from-chat=9`,
    `  11 ${binary} Helper --type=renderer`,
    `  12 /bin/sh -c ${binary}`,
    `  13 ${binary}`,
  ].join("\n") }) });
  assert.deepEqual(pids, [10, 13]);
});

test("重启前必须等待 shim 和旧浏览器全部退出", async () => {
  const events = [];
  await stopDoubaoWork({
    pid: 9,
    findBrowserPids: async () => [10],
    signal: (pid, signal) => events.push([pid, signal]),
    waitForExit: async (pid) => { events.push([pid, "wait"]); return true; },
  });
  assert.deepEqual(events, [[9, "SIGTERM"], [9, "wait"], [10, "wait"]]);
});

test("浏览器仍在退出时中止重启，不强杀浏览器或忽略单例锁", async () => {
  const signals = [];
  await assert.rejects(stopDoubaoWork({
    pid: 9,
    findBrowserPids: async () => [10],
    signal: (...args) => signals.push(args),
    waitForExit: async (pid) => pid === 9,
  }), /浏览器 PID 10 尚未退出/);
  assert.deepEqual(signals, [[9, "SIGTERM"]]);
});
