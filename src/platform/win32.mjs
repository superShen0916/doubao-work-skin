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
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const POWERSHELL = "powershell.exe";
const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

async function runPowerShell(script, { timeout = 10_000 } = {}) {
  // 设置输出编码为 UTF-8，确保中文路径和输出正确解码
  const wrapped = `
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
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

export function paths() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const dataRoot = process.env.DWS_STATE_ROOT || path.join(localAppData, "DoubaoWorkSkin");
  return {
    dataRoot: path.resolve(dataRoot),
    defaultSkinsDir: process.env.DWS_SKINS_DIR || "",
    desktopDir: process.env.DWS_DESKTOP_DIR || path.join(os.homedir(), "Desktop"),
  };
}

// ─── 应用定位 ───────────────────────────────────────────

const STORE_PACKAGE_NAMES = ["*Doubao*", "*春田*", "*DouBao*"];
const DESKTOP_CANDIDATE_PATHS = [
  path.join(process.env.LOCALAPPDATA || "", "Programs", "DoubaoWork", "DoubaoWork.exe"),
  path.join(process.env.LOCALAPPDATA || "", "Programs", "Doubao", "DoubaoWork.exe"),
  path.join(process.env.PROGRAMFILES || "", "DoubaoWork", "DoubaoWork.exe"),
  path.join(process.env["PROGRAMFILES(X86)"] || "", "DoubaoWork", "DoubaoWork.exe"),
];

async function discoverFromRunningProcess() {
  try {
    const script = `
      Get-CimInstance Win32_Process | Where-Object {
        $_.Name -match 'Doubao|DoubaoWork' -and $_.ExecutablePath
      } | Select-Object -First 10 ProcessId, Name, ExecutablePath, CommandLine | ConvertTo-Json -Compress
    `;
    const result = parsePowerShellJson(await runPowerShell(script));
    if (!result) return null;
    const processes = Array.isArray(result) ? result : [result];
    // 只接受可执行文件名为 DoubaoWork.exe 的主进程，不匹配 Helper/Renderer
    // 不回退到 processes[0]，避免把普通 Doubao.exe 或其他同前缀程序当作豆包工作
    const main = processes.find((p) =>
      /[\\/]DoubaoWork\.exe$/i.test(p.ExecutablePath) &&
      !/helper|renderer|gpu-process|utility/i.test(p.CommandLine || "")
    );
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
  // Store 版：从进程反查时可能缺少 appUserModelId，用 Store 包探测补充
  if (fromProcess?.type === "store") {
    if (fromProcess.appUserModelId) return fromProcess;
    if (fromStore) return fromStore;
    return fromProcess;
  }
  if (fromStore) return fromStore;
  return null;
}

// ─── 应用启动 ───────────────────────────────────────────

async function launchStoreApp(install, port) {
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
$launchArgs = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}"
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
        `--remote-debugging-port=${port}`,
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
  return `@echo off\r\nchcp 65001 >nul\r\nsetlocal\r\nset NODE_OPTIONS=\r\nset NODE_PATH=\r\nset DWS_STATE_ROOT=${dataRoot}\r\n"${nodePath}" "${bridgePath}" %*\r\n`;
}

export function launcherScripts(command) {
  const cmd = `call "${command}"`;
  const header = "@echo off\r\nchcp 65001 >nul\r\nsetlocal\r\nset NODE_OPTIONS=\r\nset NODE_PATH=\r\n";
  return {
    "启动豆包工作.cmd": `${header}${cmd} start\r\nif %errorlevel% neq 2 exit /b %errorlevel%\r\necho.\r\necho 需要重启豆包工作。请保存工作，并等待 Agent 当前任务结束。\r\nset /p answer=确认已保存并重启？输入 y 后回车，其他输入取消：\r\nif /i not "%answer%"=="y" (\r\n  echo 已取消，豆包工作保持打开。\r\n  exit /b 2\r\n)\r\n${cmd} start --force\r\nexit /b %errorlevel%\r\n`,
    "恢复官方外观.cmd": `${header}${cmd} disable\r\n`,
    "复制换肤提示词.cmd": `${header}for /f "delims=" %%i in ('${cmd} prompt') do set "PROMPT_TEXT=%%i"\r\necho %PROMPT_TEXT% | clip\r\necho 已复制，粘贴到豆包工作对话即可。\r\n`,
  };
}

// ─── 桌面快捷方式 ───────────────────────────────────────

export async function createDesktopShortcut(targetPath, linkName, desktopDirOverride = null) {
  const desktopDir = desktopDirOverride || paths().desktopDir;
  await fs.mkdir(desktopDir, { recursive: true });
  const linkPath = path.join(desktopDir, `${linkName}.lnk`);
  // 存在性检查：已有同名 .lnk 且目标不同时不覆盖
  try {
    await fs.access(linkPath);
    // 用 WScript.Shell 读取已有快捷方式的目标
    const readScript = `
      $ws = New-Object -ComObject WScript.Shell
      $sc = $ws.CreateShortcut('${linkPath.replace(/'/g, "''")}')
      $sc.TargetPath
    `;
    const existingTarget = await runPowerShell(readScript, { timeout: 5_000 });
    if (existingTarget && path.resolve(existingTarget) !== path.resolve(targetPath)) {
      throw new Error("桌面已有同名快捷方式指向其他目标，未覆盖");
    }
  } catch (error) {
    if (error.code !== "ENOENT" && !error.message.includes("未覆盖")) throw error;
    if (error.message.includes("未覆盖")) throw error;
  }
  // 用 WScript.Shell COM 创建 .lnk
  const script = `
    $ws = New-Object -ComObject WScript.Shell
    $shortcut = $ws.CreateShortcut('${linkPath.replace(/'/g, "''")}')
    $shortcut.TargetPath = '${targetPath.replace(/'/g, "''")}'
    $shortcut.Save()
  `;
  await runPowerShell(script, { timeout: 5_000 });
}

// ─── 权限 ───────────────────────────────────────────────

export async function ensurePrivateDir() {
  // Windows 权限模型不同，默认继承父目录 ACL，无需 chmod
}

export async function ensurePrivateFile() {
  // 同上
}
