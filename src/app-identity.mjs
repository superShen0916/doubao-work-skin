import * as platform from "./platform/index.mjs";

// macOS 固定可执行文件路径（与 main 一致）
const MAC_MAIN = "/Applications/DoubaoWork.app/Contents/MacOS/DoubaoWork";
const MAC_HELPER = "/Applications/DoubaoWork.app/Contents/Helpers/DoubaoWork Browser.app/Contents/MacOS/DoubaoWork Browser";
export const DOUBAOWORK_BINARY = MAC_MAIN;
export const DOUBAOWORK_BROWSER_BINARY = MAC_HELPER;
// pgrep -f 匹配进程命令行，使用相对路径子串（兼容绝对路径启动的进程）
export const DOUBAOWORK_PGREP_PATTERN = DOUBAOWORK_BINARY.replace(/^\/Applications\//, "");

function macAllowlist() {
  return new Set([MAC_MAIN, MAC_HELPER]);
}

// Windows：通过 discoverAppInstall 解析出真实 main/helper 路径，大小写不敏感比较
//
// M6：discoverAppInstall 每次会 spawn 多个 powershell（WMI 进程枚举 + Appx 包探测），
// 而 assertDoubaoWorkPort 在每次 HTTP/WS 握手前都要建白名单。把结果缓存 30 秒，
// 避免同一进程内反复 spawn。已知限制：缓存期内应用路径变化不会被察觉（安装路径在会话内基本不变，可接受）。
export const DISCOVER_CACHE_TTL_MS = 30_000;
let _cachedWinInstall = { install: null, at: 0 };

export function _resetWinInstallCacheForTest() {
  _cachedWinInstall = { install: null, at: 0 };
}

export async function discoverWinInstallCached(discover) {
  const now = Date.now();
  if (_cachedWinInstall.install && now - _cachedWinInstall.at < DISCOVER_CACHE_TTL_MS) {
    return _cachedWinInstall.install;
  }
  const install = await discover();
  _cachedWinInstall = { install, at: Date.now() };
  return install;
}

async function winAllowlist(discover, { useCache = false } = {}) {
  const install = useCache ? await discoverWinInstallCached(discover) : await discover();
  const set = new Set();
  if (install?.mainBinary) set.add(install.mainBinary.toLowerCase());
  if (install?.helperBinary) set.add(install.helperBinary.toLowerCase());
  if (set.size === 0) throw new Error("未找到已安装的豆包工作，无法建立可信进程白名单");
  return set;
}

// 不信任 CDP 返回的 Browser 名称、页面标题或命令行子串。
// 每次 HTTP 请求和 WebSocket 建连前，重新核对实际监听进程的可执行文件。
// deps 仅用于测试注入；生产调用不传。
export async function assertDoubaoWorkPort(port, deps = {}) {
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(`无效 CDP 端口: ${port}`);
  }
  const {
    findListeningPids = platform.findListeningPids,
    getProcessExecutable = platform.getProcessExecutable,
    discoverAppInstall = platform.discoverAppInstall,
    platformName = process.platform,
  } = deps;
  // 只有生产默认 discover 才走缓存；测试注入的 mock 不缓存，避免用例间串味。
  const useCache = platformName === "win32" && discoverAppInstall === platform.discoverAppInstall;
  try {
    const pids = await findListeningPids(Number(port));
    if (!pids || pids.length === 0) throw new Error("未找到监听进程");
    const allow = platformName === "win32" ? await winAllowlist(discoverAppInstall, { useCache }) : macAllowlist();
    for (const pid of pids) {
      const exe = await getProcessExecutable(pid);
      const normalized = platformName === "win32" ? String(exe || "").toLowerCase() : String(exe || "").trim();
      if (!normalized) throw new Error("监听进程可执行文件路径为空");
      if (!allow.has(normalized)) throw new Error(`监听进程不属于豆包工作：${exe}`);
    }
  } catch (error) {
    throw new Error(`无法确认 CDP 端口 ${port} 属于豆包工作，已拒绝连接`, { cause: error });
  }
}
