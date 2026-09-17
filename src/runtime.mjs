import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fetchCdpJson } from "./cdp.mjs";
import { assertDoubaoWorkPort, DOUBAOWORK_BINARY, DOUBAOWORK_BROWSER_BINARY } from "./app-identity.mjs";
export { DOUBAOWORK_BINARY, DOUBAOWORK_BROWSER_BINARY } from "./app-identity.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, "..");
export const INJECTOR_PATH = path.join(HERE, "injector.mjs");
export const STATE_SCHEMA_VERSION = 1;

export function createRuntimePaths(stateRoot = process.env.DWS_STATE_ROOT || path.join(
  process.env.HOME || "",
  "Library/Application Support/DoubaoWorkSkin",
)) {
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
  await fs.mkdir(paths.root, { recursive: true, mode: 0o700 });
  await fs.chmod(paths.root, 0o700);
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
    await fs.chmod(temporary, 0o600);
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

export function isProcessAlive(pid, { killImpl = process.kill } = {}) {
  try {
    killImpl(positiveInteger(pid, "PID"), 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    return false;
  }
}

async function defaultInspectProcess(pid) {
  const [{ stdout: command }, cwdResult] = await Promise.all([
    execFileAsync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }),
    execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" }).catch(() => ({ stdout: "" })),
  ]);
  const cwdLine = String(cwdResult.stdout || "").split("\n").find((line) => line.startsWith("n"));
  return { command: command.trim(), cwd: cwdLine ? cwdLine.slice(1) : null };
}

function parseWatchCommand(command, { injectorPath, cwd }) {
  const source = String(command || "").trim();
  const absoluteInjector = path.resolve(injectorPath);
  const candidates = [absoluteInjector];
  if (cwd) candidates.push(path.relative(cwd, absoluteInjector));
  let injectorToken = null;
  let injectorIndex = -1;
  for (const candidate of candidates) {
    const index = source.indexOf(candidate);
    if (index >= 0 && (injectorIndex < 0 || index < injectorIndex)) {
      injectorToken = candidate;
      injectorIndex = index;
    }
  }
  if (injectorIndex < 0) return null;
  const executable = source.slice(0, injectorIndex).trim();
  if (!(executable === "node" || executable.endsWith("/node"))) return null;
  const tokens = source.slice(injectorIndex + injectorToken.length).trim().split(/\s+/);
  const watchIndex = tokens.indexOf("--watch");
  const portIndex = tokens.indexOf("--port");
  const skinIndex = tokens.indexOf("--skin");
  if (watchIndex < 0 || portIndex < 0 || skinIndex < 0) return null;
  return {
    injectorToken,
    port: Number(tokens[portIndex + 1]),
    skinDir: source.slice(injectorIndex + injectorToken.length).trim()
      .match(/(?:^|\s)--skin\s+(.+?)(?=\s+--(?:port|watch|timeout-ms)\b|$)/)?.[1] || null,
  };
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
  const cwd = info.cwd ? path.resolve(info.cwd) : null;
  const parsed = parseWatchCommand(info.command, { injectorPath, cwd });
  if (!parsed) return null;
  const resolvedInjector = path.isAbsolute(parsed.injectorToken)
    ? path.resolve(parsed.injectorToken)
    : cwd
      ? path.resolve(cwd, parsed.injectorToken)
      : null;
  if (resolvedInjector !== path.resolve(injectorPath)) return null;
  if (cwd && cwd !== path.resolve(projectRoot)) return null;
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
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    rows = stdout.split("\n").map((line) => {
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
    }).filter(Boolean);
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
  alive = isProcessAlive,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return !alive(pid);
}

export async function stopWatchProcess({
  state = null,
  signal = process.kill,
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
    signal(entry.pid, "SIGTERM");
  }
  for (const entry of candidates.values()) {
    if (!await waitForExit(entry.pid)) {
      signal(entry.pid, "SIGKILL");
      if (!await waitForExit(entry.pid, { timeoutMs: 2_000 })) throw new Error(`无法停止 watch 进程 ${entry.pid}`);
    }
  }
  return [...candidates.values()];
}

export async function findDoubaoWorkPid({ execFileImpl = execFileAsync } = {}) {
  try {
    const { stdout } = await execFileImpl("pgrep", ["-f", "DoubaoWork.app/Contents/MacOS/DoubaoWork"], { encoding: "utf8" });
    const pid = String(stdout).split("\n").map(Number).find((value) => Number.isInteger(value) && value > 0);
    return pid || null;
  } catch {
    return null;
  }
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
  spawnImpl = spawn,
  binary = DOUBAOWORK_BINARY,
} = {}) {
  positiveInteger(port, "port");
  await ensureRuntimeRoot(paths);
  const stdoutFd = fsSync.openSync(paths.appLog, "a", 0o600);
  const stderrFd = fsSync.openSync(paths.appErrorLog, "a", 0o600);
  try {
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
  } finally {
    fsSync.closeSync(stdoutFd);
    fsSync.closeSync(stderrFd);
  }
}

export async function findDoubaoWorkBrowserPids({ execFileImpl = execFileAsync } = {}) {
  const { stdout } = await execFileImpl("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) return [];
    const command = match[2];
    return command === DOUBAOWORK_BROWSER_BINARY || command.startsWith(`${DOUBAOWORK_BROWSER_BINARY} --`)
      ? [Number(match[1])] : [];
  });
}

export async function stopDoubaoWork({
  pid,
  signal = process.kill,
  waitForExit = waitForProcessExit,
  findBrowserPids = findDoubaoWorkBrowserPids,
} = {}) {
  const numericPid = positiveInteger(pid, "豆包工作 PID");
  const browserPids = await findBrowserPids();
  signal(numericPid, "SIGTERM");
  if (!await waitForExit(numericPid, { timeoutMs: 10_000 })) {
    signal(numericPid, "SIGKILL");
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
