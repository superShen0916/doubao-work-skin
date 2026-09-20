import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const DOUBAOWORK_BINARY = "/Applications/DoubaoWork.app/Contents/MacOS/DoubaoWork";
export const DOUBAOWORK_BROWSER_BINARY = "/Applications/DoubaoWork.app/Contents/Helpers/DoubaoWork Browser.app/Contents/MacOS/DoubaoWork Browser";
// pgrep -f 匹配进程命令行，使用相对路径子串（兼容绝对路径启动的进程）
export const DOUBAOWORK_PGREP_PATTERN = DOUBAOWORK_BINARY.replace(/^\/Applications\//, "");
const APP_EXECUTABLES = new Set([DOUBAOWORK_BINARY, DOUBAOWORK_BROWSER_BINARY]);

// 不信任 CDP 返回的 Browser 名称、页面标题或命令行子串。
// 每次 HTTP 请求和 WebSocket 建连前，重新核对实际监听进程的可执行文件。
export async function assertDoubaoWorkPort(port, { execFileImpl = execFileAsync } = {}) {
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(`无效 CDP 端口: ${port}`);
  }
  const options = { encoding: "utf8", timeout: 2_000, maxBuffer: 1024 * 1024 };
  try {
    const { stdout } = await execFileImpl("lsof", ["-nP", `-iTCP:${Number(port)}`, "-sTCP:LISTEN", "-Fp"], options);
    const pids = [...new Set(stdout.split("\n").filter(line => /^p[1-9]\d*$/.test(line)).map(line => line.slice(1)))];
    if (!pids.length) throw new Error("未找到监听进程");
    for (const pid of pids) {
      const { stdout: executable } = await execFileImpl("ps", ["-p", pid, "-o", "comm="], options);
      if (!APP_EXECUTABLES.has(executable.trim())) throw new Error("监听进程不属于豆包工作");
    }
  } catch (error) {
    throw new Error(`无法确认 CDP 端口 ${port} 属于豆包工作，已拒绝连接`, { cause: error });
  }
}
