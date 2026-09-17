import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { fetchCdpJson } from "./cdp.mjs";
import { assertDoubaoWorkPort, DOUBAOWORK_BINARY, DOUBAOWORK_BROWSER_BINARY } from "./app-identity.mjs";
import {
  paths as platformPaths,
  inspectProcess as platformInspectProcess,
  listProcessesByName,
  isProcessAlive as platformIsProcessAlive,
  terminateProcess,
  killProcessTree,
  launchApp,
  discoverAppInstall,
  ensurePrivateDir,
  ensurePrivateFile,
} from "./platform/index.mjs";

export { DOUBAOWORK_BINARY, DOUBAOWORK_BROWSER_BINARY } from "./app-identity.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, "..");
export const INJECTOR_PATH = path.join(HERE, "injector.mjs");
export const STATE_SCHEMA_VERSION = 1;

export function createRuntimePaths(stateRoot = process.env.DWS_STATE_ROOT || platformPaths().dataRoot) {
  const root = path.resolve(stateRoot);
  return Object.freeze({
    root,
    state: path.join(root, "state.json"),
    preferences: path.join(root, "preferences.json"),
    injectorLog: path.join(root, "injector.log"),
    injectorErrorLog: path.join(root, "injector-error.log"),
    appLog: path.join(root, "doubaowork-launch.log"),
    appErrorLog: path.join(root, "doubaowork-launch-error.log"),
  });
}

export const runtimePaths = createRuntimePaths();

function positiveInteger(value, label, { optional = false } = {}) {
  if (optional && (value == null || value === "")) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} 必须是正整数`);
  return number;
}

function optionalString(value, label) {
  if (value == null) return null;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} 必须是非空字符串`);
  return value;
}

export function normalizeRuntimeState(raw, { projectRoot = PROJECT_ROOT } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("运行状态必须是 JSON 对象");
  const skinDir = optionalString(raw.skinDir, "skinDir");
  const derivedSkinName = skinDir ? path.basename(path.resolve(skinDir)) : null;
  const state = {
    schemaVersion: STATE_SCHEMA_VERSION,
    port: positiveInteger(raw.port, "port"),
    injectorPid: positiveInteger(raw.injectorPid, "injectorPid", { optional: true }),
    doubaoWorkPid: positiveInteger(raw.doubaoWorkPid, "doubaoWorkPid", { optional: true }),
    skinName: optionalString(raw.skinName, "skinName") || derivedSkinName,
    skinDir,
    themeId: optionalString(raw.themeId, "themeId"),
    startedAt: optionalString(raw.startedAt, "startedAt"),
    switchedAt: optionalString(raw.switchedAt, "switchedAt"),
  };
  if (!state.skinName && state.skinDir) state.skinName = path.relative(projectRoot, state.skinDir).split(path.sep).at(-1);
  return state;
}

export async function ensureRuntimeRoot(paths = runtimePaths) {
  await fs.mkdir(paths.root, { recursive: true });
  await ensurePrivateDir(paths.root).catch(() => {});
}

export async function readRuntimeState({ paths = runtimePaths, allowMissing = true } = {}) {
  let source;
  try {
    source = await fs.readFile(paths.state, "utf8");
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    return normalizeRuntimeState(JSON.parse(source));
  } catch (error) {
    throw new Error(`运行状态损坏 (${paths.state}): ${error.message}`);
  }
}

export async function writeRuntimeState(nextState, { paths = runtimePaths } = {}) {
  const normalized = normalizeRuntimeState(nextState);
  await ensureRuntimeRoot(paths);
  const temporary = path.join(paths.root, `.state.${process.pid}.${Date.now()}.tmp`);
  const content = `${JSON.stringify(normalized, null, 2)}\n`;
  try {
    await fs.writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await ensurePrivateFile(temporary).catch(() => {});
    await fs.rename(temporary, paths.state);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return normalized;
}

export async function updateRuntimeState(patch, options = {}) {
  const current = await readRuntimeState(options);
  if (!current) throw new Error("没有可更新的运行状态");
  return writeRuntimeState({ ...current, ...patch }, options);
}

export async function clearRuntimeState({ paths = runtimePaths } = {}) {
  await fs.rm(paths.state, { force: true });
}

export async function readPreferredTheme({ paths = runtimePaths } = {}) {
  try {
    const data = JSON.parse(await fs.readFile(paths.preferences, "utf8"));
    return typeof data?.lastTheme === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.lastTheme)
      ? data.lastTheme : null;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function rememberTheme(name, { paths = runtimePaths } = {}) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("无效的皮肤名称");
  await ensureRuntimeRoot(paths);
  const temporary = path.join(paths.root, `.preferences.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify({ lastTheme: name }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, paths.preferences);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export function isProcessAlive(pid, { killImpl = null } = {}) {
  if (killImpl) {
    try {
      killImpl(positiveInteger(pid, "PID"), 0);
      return true;
    } catch (error) {
      if (error?.code === "EPERM") return true;
      return false;
    }
  }
  // 异步版本通过 platform 层
  return platformIsProcessAlive(pid);
}

async function defaultInspectProcess(pid) {
  return platformInspectProcess(pid);
}

function parseWatchCommand(command, { injectorPath, cwd }) {
  const source = String(command || "").trim();
  if (!source) return null;
  const pathMod = pathFor(injectorPath);
  const absoluteInjector = pathMod.resolve(injectorPath);
  const candidates = [absoluteInjector, injectorPath];
  if (cwd) {
    candidates.push(pathMod.relative(cwd, absoluteInjector));
    candidates.push(pathMod.relative(cwd, injectorPath));
  }
  let injectorIndex = -1;
  let injectorToken = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const index = source.indexOf(candidate);
    if (index >= 0 && (injectorIndex < 0 || index < injectorIndex)) {
      injectorIndex = index;
      injectorToken = candidate;
    }
  }
  if (injectorIndex < 0) return null;
  // 截取可执行文件路径：处理 injector 前面的引号（Windows 风格）
  // macOS ps 输出不含引号但路径可能含空格；Windows 命令行含空格路径会被引号包裹
  let beforeInjector = source.slice(0, injectorIndex).trimEnd();
  // 如果 injector 前面是引号（Windows 风格中 injector 的开引号），去掉它
  if (beforeInjector.endsWith('"') || beforeInjector.endsWith("'")) {
    beforeInjector = beforeInjector.slice(0, -1).trimEnd();
  }
  // 去除可执行文件路径自身的首尾引号
  const executable = beforeInjector.trim().replace(/^["']|["']$/g, "");
  // 用正则匹配 node/node.exe，不依赖 path.basename（跨平台行为不一致）
  if (!/[\\/]node(\.exe)?$/i.test(executable)) return null;
  // 从原始字符串中提取参数值（能处理含空格的路径，macOS ps 输出不含引号）
  const rest = source.slice(injectorIndex + injectorToken.length);
  const portMatch = rest.match(/--port\s+(\d+)/);
  const skinMatch = rest.match(/--skin\s+(.+?)(?=\s+--(?:port|watch|timeout-ms)\b|$)/);
  if (!rest.includes("--watch") || !portMatch || !skinMatch) return null;
  // 去除 skinDir 的首尾引号（Windows 风格）
  const skinDir = skinMatch[1].trim().replace(/^["']|["']$/g, "");
  return {
    injectorToken,
    port: Number(portMatch[1]),
    skinDir,
  };
}

// 根据路径格式选择 posix 或 win32 的 path 实现（跨平台测试时需要）
function pathFor(p) {
  return (/^[A-Z]:[\\/]/i.test(p) || p.includes("\\")) ? path.win32 : path;
}

export async function inspectWatchProcess(pid, {
  inspectProcess = defaultInspectProcess,
  projectRoot = PROJECT_ROOT,
  injectorPath = INJECTOR_PATH,
} = {}) {
  const numericPid = positiveInteger(pid, "PID");
  let info;
  try {
    info = await inspectProcess(numericPid);
  } catch {
    return null;
  }
  const pathMod = pathFor(injectorPath);
  const cwd = info.cwd ? pathMod.resolve(info.cwd) : null;
  const parsed = parseWatchCommand(info.command, { injectorPath, cwd });
  if (!parsed) return null;
  const resolvedInjector = pathMod.isAbsolute(parsed.injectorToken)
    ? pathMod.resolve(parsed.injectorToken)
    : cwd
      ? pathMod.resolve(cwd, parsed.injectorToken)
      : null;
  if (resolvedInjector !== pathMod.resolve(injectorPath)) return null;
  if (cwd && cwd !== pathMod.resolve(projectRoot)) return null;
  return { pid: numericPid, command: info.command, cwd, port: parsed.port, skinDir: parsed.skinDir };
}

export async function findOwnedWatchProcesses({
  listProcesses,
  inspectProcess = defaultInspectProcess,
  projectRoot = PROJECT_ROOT,
  injectorPath = INJECTOR_PATH,
} = {}) {
  let rows;
  if (listProcesses) rows = await listProcesses();
  else {
    rows = await listProcessesByName(["node", "node.exe"]);
  }
  const likely = rows.filter((row) => String(row.command || "").includes("injector.mjs") && String(row.command || "").includes("--watch"));
  const owned = [];
  for (const row of likely) {
    const match = await inspectWatchProcess(row.pid, { inspectProcess, projectRoot, injectorPath });
    if (match) owned.push(match);
  }
  return owned;
}

export async function readWatchProcess({ state = null, ...options } = {}) {
  if (state?.injectorPid) {
    const direct = await inspectWatchProcess(state.injectorPid, options);
    if (direct) return direct;
  }
  const owned = await findOwnedWatchProcesses(options);
  return owned.length === 1 ? owned[0] : null;
}

export async function waitForProcessExit(pid, {
  timeoutMs = 5_000,
  intervalMs = 100,
  alive = null,
} = {}) {
  const checkAlive = alive || ((p) => platformIsProcessAlive(p));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await checkAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return !await checkAlive(pid);
}

export async function stopWatchProcess({
  state = null,
  signal = null,
  findOwned = findOwnedWatchProcesses,
  waitForExit = waitForProcessExit,
} = {}) {
  const owned = await findOwned();
  const candidates = new Map(owned.map((entry) => [entry.pid, entry]));
  if (state?.injectorPid && !candidates.has(state.injectorPid)) {
    const direct = await inspectWatchProcess(state.injectorPid);
    if (direct) candidates.set(direct.pid, direct);
  }
  for (const entry of candidates.values()) {
    if (signal) signal(entry.pid, "SIGTERM");
    else await terminateProcess(entry.pid).catch(() => {});
  }
  for (const entry of candidates.values()) {
    if (!await waitForExit(entry.pid)) {
      if (signal) signal(entry.pid, "SIGKILL");
      else await killProcessTree(entry.pid).catch(() => {});
      if (!await waitForExit(entry.pid, { timeoutMs: 2_000 })) throw new Error(`无法停止 watch 进程 ${entry.pid}`);
    }
  }
  return [...candidates.values()];
}

export async function findDoubaoWorkPid({ execFileImpl = null } = {}) {
  if (execFileImpl) {
    // 测试注入：原有 pgrep 逻辑
    const { stdout } = await execFileImpl("pgrep", ["-f", DOUBAOWORK_BINARY], { encoding: "utf8" });
    const pids = stdout.trim().split(/\s+/).filter(Boolean).map(Number);
    return pids.length ? pids[0] : null;
  }
  // 正常路径：通过 platform 层获取实际应用路径，按进程名查找
  const install = await discoverAppInstall().catch(() => null);
  const mainBinary = install?.mainBinary || DOUBAOWORK_BINARY;
  const mainName = path.basename(mainBinary).replace(/\.exe$/i, "");
  const rows = await listProcessesByName([mainName, `${mainName}.exe`]).catch(() => []);
  // 优先用 executablePath 精确匹配（不受命令行引号影响），其次用命令行匹配
  const normalizedMain = path.resolve(mainBinary).toLowerCase();
  const match = rows.find((row) => {
    if (row.executablePath && path.resolve(row.executablePath).toLowerCase() === normalizedMain) return true;
    // 提取命令行中第一个可执行文件路径（去除引号包裹），兼容 Windows "C:\...\exe" --args 格式
    const cmd = String(row.command || "");
    const firstToken = cmd.startsWith('"')
      ? cmd.slice(1, cmd.indexOf('"', 1))
      : cmd.split(/\s+/)[0];
    if (!firstToken) return false;
    return path.resolve(firstToken).toLowerCase() === normalizedMain;
  });
  return match ? match.pid : null;
}

export async function selectAvailablePort(preferred, {
  isPortListening = (port) => new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (listening) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  }),
} = {}) {
  preferred = positiveInteger(preferred, "port");
  if (preferred > 65535) throw new Error("port 必须是 1 到 65535 的整数");
  if (!await isPortListening(preferred)) return preferred;
  const lastPort = Math.min(preferred + 5, 65535);
  for (let offset = 1; preferred + offset <= lastPort; offset++) {
    if (!await isPortListening(preferred + offset)) return preferred + offset;
  }
  throw new Error(`端口 ${preferred}-${lastPort} 均不可用`);
}

export async function launchDoubaoWork({
  port,
  paths = runtimePaths,
  spawnImpl = null,
  binary = DOUBAOWORK_BINARY,
} = {}) {
  positiveInteger(port, "port");
  await ensureRuntimeRoot(paths);
  const stdoutFd = fsSync.openSync(paths.appLog, "a", 0o600);
  const stderrFd = fsSync.openSync(paths.appErrorLog, "a", 0o600);
  try {
    if (spawnImpl) {
      // 测试注入：保持原有 spawn 接口
      const child = spawnImpl(binary, [
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${port}`,
      ], {
        detached: true,
        stdio: ["ignore", stdoutFd, stderrFd],
        env: process.env,
      });
      if (!child?.pid) throw new Error("豆包工作进程未返回 PID");
      child.unref?.();
      return child.pid;
    }
    // 正常路径：通过 platform 层启动
    const install = await discoverAppInstall();
    if (!install) throw new Error("未找到豆包工作安装");
    return launchApp(install, port, { logFd: stdoutFd, errorFd: stderrFd });
  } finally {
    fsSync.closeSync(stdoutFd);
    fsSync.closeSync(stderrFd);
  }
}

export async function findDoubaoWorkBrowserPids({ execFileImpl = null } = {}) {
  if (execFileImpl) {
    // 测试注入：原有 ps 逻辑
    const { stdout } = await execFileImpl("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    return stdout.split("\n").map((line) => {
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
    }).filter((row) => {
      if (!row) return false;
      return row.command === DOUBAOWORK_BROWSER_BINARY || row.command.startsWith(`${DOUBAOWORK_BROWSER_BINARY} --`);
    }).map((row) => row.pid);
  }
  // 正常路径：通过 platform 层获取实际应用路径
  const install = await discoverAppInstall().catch(() => null);
  const helperBinary = install?.helperBinary || DOUBAOWORK_BROWSER_BINARY;
  const helperName = path.basename(helperBinary).replace(/\.exe$/i, "");
  const rows = await listProcessesByName([helperName, `${helperName}.exe`]).catch(() => []);
  const normalizedHelper = path.resolve(helperBinary).toLowerCase();
  return rows
    .filter((row) => {
      if (row.executablePath && path.resolve(row.executablePath).toLowerCase() === normalizedHelper) return true;
      const command = String(row.command || "");
      const firstToken = command.startsWith('"')
        ? command.slice(1, command.indexOf('"', 1))
        : command.split(/\s+/)[0];
      if (!firstToken) return false;
      return path.resolve(firstToken).toLowerCase() === normalizedHelper;
    })
    .map((row) => row.pid);
}

export async function stopDoubaoWork({
  pid,
  signal = null,
  waitForExit = waitForProcessExit,
  findBrowserPids = findDoubaoWorkBrowserPids,
} = {}) {
  const numericPid = positiveInteger(pid, "豆包工作 PID");
  const browserPids = await findBrowserPids();
  if (signal) signal(numericPid, "SIGTERM");
  else await terminateProcess(numericPid).catch(() => {});
  if (!await waitForExit(numericPid, { timeoutMs: 10_000 })) {
    if (signal) signal(numericPid, "SIGKILL");
    else await killProcessTree(numericPid).catch(() => {});
    if (!await waitForExit(numericPid, { timeoutMs: 2_000 })) throw new Error(`无法停止豆包工作进程 ${numericPid}`);
  }
  // 主应用是 shim；它退出不代表持有 profile 单例锁的浏览器已经退出。
  for (const browserPid of browserPids) {
    if (!await waitForExit(browserPid, { timeoutMs: 10_000 })) {
      throw new Error(`豆包工作浏览器 PID ${browserPid} 尚未退出；请完全退出应用后重试，避免新启动的 CDP 参数被旧实例忽略`);
    }
  }
}

export async function spawnWatchProcess({
  port,
  skinDir,
  paths = runtimePaths,
  spawnImpl = spawn,
  nodePath = process.execPath,
  injectorPath = INJECTOR_PATH,
  projectRoot = PROJECT_ROOT,
} = {}) {
  positiveInteger(port, "port");
  if (!skinDir) throw new Error("skinDir 必填");
  await ensureRuntimeRoot(paths);
  const stdoutFd = fsSync.openSync(paths.injectorLog, "a", 0o600);
  const stderrFd = fsSync.openSync(paths.injectorErrorLog, "a", 0o600);
  try {
    const child = spawnImpl(nodePath, [injectorPath, "--watch", "--port", String(port), "--skin", path.resolve(skinDir)], {
      cwd: projectRoot,
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      env: process.env,
      windowsHide: true,
    });
    if (!child?.pid) throw new Error("watch 进程未返回 PID");
    child.unref?.();
    return child.pid;
  } finally {
    fsSync.closeSync(stdoutFd);
    fsSync.closeSync(stderrFd);
  }
}

export async function discoverCdpPort(preferred, {
  maxOffset = 5,
  timeoutMs = 2_000,
  fetchImpl = globalThis.fetch,
  assertPortOwner = assertDoubaoWorkPort,
} = {}) {
  positiveInteger(preferred, "port");
  for (let offset = 0; offset <= maxOffset && preferred + offset <= 65535; offset++) {
    const port = preferred + offset;
    try {
      await fetchCdpJson(port, "/json/version", { timeoutMs, fetchImpl, assertPortOwner });
      return port;
    } catch {}
  }
  return null;
}

export async function waitForCdp(port, { timeoutMs = 45_000, intervalMs = 500, fetchImpl = globalThis.fetch } = {}) {
  positiveInteger(port, "port");
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fetchCdpJson(port, "/json/version", { timeoutMs: Math.min(intervalMs, 2_000), fetchImpl });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error(`等待 CDP 端口 ${port} 超时${lastError ? `: ${lastError.message}` : ""}`);
}
