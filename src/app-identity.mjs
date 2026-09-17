/**
 * 应用身份验证
 *
 * 不信任 CDP 返回的 Browser 名称、页面标题或命令行子串。
 * 每次 HTTP 请求和 WebSocket 建连前，重新核对实际监听进程的可执行文件。
 *
 * 平台差异通过 platform 层抽象；macOS 保持原有行为。
 * 测试可通过 execFileImpl 注入 mock 的 lsof/ps 命令。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { findListeningPids, getProcessExecutable, discoverAppInstall } from "./platform/index.mjs";

const execFileAsync = promisify(execFile);

// 保留导出兼容性：macOS 上的固定路径，供 runtime.mjs 等模块引用
export const DOUBAOWORK_BINARY = "/Applications/DoubaoWork.app/Contents/MacOS/DoubaoWork";
export const DOUBAOWORK_BROWSER_BINARY = "/Applications/DoubaoWork.app/Contents/Helpers/DoubaoWork Browser.app/Contents/MacOS/DoubaoWork Browser";

const APP_EXECUTABLES = new Set([DOUBAOWORK_BINARY, DOUBAOWORK_BROWSER_BINARY]);

async function findListeningPidsWithImpl(port, execFileImpl) {
  if (execFileImpl) {
    const { stdout } = await execFileImpl("lsof", ["-nP", `-iTCP:${Number(port)}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8", timeout: 2_000, maxBuffer: 1024 * 1024 });
    return [...new Set(stdout.split("\n").filter((line) => /^p[1-9]\d*$/.test(line)).map((line) => Number(line.slice(1))))];
  }
  return findListeningPids(port);
}

async function getProcessExecutableWithImpl(pid, execFileImpl) {
  if (execFileImpl) {
    const { stdout } = await execFileImpl("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 2_000 });
    return stdout.trim();
  }
  return getProcessExecutable(pid);
}

export async function assertDoubaoWorkPort(port, { execFileImpl } = {}) {
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(`无效 CDP 端口: ${port}`);
  }
  try {
    const pids = await findListeningPidsWithImpl(port, execFileImpl);
    if (!pids.length) throw new Error("未找到监听进程");

    const install = await discoverAppInstall().catch(() => null);
    const allowedDir = install ? path.dirname(install.mainBinary).toLowerCase() : null;

    for (const pid of pids) {
      const executable = await getProcessExecutableWithImpl(pid, execFileImpl);
      const trimmed = executable?.trim();
      if (!trimmed) throw new Error("监听进程不属于豆包工作");
      // macOS 精确匹配完整路径（原有行为）
      if (APP_EXECUTABLES.has(trimmed)) continue;
      // 跨平台回退：验证目录匹配
      if (allowedDir && path.dirname(trimmed).toLowerCase().startsWith(allowedDir)) continue;
      throw new Error("监听进程不属于豆包工作");
    }
  } catch (error) {
    throw new Error(`无法确认 CDP 端口 ${port} 属于豆包工作，已拒绝连接`, { cause: error });
  }
}
