import { spawn } from "node:child_process";
import { once } from "node:events";

// Resolve only after the OS accepted the executable. An async spawn error must
// become a normal CLI failure, not an unhandled 'error' event or a bogus PID.
export async function spawnApp(binary, port, { logFd, errorFd, spawnImpl = spawn } = {}) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    throw new Error(`无效端口: ${port}`);
  }
  if (typeof binary !== "string" || !binary) throw new Error("缺少应用可执行文件路径");
  const child = spawnImpl(binary, [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${numericPort}`,
  ], {
    detached: true,
    stdio: ["ignore", logFd ?? "ignore", errorFd ?? "ignore"],
    env: process.env,
    // Hide the launcher console, not the GUI application it is launching.
    windowsHide: false,
  });
  await once(child, "spawn");
  if (!child.pid) throw new Error("豆包工作进程未返回 PID");
  child.unref();
  return child.pid;
}
