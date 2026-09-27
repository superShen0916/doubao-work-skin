/**
 * Windows 平台实现
 *
 * 设计决策（参考 Codex Dream Skin 等同类项目）：
 * - 应用定位三级策略：进程反查 → 桌面路径遍历 → Store 包探测
 * - 启动双轨制：桌面版直接 spawn；Store 版用 IApplicationActivationManager
 * - 启动后必须验证 CDP 端口（Store 应用可能吃掉调试参数）
 * - 端口查询用原生 netstat；进程元信息用 Get-CimInstance
 * - 数据目录用 %LOCALAPPDATA%（不漫游，因 engine 含 Node 二进制）
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import { silentLauncherScript, silentLauncherHostScript } from "./windows-launcher.mjs";
export { silentLauncherScript, silentLauncherHostScript } from "./windows-launcher.mjs";

import { spawnApp } from "./spawn-app.mjs";
const execFileAsync = promisify(execFile);

const POWERSHELL = "powershell.exe";
const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

async function runPowerShell(script, { timeout = 10_000 } = {}) {
  // 设置输出编码为 UTF-8，确保中文路径和输出正确解码
  const wrapped = `
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    ${script}
  `;
  const { stdout, stderr } = await execFileAsync(POWERSHELL, [...PS_ARGS, wrapped], {
    encoding: "utf8",
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout.trim();
}

function parsePowerShellJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ─── 路径 ───────────────────────────────────────────────

// 桌面 Known Folder 路径可能被组策略/重定向到非 %USERPROFILE%\Desktop，
// 不能直接拼 os.homedir()/Desktop。用 [Environment]::GetFolderPath('Desktop')
// 向 shell 查询真实路径，结果缓存到模块级变量（同一进程内不变），失败回退到 homedir。
let _desktopDirCache = null;
function detectDesktopDir() {
  if (_desktopDirCache) return _desktopDirCache;
  try {
    const out = execFileSync(POWERSHELL, [
      "-NoProfile", "-NonInteractive", "-Command",
      "[Environment]::GetFolderPath('Desktop')",
    ], { encoding: "utf8", timeout: 5_000, windowsHide: true }).trim();
    _desktopDirCache = out || path.join(os.homedir(), "Desktop");
  } catch {
    _desktopDirCache = path.join(os.homedir(), "Desktop");
  }
  return _desktopDirCache;
}

// 仅供测试重置 Known Folder 缓存，生产代码不要调用。
export function _resetDesktopDirCacheForTest() {
  _desktopDirCache = null;
}

export function paths() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const dataRoot = process.env.DWS_STATE_ROOT || path.join(localAppData, "DoubaoWorkSkin");
  return {
    dataRoot: path.resolve(dataRoot),
    defaultSkinsDir: process.env.DWS_SKINS_DIR || "",
    desktopDir: process.env.DWS_DESKTOP_DIR || detectDesktopDir(),
  };
}

// ─── 应用定位 ───────────────────────────────────────────

const STORE_PACKAGE_NAMES = ["*Doubao*", "*春田*", "*DouBao*"];
const DESKTOP_CANDIDATE_PATHS = [
  // 实机核实的真实安装布局（2026-09，桌面版）：
  // %LOCALAPPDATA%\DoubaoWork\Application\app\DoubaoWork.exe
  // 必须放在最前：停止应用后进程反查失效，只能靠静态路径定位。
  path.join(process.env.LOCALAPPDATA || "", "DoubaoWork", "Application", "app", "DoubaoWork.exe"),
  path.join(process.env.LOCALAPPDATA || "", "Programs", "DoubaoWork", "DoubaoWork.exe"),
  path.join(process.env.LOCALAPPDATA || "", "Programs", "Doubao", "DoubaoWork.exe"),
  path.join(process.env.PROGRAMFILES || "", "DoubaoWork", "DoubaoWork.exe"),
  path.join(process.env["PROGRAMFILES(X86)"] || "", "DoubaoWork", "DoubaoWork.exe"),
];

/**
 * 从 WMI 进程行中选出豆包工作主进程行。
 *
 * 真实安装下所有子进程（gpu/renderer/utility/crashpad-handler）与主进程
 * 共用同一个 DoubaoWork.exe 路径，进程名完全相同；唯一稳定区别是主进程
 * 命令行不含 `--type=`。因此：
 * - 不能再用 `Select-Object -First 10` 截断（子进程多达十余个，主进程可能被截掉）；
 * - 不能只按 executablePath 匹配（子进程路径与主进程完全一致）；
 * - 必须按"无 --type="筛主进程。
 */
export function pickMainProcessRow(rows) {
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    const commandLine = String(row?.CommandLine ?? row?.command ?? "");
    if (!/[\\/]DoubaoWork\.exe$/i.test(String(row?.ExecutablePath ?? row?.executablePath ?? ""))) continue;
    // 命令行必须非空：空命令行通常是权限不足/信息缺失，不能冒充主进程。
    if (!commandLine) continue;
    if (/--type=/.test(commandLine)) continue;
    return row;
  }
  return null;
}

async function discoverFromRunningProcess() {
  try {
    // 不能 Select-Object -First 10：子进程（renderer/gpu/utility/crashpad）十余个，
    // 主进程可能排在 10 行之外。全部取回后由 pickMainProcessRow 按 --type= 筛选。
    const script = `
      Get-CimInstance Win32_Process | Where-Object {
        $_.Name -match 'Doubao|DoubaoWork' -and $_.ExecutablePath
      } | Select-Object ProcessId, Name, ExecutablePath, CommandLine | ConvertTo-Json -Compress
    `;
    const result = parsePowerShellJson(await runPowerShell(script));
    if (!result) return null;
    const main = pickMainProcessRow(result);
    if (!main) return null;
    // 根据路径判断安装类型：WindowsApps 目录下的是 Store 版
    const isStore = /[\\/]WindowsApps[\\/]/i.test(main.ExecutablePath);
  return {
      type: isStore ? "store" : "desktop",
      mainBinary: main.ExecutablePath,
      helperBinary: path.join(path.dirname(main.ExecutablePath), "DoubaoWork Browser.exe"),
      version: null,
    };
  } catch {
    return null;
  }
}

async function discoverFromStorePackage() {
  try {
    const nameFilter = STORE_PACKAGE_NAMES.map((n) => `$_.Name -like '${n}'`).join(" -or ");
    const script = `
      $pkg = Get-AppxPackage | Where-Object { ${nameFilter} } | Select-Object -First 1
      if (-not $pkg) { exit 0 }
      $manifest = Get-AppxPackageManifest -Package $pkg.PackageFullName
      $app = $manifest.Package.Applications.Application | Select-Object -First 1
      $exe = Join-Path $pkg.InstallLocation $app.Executable
      [PSCustomObject]@{
        PackageFamilyName = $pkg.PackageFamilyName
        ApplicationId = $app.Id
        Executable = $exe
        Version = $pkg.Version
        InstallLocation = $pkg.InstallLocation
      } | ConvertTo-Json -Compress
    `;
    const result = parsePowerShellJson(await runPowerShell(script));
    if (!result?.Executable) return null;
  return {
      type: "store",
      mainBinary: result.Executable,
      helperBinary: path.join(path.dirname(result.Executable), "DoubaoWork Browser.exe"),
      packageFamilyName: result.PackageFamilyName,
      applicationId: result.ApplicationId,
      appUserModelId: `${result.PackageFamilyName}!${result.ApplicationId}`,
      version: result.Version,
    };
  } catch {
    return null;
  }
}

async function discoverFromDesktopPaths() {
  for (const candidate of DESKTOP_CANDIDATE_PATHS) {
    try {
      await fs.access(candidate);
    return {
        type: "desktop",
        mainBinary: candidate,
        helperBinary: path.join(path.dirname(candidate), "DoubaoWork Browser.exe"),
        version: null,
      };
    } catch {
      // 继续下一个候选
    }
  }
  return null;
}

export async function discoverAppInstall({
  fromProcess = discoverFromRunningProcess,
  fromDesktop = discoverFromDesktopPaths,
  fromStore = discoverFromStorePackage,
} = {}) {
  // 桌面版命中后立即返回：Get-AppxPackage 在部分机器上需要十余秒，
  // 不应让普通桌面用户为无关的 Store 探测付费。
  const processInstall = await fromProcess();
  if (processInstall?.type === "desktop") return processInstall;
  const desktopInstall = await fromDesktop();
  if (desktopInstall) return desktopInstall;

  // 仅桌面版均未命中时探测 Store 包。
  const storeInstall = await fromStore();
  if (processInstall?.type === "store") return storeInstall || processInstall;
  return storeInstall || null;
}

// ─── 应用启动 ───────────────────────────────────────────

async function launchStoreApp(install, port) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    throw new Error(`无效端口: ${port}`);
  }
  // Store 应用：用 IApplicationActivationManager 激活
  // 参考 Codex Dream Skin 的实现
  // 注意：PowerShell here-string 的结束标记 "@ 必须在行首，不能缩进，否则 5.1 语法错误
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AppActivator {
    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IApplicationActivationManager {
        int ActivateApplication(string appUserModelId, string arguments, uint options, out uint processId);
        int ActivateForFile(string appUserModelId, IntPtr itemArray, string verb, out uint processId);
        int ActivateForProtocol(string appUserModelId, IntPtr itemArray, out uint processId);
    }
    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    public class ApplicationActivationManager { }
}
"@
$mgr = New-Object AppActivator+ApplicationActivationManager
$am = [AppActivator+IApplicationActivationManager]$mgr
$launchArgs = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=${numericPort}"
$procId = [uint32]0
$hr = $am.ActivateApplication('${String(install.appUserModelId).replaceAll("'", "''")}', $launchArgs, 0, [ref]$procId)
if ($hr -ne 0) { throw "ActivateApplication failed: 0x$('{0:X8}' -f $hr)" }
$procId
`;
  try {
    const output = await runPowerShell(script, { timeout: 15_000 });
    const pid = Number(output);
    if (pid > 0) return pid;
    throw new Error("Store 应用激活未返回 PID");
  } catch (error) {
    // 回退：直接启动 exe（可能因 ACL 限制失败）
    try {
      return await spawnApp(install.mainBinary, numericPort);
    } catch (fallbackError) {
      throw new Error(`Store 应用启动失败（COM 激活和直接启动均失败）：${error.message}；建议从官网下载桌面 EXE 版`, { cause: fallbackError });
    }
  }
}

export async function launchApp(install, port, { logFd, errorFd } = {}) {
  if (install.type === "store") {
    return launchStoreApp(install, port);
  }
  return spawnApp(install.mainBinary, port, { logFd, errorFd });
}

// ─── 端口与进程 ─────────────────────────────────────────

export function parseNetstatListeningPids(output, port) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) return [];
  const suffix = `:${numericPort}`;
  const pids = new Set();
  for (const line of String(output || "").split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[0].toUpperCase() !== "TCP") continue;
    const [localAddress, foreignAddress, state, pidText] = columns.slice(1);
    if (!localAddress.endsWith(suffix)) continue;
    // Windows 的状态文本可能本地化；监听套接字的远端端口固定为 0。
    if (state.toUpperCase() !== "LISTENING" && !foreignAddress.endsWith(":0")) continue;
    const pid = Number(pidText);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

export async function findListeningPids(port, { execFileImpl = execFileAsync } = {}) {
  try {
    // netstat 是系统原生命令，启动开销远低于每轮创建 PowerShell/.NET 会话。
    const { stdout } = await execFileImpl("netstat", ["-ano", "-p", "tcp"], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return parseNetstatListeningPids(stdout, port);
  } catch {
    return [];
  }
}

export async function getProcessExecutable(pid) {
  try {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").ExecutablePath`;
    const output = await runPowerShell(script);
    return output || null;
  } catch {
    return null;
  }
}

export async function inspectProcess(pid) {
  try {
    const script = `
      $p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"
      if (-not $p) { exit 0 }
      [PSCustomObject]@{ Command = $p.CommandLine; ExecutablePath = $p.ExecutablePath } | ConvertTo-Json -Compress
    `;
    const result = parsePowerShellJson(await runPowerShell(script));
    // Windows 上获取进程 cwd 需要 NtQueryInformationProcess，较复杂，返回 null
  return { command: result?.Command || "", cwd: null };
  } catch {
  return { command: "", cwd: null };
  }
}

export async function listProcessesByName(exeNames) {
  try {
    const nameFilter = exeNames.map((n) => `$_.Name -eq '${n.replace(/'/g, "''")}'`).join(" -or ");
    const script = `
      Get-CimInstance Win32_Process | Where-Object { ${nameFilter} } |
        Select-Object ProcessId, Name, CommandLine, ExecutablePath | ConvertTo-Json -Compress
    `;
    const result = parsePowerShellJson(await runPowerShell(script));
    if (!result) return [];
    const rows = Array.isArray(result) ? result : [result];
    return rows.map((r) => ({
      pid: Number(r.ProcessId),
      command: r.CommandLine || "",
      executablePath: r.ExecutablePath || null,
    }));
  } catch {
    return [];
  }
}

export async function isProcessAlive(pid, { killImpl = process.kill } = {}) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    // Node 在 Windows 上原生支持 signal 0，仅探测 PID 是否存在；
    // 避免退出等待期间每 100ms 启动一次 powershell.exe。
    killImpl(numericPid, 0);
    return true;
  } catch (error) {
    // 无权发送信号仍说明进程存在；ESRCH/其他错误视为已退出。
    return error?.code === "EPERM";
  }
}

export async function terminateProcess(pid, { force = false, killImpl = process.kill } = {}) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) throw new Error("无效 PID");
  // Only disposable, ownership-verified watch processes request immediate termination.
  if (force) { killImpl(Number(pid)); return; }
  await execFileAsync("taskkill", ["/PID", String(pid)], { windowsHide: true, timeout: 5_000 });
}

export async function killProcessTree(pid) {
  await execFileAsync("taskkill", ["/PID", String(pid), "/F", "/T"], { windowsHide: true, timeout: 5_000 }).catch(() => {});
}

// ─── Shell 与脚本生成 ───────────────────────────────────

export function shellQuote(value) {
  // cmd.exe 引号：用双引号包裹，内部双引号转义为 \"
  const s = String(value);
  if (/^[a-zA-Z0-9_./:-]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

export function generateCliEntry(dataRoot, nodePath, bridgePath) {
  // Windows .cmd wrapper，加 chcp 65001 确保中文路径正确解析
  // set "VAR=value" 是 cmd.exe 安全写法，可抵御路径中含 & | ^ 等特殊字符
  return `@echo off\r\nchcp 65001 >nul\r\nsetlocal\r\nset NODE_OPTIONS=\r\nset NODE_PATH=\r\nset "DWS_STATE_ROOT=${dataRoot}"\r\n"${nodePath}" "${bridgePath}" %*\r\n`;
}

export function launcherScripts(command, dataRoot) {
  const cmd = `call "${command}"`;
  const header = "@echo off\r\nchcp 65001 >nul\r\nsetlocal\r\nset NODE_OPTIONS=\r\nset NODE_PATH=\r\n";
  const root = dataRoot || paths().dataRoot;
  // 启动豆包工作.cmd：Agent/CI 与手动控制台入口。start 任意失败时至多重试一次 start --force。
  // 桌面 .lnk 不指向 cmd/PowerShell（都会在部分系统显示终端），而是由 WScript 无窗口托管。
  return {
    "启动豆包工作.cmd": `${header}${cmd} start\r\nif %errorlevel% neq 0 (\r\n  echo 首次启动未成功，自动重试一次...\r\n  ${cmd} start --force\r\n)\r\nexit /b %errorlevel%\r\n`,
    "启动豆包工作皮肤.ps1": silentLauncherScript(command, root),
    "launcher.vbs": silentLauncherHostScript(),
    "恢复官方外观.cmd": `${header}${cmd} disable\r\n`,
    "复制换肤提示词.cmd": `${header}for /f "delims=" %%i in ('${cmd} prompt') do set "PROMPT_TEXT=%%i"\r\necho %PROMPT_TEXT% | clip\r\necho 已复制，粘贴到豆包工作对话即可。\r\n`,
  };
}

// ─── 桌面快捷方式 ───────────────────────────────────────

export async function createDesktopShortcut(targetPath, linkName, desktopDirOverride = null, options = {}) {
  const desktopDir = desktopDirOverride || paths().desktopDir;
  const { iconPath = null, description = "", workingDir = null, legacyFolderPath = null, shortcutArguments = "", legacyCmdPath = null, legacyShortcuts = [] } = options;
  await fs.mkdir(desktopDir, { recursive: true });
  const linkPath = path.join(desktopDir, `${linkName}.lnk`);
  // 存在性检查：
  // - 同名 .lnk 指向本次目标 → 覆盖（幂等/升级）
  // - 同名 .lnk 是旧版指向"启动入口"文件夹（legacyFolderPath）→ 安全升级为直接入口
  // - 同名 .lnk 指向其他目标 → 不覆盖
  try {
    await fs.access(linkPath);
    const readScript = `
      $ws = New-Object -ComObject WScript.Shell
      $sc = $ws.CreateShortcut('${linkPath.replace(/'/g, "''")}')
      [PSCustomObject]@{ TargetPath = $sc.TargetPath; Arguments = $sc.Arguments } | ConvertTo-Json -Compress
    `;
    const existing = parsePowerShellJson(await runPowerShell(readScript, { timeout: 5_000 }));
    const existingTarget = String(existing?.TargetPath || "").trim();
    const existingArguments = String(existing?.Arguments || "").trim();
    if (!existingTarget) {
      throw new Error("桌面已有同名快捷方式但无法读取其目标，未覆盖");
    }
    const fileArgument = (args) => {
      const match = String(args || "").match(/(?:^|\s)-File\s+(?:"([^"]+)"|(\S+))/i);
      return match ? (match[1] || match[2]) : null;
    };
    const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    const existingFile = fileArgument(existingArguments);
    const requestedFile = fileArgument(shortcutArguments);
    const isCurrentShortcut = samePath(existingTarget, targetPath)
      && (requestedFile
        ? existingFile && samePath(existingFile, requestedFile)
        : existingArguments === String(shortcutArguments || "").trim());
    const isOurs = isCurrentShortcut
      || (legacyFolderPath && samePath(existingTarget, legacyFolderPath))
      || (legacyCmdPath && samePath(existingTarget, legacyCmdPath))
      || legacyShortcuts.some((candidate) => candidate?.target && candidate?.file
        && samePath(existingTarget, candidate.target)
        && existingFile && samePath(existingFile, candidate.file));
    if (!isOurs) {
      throw new Error("桌面已有同名快捷方式指向其他目标，未覆盖");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const script = `
    $ws = New-Object -ComObject WScript.Shell
    $shortcut = $ws.CreateShortcut('${linkPath.replace(/'/g, "''")}')
    $shortcut.TargetPath = '${targetPath.replace(/'/g, "''")}'
    if ('${(shortcutArguments || "").replace(/'/g, "''")}') { $shortcut.Arguments = '${(shortcutArguments || "").replace(/'/g, "''")}' }
    $shortcut.Description = '${(description || "").replace(/'/g, "''")}'
    if ('${(workingDir || "").replace(/'/g, "''")}') { $shortcut.WorkingDirectory = '${(workingDir || "").replace(/'/g, "''")}' }
    if ('${(iconPath || "").replace(/'/g, "''")}') { $shortcut.IconLocation = '${(iconPath || "").replace(/'/g, "''")},0' }
    $shortcut.Save()
  `;
  await runPowerShell(script, { timeout: 5_000 });
  return linkPath;
}

// ─── 权限 ───────────────────────────────────────────────

export async function ensurePrivateDir() {
  // Windows 权限模型不同，默认继承父目录 ACL，无需 chmod
}

export async function ensurePrivateFile() {
  // 同上
}
