/**
 * Windows 平台实现
 *
 * 设计决策（参考 Codex Dream Skin 等同类项目）：
 * - 应用定位三级策略：进程反查 → Store 包探测 → 桌面路径遍历
 * - 启动双轨制：桌面版直接 spawn；Store 版用 IApplicationActivationManager
 * - 启动后必须验证 CDP 端口（Store 应用可能吃掉调试参数）
 * - 端口/进程管理用 Get-NetTCPConnection + Get-CimInstance（结构化，替代 netstat/tasklist/wmic）
 * - 数据目录用 %LOCALAPPDATA%（不漫游，因 engine 含 Node 二进制）
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";

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

export async function discoverAppInstall() {
  // 三级策略：进程反查（最准）→ Store 包 → 桌面路径
  // 多版本共存时桌面版优先
  const fromProcess = await discoverFromRunningProcess();
  const fromStore = await discoverFromStorePackage();
  const fromDesktop = await discoverFromDesktopPaths();

  // 桌面版优先（CDP 参数支持最可靠）
  if (fromProcess?.type === "desktop") return fromProcess;
  if (fromDesktop) return fromDesktop;
  // Store 版：从进程反查时缺少 appUserModelId，用 Store 包探测补充
  if (fromProcess?.type === "store") {
    if (fromStore) return fromStore;
    return fromProcess;
  }
  if (fromStore) return fromStore;
  return null;
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
$hr = $am.ActivateApplication("${install.appUserModelId}", $launchArgs, 0, [ref]$procId)
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
      const child = spawn(install.mainBinary, [
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${numericPort}`,
      ], { detached: true, stdio: "ignore", windowsHide: true });
      if (child.pid) {
        child.unref();
        return child.pid;
      }
      throw new Error("直接启动 Store exe 未返回 PID");
    } catch (fallbackError) {
      throw new Error(`Store 应用启动失败（COM 激活和直接启动均失败）：${error.message}；建议从官网下载桌面 EXE 版`, { cause: fallbackError });
    }
  }
}

export async function launchApp(install, port, { logFd, errorFd } = {}) {
  if (install.type === "store") {
    return launchStoreApp(install, port);
  }
  // 桌面版：直接 spawn
  const child = spawn(install.mainBinary, [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
  ], {
    detached: true,
    stdio: ["ignore", logFd || "ignore", errorFd || "ignore"],
    env: process.env,
    windowsHide: true,
  });
  if (!child?.pid) throw new Error("豆包工作进程未返回 PID");
  child.unref?.();
  return child.pid;
}

// ─── 端口与进程 ─────────────────────────────────────────

export async function findListeningPids(port) {
  try {
    const script = `
      $conns = Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue
      if (-not $conns) { exit 0 }
      $conns | Select-Object -ExpandProperty OwningProcess -Unique
    `;
    const output = await runPowerShell(script);
    return output.split("\n").map((line) => Number(line.trim())).filter((n) => n > 0);
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
      command: r.CommandLine || r.ExecutablePath || "",
      executablePath: r.ExecutablePath || null,
    }));
  } catch {
    return [];
  }
}

export async function isProcessAlive(pid) {
  try {
    const script = `if (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue) { 'true' } else { 'false' }`;
    return (await runPowerShell(script)) === "true";
  } catch {
    return false;
  }
}

export async function terminateProcess(pid) {
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

export function silentLauncherScript(command, dataRoot) {
  const root = String(dataRoot).replace(/'/g, "''");
  const mutexBase = `DoubaoWorkSkin.Launcher.${String(dataRoot).replace(/[^a-zA-Z0-9]/g, "_")}`;
  return `# 豆包工作皮肤无窗口启动逻辑；由 WScript 托管。\r\n$ErrorActionPreference = 'Stop'\r\n[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\r\n$OutputEncoding = [Console]::OutputEncoding\r\n$dataRoot = '${root}'\r\n$node = Join-Path $dataRoot 'engine\\runtime\\node.exe'\r\n$bridge = Join-Path $dataRoot 'engine\\scripts\\installed-cli.mjs'\r\n$log = if ($env:DWS_LAUNCHER_LOG) { $env:DWS_LAUNCHER_LOG } else { Join-Path $dataRoot 'launcher.log' }\r\n$mutexName = if ($env:DWS_LAUNCHER_MUTEX) { $env:DWS_LAUNCHER_MUTEX } else { 'Local\\${mutexBase}' }\r\n$env:DWS_STATE_ROOT = $dataRoot\r\nfunction Write-Log($msg) {\r\n  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'\r\n  Add-Content -LiteralPath $log -Value ($ts + ' ' + $msg) -Encoding UTF8\r\n}\r\nfunction Invoke-Skin([string[]]$SkinArgs) {\r\n  $oldPreference = $ErrorActionPreference\r\n  $ErrorActionPreference = 'Continue'\r\n  try {\r\n    & $node $bridge @SkinArgs 2>&1 | ForEach-Object { Write-Log ([string]$_) }\r\n    return $LASTEXITCODE\r\n  } finally { $ErrorActionPreference = $oldPreference }\r\n}\r\n$mutex = New-Object System.Threading.Mutex($false, $mutexName)\r\n$acquired = $false\r\ntry {\r\n  try { $acquired = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }\r\n  if (-not $acquired) { Write-Log '已有启动器在运行，静默退出'; exit 0 }\r\n  Write-Log 'start'\r\n  $code = Invoke-Skin @('start')\r\n  Write-Log (\"start exit=\" + $code)\r\n  if ($code -eq 2) {\r\n    Write-Log '需要重启，自动 start --force'\r\n    $code = Invoke-Skin @('start', '--force')\r\n    Write-Log (\"force exit=\" + $code)\r\n  }\r\n  if ($code -ne 0) {\r\n    Write-Log (\"失败 code=\" + $code)\r\n    if (-not $env:DWS_LAUNCHER_NO_UI) {\r\n      Add-Type -AssemblyName System.Windows.Forms\r\n      $msg = '豆包工作皮肤启动失败（错误码 ' + $code + '）。' + [Environment]::NewLine + '日志：' + $log\r\n      [System.Windows.Forms.MessageBox]::Show($msg, '豆包工作皮肤', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null\r\n    }\r\n  }\r\n  exit $code\r\n} catch {\r\n  Write-Log (\"启动器异常：\" + $_.Exception.Message)\r\n  if (-not $env:DWS_LAUNCHER_NO_UI) {\r\n    Add-Type -AssemblyName System.Windows.Forms\r\n    [System.Windows.Forms.MessageBox]::Show(('豆包工作皮肤启动失败。' + [Environment]::NewLine + '日志：' + $log), '豆包工作皮肤', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null\r\n  }\r\n  exit 1\r\n} finally {\r\n  if ($acquired) { try { $mutex.ReleaseMutex() } catch {} }\r\n  $mutex.Dispose()\r\n}\r\n`;
}

export function silentLauncherHostScript() {
  return `Option Explicit\r\nDim shell, ps1, powershell, command\r\nIf WScript.Arguments.Count <> 1 Then WScript.Quit 64\r\nSet shell = CreateObject(\"WScript.Shell\")\r\nps1 = WScript.Arguments(0)\r\npowershell = shell.ExpandEnvironmentStrings(\"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\")\r\ncommand = Chr(34) & powershell & Chr(34) & \" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \" & Chr(34) & ps1 & Chr(34)\r\nshell.Run command, 0, False\r\n`;
}
export function launcherScripts(command, dataRoot) {
  const cmd = `call "${command}"`;
  const header = "@echo off\r\nchcp 65001 >nul\r\nsetlocal\r\nset NODE_OPTIONS=\r\nset NODE_PATH=\r\n";
  const root = dataRoot || paths().dataRoot;
  // 启动豆包工作.cmd：Agent/CI 与手动控制台入口。start 返回 2 时自动 start --force 一次。
  // 桌面 .lnk 不指向 cmd/PowerShell（都会在部分系统显示终端），而是由 WScript 无窗口托管。
  return {
    "启动豆包工作.cmd": `${header}${cmd} start\r\nif %errorlevel% equ 2 (\r\n  echo 需要重启才能换肤，自动重启中...\r\n  ${cmd} start --force\r\n)\r\nexit /b %errorlevel%\r\n`,
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
