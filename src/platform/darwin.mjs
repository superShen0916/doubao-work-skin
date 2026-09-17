/**
 * macOS 平台实现
 *
 * 从原有 app-identity.mjs / runtime.mjs / user-data.mjs / install.mjs 迁移。
 * 保持与重构前完全一致的行为。
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DOUBAOWORK_BINARY = "/Applications/DoubaoWork.app/Contents/MacOS/DoubaoWork";
const DOUBAOWORK_BROWSER_BINARY = "/Applications/DoubaoWork.app/Contents/Helpers/DoubaoWork Browser.app/Contents/MacOS/DoubaoWork Browser";

// ─── 路径 ───────────────────────────────────────────────

export function paths() {
  const dataRoot = process.env.DWS_STATE_ROOT || path.join(
    process.env.HOME || "",
    "Library/Application Support/DoubaoWorkSkin",
  );
  return {
    dataRoot: path.resolve(dataRoot),
    defaultSkinsDir: process.env.DWS_SKINS_DIR || "",
    desktopDir: process.env.DWS_DESKTOP_DIR || path.join(os.homedir(), "Desktop"),
  };
}

// ─── 应用定位 ───────────────────────────────────────────

export async function discoverAppInstall() {
  try {
    await fs.access(DOUBAOWORK_BINARY);
  } catch {
    return null;
  }
  return {
    type: "desktop",
    mainBinary: DOUBAOWORK_BINARY,
    helperBinary: DOUBAOWORK_BROWSER_BINARY,
    version: null,
  };
}

// ─── 应用启动 ───────────────────────────────────────────

export async function launchApp(install, port, { logFd, errorFd } = {}) {
  const child = spawn(install.mainBinary, [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
  ], {
    detached: true,
    stdio: ["ignore", logFd || "ignore", errorFd || "ignore"],
    env: process.env,
  });
  if (!child?.pid) throw new Error("豆包工作进程未返回 PID");
  child.unref?.();
  return child.pid;
}

// ─── 端口与进程 ─────────────────────────────────────────

export async function findListeningPids(port) {
  const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${Number(port)}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024 });
  return [...new Set(
    stdout.split("\n")
      .filter((line) => /^p[1-9]\d*$/.test(line))
      .map((line) => Number(line.slice(1))),
  )];
}

export async function getProcessExecutable(pid) {
  const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 2000 });
  return stdout.trim() || null;
}

export async function inspectProcess(pid) {
  const [{ stdout: command }, cwdResult] = await Promise.all([
    execFileAsync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }),
    execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" }).catch(() => ({ stdout: "" })),
  ]);
  const cwdLine = String(cwdResult.stdout || "").split("\n").find((line) => line.startsWith("n"));
  return { command: command.trim(), cwd: cwdLine ? cwdLine.slice(1) : null };
}

export async function listProcessesByName(exeNames) {
  // 先用 comm 获取进程名（不受路径空格影响），再获取完整命令行
  const { stdout: commOut } = await execFileAsync("ps", ["-axo", "pid=,comm="], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const namePatterns = exeNames.map((name) => {
    const base = name.replace(/\.exe$/i, "");
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped}(\\.exe)?$`, "i");
  });
  const matchingPids = commOut.split("\n").map((line) => {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    return match ? { pid: Number(match[1]), comm: match[2].trim() } : null;
  }).filter((entry) => {
    if (!entry) return false;
    return namePatterns.some((re) => re.test(entry.comm));
  }).map((e) => e.pid);

  // 对匹配的 PID 获取完整命令行和可执行文件路径
  const result = [];
  for (const pid of matchingPids) {
    try {
      const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
      result.push({ pid, command: stdout.trim(), executablePath: null });
    } catch { /* 进程已退出 */ }
  }
  return result;
}

export async function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    return false;
  }
}

export async function terminateProcess(pid) {
  process.kill(Number(pid), "SIGTERM");
}

export async function killProcessTree(pid) {
  process.kill(Number(pid), "SIGKILL");
}

// ─── Shell 与脚本生成 ───────────────────────────────────

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function generateCliEntry(dataRoot, nodePath, bridgePath) {
  return `#!/bin/sh\nunset NODE_OPTIONS NODE_PATH\nexport DWS_STATE_ROOT=${shellQuote(dataRoot)}\nexec ${shellQuote(nodePath)} ${shellQuote(bridgePath)} "$@"\n`;
}

export function launcherScripts(command) {
  const run = shellQuote(command);
  return {
    "启动豆包工作.command": `#!/bin/zsh
set -u
unset NODE_OPTIONS NODE_PATH
${run} start
result=$?
if (( result == 2 )); then
  if [[ ! -t 0 ]]; then
    print -u2 '需要重启。请保存工作后由用户双击此入口确认。'
    exit 2
  fi
  print '\\n需要重启豆包工作。请保存工作，并等待 Agent 当前任务结束。'
  read -r 'answer?确认已保存并重启？输入 y 后回车，其他输入取消：'
  if [[ "$answer" == [yY] ]]; then
    ${run} start --force
    result=$?
  else
    print '已取消，豆包工作保持打开。'
  fi
fi
exit $result
`,
    "恢复官方外观.command": `#!/bin/zsh\nunset NODE_OPTIONS NODE_PATH\n${run} disable\n`,
    "复制换肤提示词.command": `#!/bin/zsh
set -eu
unset NODE_OPTIONS NODE_PATH
prompt_text="$(${run} prompt)"
print -rn -- "$prompt_text" | /usr/bin/pbcopy
print '已复制，粘贴到豆包工作对话即可。'
`,
  };
}

// ─── 桌面快捷方式 ───────────────────────────────────────

export async function createDesktopShortcut(targetPath, linkName, desktopDirOverride = null) {
  const desktopDir = desktopDirOverride || paths().desktopDir;
  await fs.mkdir(desktopDir, { recursive: true });
  const link = path.join(desktopDir, linkName);
  const existing = await fs.lstat(link).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!existing) {
    await fs.symlink(targetPath, link);
  } else if (!existing.isSymbolicLink() || await fs.readlink(link) !== targetPath) {
    throw new Error("桌面已有同名内容，未覆盖");
  }
}

// ─── 权限 ───────────────────────────────────────────────

export async function ensurePrivateDir(dirPath) {
  await fs.chmod(dirPath, 0o700);
}

export async function ensurePrivateFile(filePath) {
  await fs.chmod(filePath, 0o600);
}
