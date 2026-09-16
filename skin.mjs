#!/usr/bin/env node
import { execFile } from "node:child_process";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { discoverThemes, loadTheme } from "./src/theme.mjs";
import {
  INJECTOR_PATH,
  PROJECT_ROOT,
  clearRuntimeState,
  discoverCdpPort,
  findDoubaoWorkPid,
  findOwnedWatchProcesses,
  launchDoubaoWork,
  readRuntimeState,
  readPreferredTheme,
  rememberTheme,
  readWatchProcess,
  runtimePaths,
  selectAvailablePort,
  spawnWatchProcess,
  stopDoubaoWork,
  stopWatchProcess,
  waitForCdp,
  writeRuntimeState,
} from "./src/runtime.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_PORT = 9342;
const EXIT_FAILURE = 1;
const EXIT_PRECONDITION = 2;

function usage() {
  return `豆包工作换肤

用法:
  node skin.mjs list
  node skin.mjs start [皮肤] [--port N] [--force]
  node skin.mjs stop [--keep-appearance]
  node skin.mjs switch <皮肤>
  node skin.mjs status
  node skin.mjs verify [皮肤]
  node skin.mjs restore
  node skin.mjs <皮肤>        # 兼容旧切换语法`;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`无效端口: ${value}`);
  return port;
}

export function parseCliArgs(argv) {
  const args = [...argv];
  if (args.length === 0) return { command: "list", skinName: null, port: null, force: false, keepAppearance: false };
  const first = args.shift();
  const knownCommands = new Set(["list", "start", "stop", "switch", "status", "verify", "restore", "help", "--help", "-h"]);
  const parsed = {
    command: knownCommands.has(first) ? first : "switch",
    skinName: knownCommands.has(first) ? null : first,
    port: null,
    force: false,
    keepAppearance: false,
  };
  if (["help", "--help", "-h"].includes(parsed.command)) return { ...parsed, command: "help" };
  while (args.length) {
    const token = args.shift();
    if (token === "--port") {
      if (!args.length) throw new Error("--port 缺少值");
      parsed.port = parsePort(args.shift());
    } else if (token === "--force") {
      parsed.force = true;
    } else if (token === "--keep-appearance" || token === "--keep-app") {
      parsed.keepAppearance = true;
    } else if (token === "--skin") {
      if (!args.length) throw new Error("--skin 缺少值");
      parsed.skinName = path.basename(path.resolve(args.shift()));
    } else if (!token.startsWith("-") && parsed.skinName == null) {
      parsed.skinName = token;
    } else {
      throw new Error(`未知参数: ${token}`);
    }
  }
  if (parsed.command === "switch" && !parsed.skinName) throw new Error("switch 必须指定皮肤");
  if (!["start"].includes(parsed.command) && parsed.force) throw new Error(`命令 ${parsed.command} 不支持 --force`);
  if (!["start"].includes(parsed.command) && parsed.port != null && parsed.command !== "verify") throw new Error(`命令 ${parsed.command} 不支持 --port`);
  if (parsed.keepAppearance && parsed.command !== "stop") throw new Error(`命令 ${parsed.command} 不支持 --keep-appearance`);
  return parsed;
}

async function runInjector(mode, { port, skinDir = null, timeoutMs = 15_000 } = {}) {
  const args = [INJECTOR_PATH, `--${mode}`, "--port", String(port), "--timeout-ms", String(timeoutMs)];
  if (skinDir) args.push("--skin", skinDir);
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      error: error.message,
      code: error.code,
    };
  }
}

async function verifyWithRetry(skinDir, port, {
  timeoutMs = 18_000,
  intervalMs = 750,
  run = runInjector,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  do {
    last = await run("verify", { port, skinDir, timeoutMs: Math.min(8_000, timeoutMs) });
    if (last.ok && last.stdout.includes("全部验证通过")) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  const detail = [last?.stdout, last?.stderr, last?.error].filter(Boolean).join("\n").trim();
  throw new Error(`皮肤验证未通过${detail ? `:\n${detail}` : ""}`);
}

function stateForTheme(themePackage, { port, injectorPid, doubaoWorkPid, previous = null } = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    port,
    injectorPid,
    doubaoWorkPid: doubaoWorkPid || previous?.doubaoWorkPid || null,
    skinName: themePackage.directoryName,
    skinDir: themePackage.directoryPath,
    themeId: themePackage.theme.id,
    startedAt: previous?.startedAt || now,
    switchedAt: previous ? now : null,
  };
}

function formatFailure(result) {
  return [result?.stdout, result?.stderr, result?.error].filter(Boolean).join("\n").trim();
}

export function createCli(overrides = {}) {
  const deps = {
    discoverThemes,
    loadTheme,
    readRuntimeState,
    readPreferredTheme,
    rememberTheme,
    writeRuntimeState,
    clearRuntimeState,
    discoverCdpPort,
    readWatchProcess,
    findOwnedWatchProcesses,
    spawnWatchProcess,
    stopWatchProcess,
    findDoubaoWorkPid,
    launchDoubaoWork,
    stopDoubaoWork,
    selectAvailablePort,
    waitForCdp,
    runInjector,
    verifyWithRetry,
    log: console.log,
    error: console.error,
    ...overrides,
  };

  async function loadNamedTheme(name) {
    const names = await deps.discoverThemes();
    if (!names.includes(name)) throw new Error(`未知皮肤: ${name}；可用: ${names.join(", ")}`);
    return deps.loadTheme({ name });
  }

  async function saveSelection(name) {
    // 偏好写入失败不撤销已经验证成功的皮肤。
    await deps.rememberTheme(name).catch(error => deps.error(`皮肤已生效，但未能记住本次选择：${error.message}`));
  }

  async function list() {
    const [names, state] = await Promise.all([deps.discoverThemes(), deps.readRuntimeState()]);
    const watch = state ? await deps.readWatchProcess({ state }) : null;
    deps.log("\n豆包工作换肤\n");
    deps.log(`当前皮肤: ${state?.skinName || "未运行"}${watch ? ` (watch PID ${watch.pid})` : ""}`);
    deps.log(`CDP 端口: ${state?.port || DEFAULT_PORT}\n`);
    deps.log("可用皮肤:");
    for (const name of names) {
      const themePackage = await deps.loadTheme({ name });
      deps.log(`  ${name.padEnd(16)} ${themePackage.theme.name}  (${themePackage.theme.appearance})${name === state?.skinName ? " ← 当前" : ""}`);
    }
  }

  async function status() {
    const state = await deps.readRuntimeState();
    const owned = await deps.findOwnedWatchProcesses();
    const watch = state ? await deps.readWatchProcess({ state }) : null;
    deps.log(JSON.stringify({
      running: Boolean(watch),
      state,
      watch: watch ? { pid: watch.pid, port: watch.port, skinDir: watch.skinDir } : null,
      ownedWatchPids: owned.map((entry) => entry.pid),
      paths: runtimePaths,
    }, null, 2));
    return watch ? 0 : (state ? EXIT_PRECONDITION : 0);
  }

  async function rollbackTo(previousState, previousTheme, port) {
    if (!previousState || !previousTheme) return null;
    const injected = await deps.runInjector("once", { port, skinDir: previousTheme.directoryPath, timeoutMs: 20_000 });
    if (!injected.ok) throw new Error(`旧皮肤重新注入失败:\n${formatFailure(injected)}`);
    const pid = await deps.spawnWatchProcess({ port, skinDir: previousTheme.directoryPath });
    try {
      await deps.verifyWithRetry(previousTheme.directoryPath, port, { run: deps.runInjector });
      return await deps.writeRuntimeState(stateForTheme(previousTheme, {
        port,
        injectorPid: pid,
        doubaoWorkPid: previousState.doubaoWorkPid,
        previous: previousState,
      }));
    } catch (error) {
      await deps.stopWatchProcess({ state: { injectorPid: pid } });
      throw error;
    }
  }

  async function switchTheme(name) {
    const candidate = await loadNamedTheme(name);
    const previousState = await deps.readRuntimeState();
    const port = previousState?.port || DEFAULT_PORT;
    const previousTheme = previousState?.skinName ? await loadNamedTheme(previousState.skinName) : null;
    const active = previousState ? await deps.readWatchProcess({ state: previousState }) : null;
    if (!await deps.findDoubaoWorkPid()) throw Object.assign(new Error("豆包工作未运行，先执行 start"), { exitCode: EXIT_PRECONDITION });
    await deps.waitForCdp(port, { timeoutMs: 5_000 });
    if (previousState?.skinName === name && active) {
      await deps.verifyWithRetry(candidate.directoryPath, port, { run: deps.runInjector });
      await saveSelection(name);
      deps.log(`已经是「${candidate.theme.name}」，验证通过。`);
      return 0;
    }
    await deps.stopWatchProcess({ state: previousState });
    let candidatePid = null;
    try {
      const injected = await deps.runInjector("once", { port, skinDir: candidate.directoryPath, timeoutMs: 20_000 });
      if (!injected.ok) throw new Error(`候选皮肤注入失败:\n${formatFailure(injected)}`);
      candidatePid = await deps.spawnWatchProcess({ port, skinDir: candidate.directoryPath });
      await deps.verifyWithRetry(candidate.directoryPath, port, { run: deps.runInjector });
      const appPid = await deps.findDoubaoWorkPid();
      await deps.writeRuntimeState(stateForTheme(candidate, {
        port,
        injectorPid: candidatePid,
        doubaoWorkPid: appPid,
        previous: previousState,
      }));
      deps.log(`已切换到「${candidate.theme.name}」，watch PID ${candidatePid}`);
      await saveSelection(name);
      return 0;
    } catch (error) {
      if (candidatePid) await deps.stopWatchProcess({ state: { injectorPid: candidatePid } }).catch(() => {});
      try {
        if (previousState && previousTheme) {
          await rollbackTo(previousState, previousTheme, port);
        } else {
          const restored = await deps.runInjector("restore", { port, timeoutMs: 15_000 });
          if (!restored.ok) throw new Error(formatFailure(restored));
          await deps.clearRuntimeState();
        }
      } catch (rollbackError) {
        if (previousState) await deps.writeRuntimeState({ ...previousState, injectorPid: null }).catch(() => {});
        throw new Error(`${error.message}\n回滚失败: ${rollbackError.message}\n请执行: node skin.mjs restore`);
      }
      throw new Error(`${error.message}\n${previousState ? `已回滚到 ${previousState.skinName}` : "已恢复官方外观"}`);
    }
  }

  async function start(name = null, { port = DEFAULT_PORT, force = false } = {}) {
    const previousState = await deps.readRuntimeState();
    if (!name) {
      const preferred = await deps.readPreferredTheme() || previousState?.skinName;
      const names = await deps.discoverThemes();
      name = preferred && names.includes(preferred) ? preferred : "seaside-breeze";
      if (preferred && name !== preferred) deps.log(`上次的皮肤「${preferred}」已不存在，使用海风微语。`);
    }
    const candidate = await loadNamedTheme(name);
    const existingWatch = previousState ? await deps.readWatchProcess({ state: previousState }) : null;
    let appPid = await deps.findDoubaoWorkPid();
    let selectedPort = port;
    let cdpReady = false;
    if (appPid) {
      const discoveredPort = await deps.discoverCdpPort(previousState?.port || selectedPort);
      if (discoveredPort) {
        selectedPort = discoveredPort;
        cdpReady = true;
      }
    }
    // watch 独立于应用存活；应用正常重开后可能已没有 CDP。
    if (existingWatch && cdpReady && existingWatch.port === selectedPort && previousState.port === selectedPort) {
      return switchTheme(name);
    }
    await deps.stopWatchProcess({ state: previousState });
    if (appPid && !cdpReady) {
      if (!force) throw Object.assign(new Error(`豆包工作正在运行但没有可用 CDP；正常重新打开应用不会保留调试参数。请先退出应用再执行 start，或保存工作后执行: node skin.mjs start ${name} --force`), { exitCode: EXIT_PRECONDITION });
      await deps.stopDoubaoWork({ pid: appPid });
      appPid = null;
    }
    if (!cdpReady) {
      selectedPort = await deps.selectAvailablePort(selectedPort);
      await deps.launchDoubaoWork({ port: selectedPort });
      await deps.waitForCdp(selectedPort);
      appPid = await deps.findDoubaoWorkPid();
    }
    let watchPid = null;
    try {
      const injected = await deps.runInjector("once", { port: selectedPort, skinDir: candidate.directoryPath, timeoutMs: 20_000 });
      if (!injected.ok) throw new Error(`首次注入失败:\n${formatFailure(injected)}`);
      watchPid = await deps.spawnWatchProcess({ port: selectedPort, skinDir: candidate.directoryPath });
      await deps.verifyWithRetry(candidate.directoryPath, selectedPort, { run: deps.runInjector });
      await deps.writeRuntimeState(stateForTheme(candidate, {
        port: selectedPort,
        injectorPid: watchPid,
        doubaoWorkPid: appPid,
        previous: previousState,
      }));
      deps.log(`换肤已启动：${candidate.theme.name}，CDP ${selectedPort}，watch PID ${watchPid}`);
      await saveSelection(name);
      return 0;
    } catch (error) {
      if (watchPid) await deps.stopWatchProcess({ state: { injectorPid: watchPid } }).catch(() => {});
      await deps.runInjector("restore", { port: selectedPort, timeoutMs: 10_000 }).catch(() => {});
      throw error;
    }
  }

  async function stop({ keepAppearance = false } = {}) {
    const state = await deps.readRuntimeState();
    await deps.stopWatchProcess({ state });
    if (keepAppearance) {
      if (state) await deps.writeRuntimeState({ ...state, injectorPid: null });
      deps.log("watch 已停止，当前页面外观暂时保留。刷新或重建页面后不会自动恢复皮肤。");
      return 0;
    }
    if (state?.port) {
      const restored = await deps.runInjector("restore", { port: state.port, timeoutMs: 15_000 });
      if (!restored.ok) throw new Error(`恢复官方外观失败:\n${formatFailure(restored)}`);
    }
    await deps.clearRuntimeState();
    deps.log("换肤已停止，官方外观已恢复，状态已清除。");
    return 0;
  }

  async function restore() {
    const state = await deps.readRuntimeState();
    await deps.stopWatchProcess({ state });
    const port = state?.port || DEFAULT_PORT;
    const result = await deps.runInjector("restore", { port, timeoutMs: 15_000 });
    if (!result.ok) throw new Error(`恢复官方外观失败:\n${formatFailure(result)}`);
    await deps.clearRuntimeState();
    deps.log("官方外观已恢复。");
    return 0;
  }

  async function verify(name = null, port = null) {
    const state = await deps.readRuntimeState();
    const theme = await loadNamedTheme(name || state?.skinName || "seaside-breeze");
    const selectedPort = port || state?.port || DEFAULT_PORT;
    await deps.verifyWithRetry(theme.directoryPath, selectedPort, { timeoutMs: 15_000, run: deps.runInjector });
    deps.log(`验证通过：${theme.theme.name}`);
    return 0;
  }

  return {
    async run(parsed) {
      switch (parsed.command) {
        case "help": deps.log(usage()); return 0;
        case "list": await list(); return 0;
        case "status": return status();
        case "start": return start(parsed.skinName, { ...parsed, port: parsed.port ?? DEFAULT_PORT });
        case "stop": return stop(parsed);
        case "switch": return switchTheme(parsed.skinName);
        case "verify": return verify(parsed.skinName, parsed.port);
        case "restore": return restore();
        default: throw new Error(`未知命令: ${parsed.command}`);
      }
    },
    list,
    status,
    start,
    stop,
    switchTheme,
    verify,
    restore,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  return createCli().run(parsed);
}

const isDirect = process.argv[1] && (() => {
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();
if (isDirect) {
  main().then((code) => {
    process.exitCode = code || 0;
  }).catch((error) => {
    console.error(`错误: ${error.message}`);
    process.exitCode = error.exitCode || EXIT_FAILURE;
  });
}
