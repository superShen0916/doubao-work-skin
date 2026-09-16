import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createCli, parseCliArgs } from "../skin.mjs";

function theme(name, id = name) {
  return {
    directoryName: name,
    directoryPath: path.resolve(`/repo/skins/${name}`),
    theme: { id, name: name.toUpperCase(), appearance: "dark" },
  };
}

function baseDeps(overrides = {}) {
  const themes = {
    default: theme("default", "gothic-void-refined"),
    forest: theme("forest"),
  };
  return {
    discoverThemes: async () => Object.keys(themes),
    loadTheme: async ({ name }) => themes[name],
    readRuntimeState: async () => null,
    readPreferredTheme: async () => null,
    rememberTheme: async () => {},
    writeRuntimeState: async (state) => state,
    clearRuntimeState: async () => {},
    discoverCdpPort: async (port) => port,
    readWatchProcess: async () => null,
    findOwnedWatchProcesses: async () => [],
    spawnWatchProcess: async () => 222,
    stopWatchProcess: async () => [],
    findDoubaoWorkPid: async () => 111,
    launchDoubaoWork: async () => 111,
    stopDoubaoWork: async () => {},
    selectAvailablePort: async (port) => port,
    waitForCdp: async () => ({}),
    runInjector: async () => ({ ok: true, stdout: "全部验证通过", stderr: "" }),
    verifyWithRetry: async () => ({ ok: true }),
    log: () => {},
    error: () => {},
    ...overrides,
  };
}

test("兼容旧直接皮肤名和 --keep-app", () => {
  assert.deepEqual(parseCliArgs(["forest"]), {
    command: "switch",
    skinName: "forest",
    port: null,
    force: false,
    keepAppearance: false,
  });
  assert.equal(parseCliArgs(["stop", "--keep-app"]).keepAppearance, true);
});

test("拒绝未知参数和非法端口", () => {
  assert.throws(() => parseCliArgs(["start", "--unknown"]), /未知参数/);
  assert.throws(() => parseCliArgs(["start", "--port", "70000"]), /无效端口/);
});

test("start 命令未指定端口时使用默认端口", async () => {
  const seen = [];
  const cli = createCli(baseDeps({
    readRuntimeState: async () => null,
    findDoubaoWorkPid: async () => 111,
    discoverCdpPort: async (port) => { seen.push(port); return port; },
    runInjector: async () => ({ ok: true, stdout: "ok" }),
    spawnWatchProcess: async ({ port }) => { seen.push(port); return 222; },
  }));
  await cli.run(parseCliArgs(["start", "default"]));
  assert.deepEqual(seen, [9342, 9342]);
});

function staleWatchDeps(events, overrides = {}) {
  return baseDeps({
    readRuntimeState: async () => ({ skinName: "default", injectorPid: 100, doubaoWorkPid: 110, port: 9342 }),
    readWatchProcess: async () => ({ pid: 100, port: 9342 }),
    discoverCdpPort: async () => null,
    stopWatchProcess: async () => { events.push("stop-watch"); },
    stopDoubaoWork: async () => { events.push("stop-app"); },
    launchDoubaoWork: async () => { events.push("launch-app"); return 111; },
    waitForCdp: async () => { events.push("cdp-ready"); },
    runInjector: async (mode) => { events.push(mode); return { ok: true }; },
    spawnWatchProcess: async () => { events.push("spawn-watch"); return 222; },
    verifyWithRetry: async () => { events.push("verify"); },
    writeRuntimeState: async () => { events.push("write"); },
    ...overrides,
  });
}

test("应用普通重开后旧 watch 不能让 start 跳过 CDP 检查", async () => {
  const events = [];
  const cli = createCli(staleWatchDeps(events));
  await assert.rejects(cli.start("default"), error => {
    assert.equal(error.exitCode, 2);
    assert.match(error.message, /node skin.mjs start default --force/);
    return true;
  });
  assert.deepEqual(events, ["stop-watch"]);
});

test("旧 watch 仍在时 start --force 可以重启应用并重新注入", async () => {
  const events = [];
  const cli = createCli(staleWatchDeps(events));
  await cli.start("default", { force: true });
  assert.deepEqual(events, ["stop-watch", "stop-app", "launch-app", "cdp-ready", "once", "spawn-watch", "verify", "write"]);
});

test("应用已退出但旧 watch 仍在时 start 正常启动应用", async () => {
  const events = [];
  const cli = createCli(staleWatchDeps(events, { findDoubaoWorkPid: async () => null }));
  await cli.start("default");
  assert.deepEqual(events, ["stop-watch", "launch-app", "cdp-ready", "once", "spawn-watch", "verify", "write"]);
});

test("watch 与 CDP 均正常时 start 同主题复用现有进程", async () => {
  const events = [];
  const cli = createCli(staleWatchDeps(events, { discoverCdpPort: async () => 9342 }));
  await cli.start("default");
  assert.deepEqual(events, ["cdp-ready", "verify"]);
});

test("应用 CDP 端口改变后 start 替换旧端口的 watch", async () => {
  const events = [];
  const cli = createCli(staleWatchDeps(events, {
    discoverCdpPort: async () => 9343,
    spawnWatchProcess: async ({ port }) => { assert.equal(port, 9343); events.push("spawn-watch"); return 222; },
    writeRuntimeState: async state => { assert.equal(state.port, 9343); events.push("write"); },
  }));
  await cli.start("default");
  assert.deepEqual(events, ["stop-watch", "once", "spawn-watch", "verify", "write"]);
});

test("成功切换时验证后再提交新状态", async () => {
  const events = [];
  const previous = {
    schemaVersion: 1,
    port: 9342,
    injectorPid: 100,
    doubaoWorkPid: 111,
    skinName: "default",
    skinDir: "/repo/skins/default",
    themeId: "gothic-void-refined",
    startedAt: "2026-09-13T00:00:00Z",
    switchedAt: null,
  };
  const cli = createCli(baseDeps({
    readRuntimeState: async () => previous,
    readWatchProcess: async () => ({ pid: 100 }),
    stopWatchProcess: async () => { events.push("stop-old"); return []; },
    runInjector: async (mode, options) => { events.push(`${mode}:${path.basename(options.skinDir || "none")}`); return { ok: true, stdout: "全部验证通过" }; },
    spawnWatchProcess: async ({ skinDir }) => { events.push(`spawn:${path.basename(skinDir)}`); return 222; },
    verifyWithRetry: async (skinDir) => { events.push(`verify:${path.basename(skinDir)}`); return { ok: true }; },
    writeRuntimeState: async (state) => { events.push(`write:${state.skinName}`); return state; },
  }));
  await cli.switchTheme("forest");
  assert.deepEqual(events, ["stop-old", "once:forest", "spawn:forest", "verify:forest", "write:forest"]);
});

test("候选验证失败时恢复旧主题和旧状态", async () => {
  const events = [];
  const previous = {
    schemaVersion: 1,
    port: 9342,
    injectorPid: 100,
    doubaoWorkPid: 111,
    skinName: "default",
    skinDir: "/repo/skins/default",
    themeId: "gothic-void-refined",
    startedAt: "2026-09-13T00:00:00Z",
    switchedAt: null,
  };
  let verifyCount = 0;
  const cli = createCli(baseDeps({
    readRuntimeState: async () => previous,
    readWatchProcess: async () => ({ pid: 100 }),
    stopWatchProcess: async ({ state }) => { events.push(`stop:${state?.injectorPid || "all"}`); return []; },
    runInjector: async (mode, options) => { events.push(`${mode}:${path.basename(options.skinDir || "none")}`); return { ok: true, stdout: "ok" }; },
    spawnWatchProcess: async ({ skinDir }) => { const pid = path.basename(skinDir) === "forest" ? 222 : 333; events.push(`spawn:${path.basename(skinDir)}:${pid}`); return pid; },
    verifyWithRetry: async (skinDir) => {
      events.push(`verify:${path.basename(skinDir)}`);
      verifyCount++;
      if (verifyCount === 1) throw new Error("candidate failed");
      return { ok: true };
    },
    writeRuntimeState: async (state) => { events.push(`write:${state.skinName}:${state.injectorPid}`); return state; },
  }));
  await assert.rejects(cli.switchTheme("forest"), /已回滚到 default/);
  assert.deepEqual(events, [
    "stop:100",
    "once:forest",
    "spawn:forest:222",
    "verify:forest",
    "stop:222",
    "once:default",
    "spawn:default:333",
    "verify:default",
    "write:default:333",
  ]);
});

test("stop 严格先停 watch、恢复页面、最后清状态", async () => {
  const events = [];
  const state = { port: 9342, injectorPid: 100 };
  const cli = createCli(baseDeps({
    readRuntimeState: async () => state,
    stopWatchProcess: async () => { events.push("stop"); return []; },
    runInjector: async (mode) => { events.push(mode); return { ok: true, stdout: "" }; },
    clearRuntimeState: async () => { events.push("clear"); },
  }));
  await cli.stop();
  assert.deepEqual(events, ["stop", "restore", "clear"]);
});

test("无旧状态时切换失败仍恢复官方外观", async () => {
  const events = [];
  const cli = createCli(baseDeps({
    verifyWithRetry: async () => { throw new Error("candidate failed"); },
    runInjector: async (mode) => { events.push(mode); return { ok: true }; },
    clearRuntimeState: async () => { events.push("clear"); },
  }));
  await assert.rejects(cli.switchTheme("forest"), /candidate failed\n已恢复官方外观/);
  assert.deepEqual(events, ["once", "restore", "clear"]);
});

test("回滚验证失败后清理回滚 watch 并保留可恢复状态", async () => {
  const stopped = [];
  const written = [];
  let pid = 200;
  const cli = createCli(baseDeps({
    readRuntimeState: async () => ({ skinName: "default", injectorPid: 100, port: 9342 }),
    spawnWatchProcess: async () => ++pid,
    stopWatchProcess: async ({ state }) => { stopped.push(state.injectorPid); },
    verifyWithRetry: async () => { throw new Error("verify failed"); },
    writeRuntimeState: async state => { written.push(state); },
  }));
  await assert.rejects(cli.switchTheme("forest"), /回滚失败/);
  assert.deepEqual(stopped, [100, 201, 202]);
  assert.equal(written.at(-1).injectorPid, null);
});

test("无状态的 restore 失败不能报成功或清理状态", async () => {
  const cli = createCli(baseDeps({
    runInjector: async () => ({ ok: false, stderr: "connection failed" }),
    clearRuntimeState: async () => assert.fail("恢复失败时不能清理状态"),
    log: () => assert.fail("恢复失败时不能报告成功"),
  }));
  await assert.rejects(cli.restore(), /恢复官方外观失败/);
});

test("不指定皮肤时使用上次验证成功的选择", async () => {
  const selected = [];
  const cli = createCli(baseDeps({
    readPreferredTheme: async () => "forest",
    rememberTheme: async name => selected.push(name),
  }));
  await cli.run(parseCliArgs(["start"]));
  assert.deepEqual(selected, ["forest"]);
});

test("明确指定的皮肤优先于偏好；未通过验证不更新偏好", async () => {
  const selected = [];
  const cli = createCli(baseDeps({
    readPreferredTheme: async () => "forest",
    rememberTheme: async name => selected.push(name),
  }));
  await cli.start("default");
  assert.deepEqual(selected, ["default"]);
  const failing = createCli(baseDeps({
    verifyWithRetry: async () => { throw new Error("failed"); },
    rememberTheme: async () => assert.fail("验证失败不能更新偏好"),
  }));
  await assert.rejects(failing.start("forest"), /failed/);
});

test("上次皮肤已删除时回到默认主题；显式输入错误仍报错", async () => {
  const selected = [];
  const cli = createCli(baseDeps({
    discoverThemes: async () => ["seaside-breeze"],
    loadTheme: async ({ name }) => theme(name),
    readPreferredTheme: async () => "removed",
    rememberTheme: async name => selected.push(name),
  }));
  await cli.start();
  assert.deepEqual(selected, ["seaside-breeze"]);
  await assert.rejects(cli.start("removed"), /未知皮肤/);
});

test("迁移没有偏好文件的用户时复用当前运行状态的主题", async () => {
  const selected = [];
  const cli = createCli(baseDeps({
    readRuntimeState: async () => ({ skinName: "forest", port: 9342 }),
    rememberTheme: async name => selected.push(name),
  }));
  await cli.start();
  assert.deepEqual(selected, ["forest"]);
});
