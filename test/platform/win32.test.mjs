/**
 * Windows 平台层纯函数单元测试
 *
 * 只测试不依赖 PowerShell/COM 的纯输出函数：
 * shellQuote、generateCliEntry、launcherScripts、paths。
 * 需要真实 Windows 环境的函数（discoverAppInstall、launchStoreApp、
 * Get-AppxPackage、IApplicationActivationManager、.lnk 创建等）
 * 需 Windows 实机验证，CI 仅执行 npm test 不覆盖这些路径。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

// 直接导入 win32 实现，绕过 platform/index.mjs 的 process.platform 选择
import * as win32 from "../../src/platform/win32.mjs";

test("isProcessAlive：使用 Node 原生 signal 0，EPERM 视为存活", async () => {
  const calls = [];
  assert.equal(await win32.isProcessAlive(123, { killImpl(pid, signal) { calls.push([pid, signal]); } }), true);
  assert.deepEqual(calls, [[123, 0]]);
  assert.equal(await win32.isProcessAlive(124, { killImpl() { const error = new Error("denied"); error.code = "EPERM"; throw error; } }), true);
  assert.equal(await win32.isProcessAlive(125, { killImpl() { const error = new Error("missing"); error.code = "ESRCH"; throw error; } }), false);
  assert.equal(await win32.isProcessAlive(0, { killImpl() { throw new Error("must not run"); } }), false);
});

test("shellQuote：纯 ASCII 标识符不加引号", () => {
  assert.equal(win32.shellQuote("node"), "node");
  assert.equal(win32.shellQuote("C:/node/node.exe"), "C:/node/node.exe");
  assert.equal(win32.shellQuote("skin.cmd"), "skin.cmd");
});

test("shellQuote：含空格路径加双引号", () => {
  assert.equal(win32.shellQuote("C:\\Program Files\\node\\node.exe"),
    '"C:\\Program Files\\node\\node.exe"');
});

test("shellQuote：内嵌双引号转义为 \\\"", () => {
  assert.equal(win32.shellQuote('say "hello"'), '"say \\"hello\\""');
});

test("shellQuote：含 & | ^ 等 cmd 特殊字符加引号", () => {
  assert.equal(win32.shellQuote("a&b"), '"a&b"');
  assert.equal(win32.shellQuote("a|b"), '"a|b"');
  assert.equal(win32.shellQuote("a^b"), '"a^b"');
});

test("generateCliEntry：生成合法 .cmd 入口，含 chcp 和安全 set", () => {
  const entry = win32.generateCliEntry(
    "C:\\Users\\Test User\\AppData\\Local\\DoubaoWorkSkin",
    "C:\\Users\\Test User\\AppData\\Local\\DoubaoWorkSkin\\engine\\runtime\\node.exe",
    "C:\\Users\\Test User\\AppData\\Local\\DoubaoWorkSkin\\engine\\scripts\\installed-cli.mjs",
  );
  // CRLF 行尾
  assert.ok(entry.includes("\r\n"), "应使用 CRLF 行尾");
  // chcp 65001
  assert.ok(entry.includes("chcp 65001"), "应设置 UTF-8 代码页");
  // 安全 set 写法（带引号）
  assert.ok(entry.includes('set "DWS_STATE_ROOT='), "set 应使用安全引号形式");
  // node 和 bridge 路径被双引号包裹
  assert.ok(entry.includes('"C:\\Users\\Test User\\AppData\\Local\\DoubaoWorkSkin\\engine\\runtime\\node.exe"'));
  assert.ok(entry.includes('"C:\\Users\\Test User\\AppData\\Local\\DoubaoWorkSkin\\engine\\scripts\\installed-cli.mjs"'));
  // %* 透传参数
  assert.ok(entry.includes("%*"), "应透传命令行参数");
  // 清理 NODE_OPTIONS / NODE_PATH
  assert.ok(entry.includes("set NODE_OPTIONS="));
  assert.ok(entry.includes("set NODE_PATH="));
});

test("launcherScripts：生成五个启动脚本（含 VBS+PS1 静默链），文件名和内容正确", () => {
  const command = "C:\\Users\\Test\\skin.cmd";
  const root = "C:\\Users\\Test\\DoubaoWorkSkin";
  const scripts = win32.launcherScripts(command, root);
  assert.deepEqual(Object.keys(scripts), ["启动豆包工作.cmd", "启动豆包工作皮肤.ps1", "launcher.vbs", "恢复官方外观.cmd", "复制换肤提示词.cmd"]);
  for (const [name, text] of Object.entries(scripts)) {
    if (!name.endsWith(".cmd")) continue;
    assert.ok(text.includes("chcp 65001"), `${text} 应含 chcp`);
    assert.ok(text.includes("setlocal"), `${text} 应含 setlocal`);
    assert.ok(text.includes(`call "${command}"`), `${text} 应调用 command`);
  }
  const ps1 = scripts["启动豆包工作皮肤.ps1"];
  assert.ok(ps1.includes("@('start', '--force')"));
  assert.ok(ps1.includes("launcher.log"));
  assert.ok(ps1.includes("System.Threading.Mutex"));
  assert.ok(ps1.includes("WaitOne(0)"));
  assert.ok(ps1.includes("engine\\runtime\\node.exe"));
  assert.ok(ps1.includes("engine\\scripts\\installed-cli.mjs"));
  assert.ok(ps1.includes("$ErrorActionPreference = 'Continue'"));
  const vbs = scripts["launcher.vbs"];
  assert.ok(vbs.includes("WScript.Arguments(0)"));
  assert.ok(vbs.includes("shell.Run command, 0, False"));
  assert.ok(scripts["启动豆包工作.cmd"].includes("start --force"));
  assert.ok(scripts["恢复官方外观.cmd"].includes("disable"));
  assert.ok(scripts["复制换肤提示词.cmd"].includes("prompt"));
  assert.ok(scripts["复制换肤提示词.cmd"].includes("clip"));
});

test("silentLauncherScript：生成内置 Node 直连逻辑，具体退出码行为由专项测试覆盖", () => {
  const root = "C:\\Users\\tester\\AppData\\Local\\DoubaoWorkSkin";
  const ps1 = win32.silentLauncherScript("C:\\ignored\\skin.cmd", root);
  assert.ok(ps1.includes("engine\\runtime\\node.exe"));
  assert.ok(ps1.includes("engine\\scripts\\installed-cli.mjs"));
  assert.ok(ps1.includes("@('start', '--force')"));
  assert.ok(ps1.includes("$ErrorActionPreference = 'Continue'"));
  assert.doesNotMatch(ps1, /skin\.cmd/);
});

test("paths：返回 dataRoot、defaultSkinsDir、desktopDir", () => {
  const p = win32.paths();
  assert.ok(p.dataRoot);
  assert.equal(typeof p.defaultSkinsDir, "string");
  assert.ok(p.desktopDir);
  // dataRoot 应是绝对路径
  assert.ok(path.isAbsolute(p.dataRoot), "dataRoot 应为绝对路径");
});

test("paths：DWS_STATE_ROOT 环境变量覆盖 dataRoot", () => {
  const original = process.env.DWS_STATE_ROOT;
  try {
    process.env.DWS_STATE_ROOT = "D:\\custom\\root";
    const p = win32.paths();
    assert.equal(p.dataRoot, path.resolve("D:\\custom\\root"));
  } finally {
    if (original === undefined) delete process.env.DWS_STATE_ROOT;
    else process.env.DWS_STATE_ROOT = original;
  }
});

const APP = "C:\\Users\\Test User\\AppData\\Local\\DoubaoWork\\Application\\app\\DoubaoWork.exe";

const DESKTOP_INSTALL = {
  type: "desktop",
  mainBinary: APP,
  helperBinary: path.join(path.dirname(APP), "DoubaoWork Browser.exe"),
  version: null,
};

test("discoverAppInstall：运行中桌面版命中后跳过路径和 Store 探测", async () => {
  let desktopCalls = 0;
  let storeCalls = 0;
  const actual = await win32.discoverAppInstall({
    fromProcess: async () => DESKTOP_INSTALL,
    fromDesktop: async () => { desktopCalls++; return null; },
    fromStore: async () => { storeCalls++; return null; },
  });
  assert.equal(actual, DESKTOP_INSTALL);
  assert.equal(desktopCalls, 0);
  assert.equal(storeCalls, 0);
});

test("discoverAppInstall：静态桌面路径命中后跳过 Store 探测", async () => {
  let storeCalls = 0;
  const actual = await win32.discoverAppInstall({
    fromProcess: async () => null,
    fromDesktop: async () => DESKTOP_INSTALL,
    fromStore: async () => { storeCalls++; return null; },
  });
  assert.equal(actual, DESKTOP_INSTALL);
  assert.equal(storeCalls, 0);
});

test("discoverAppInstall：仅桌面版均未命中时探测 Store", async () => {
  let storeCalls = 0;
  const storeInstall = { type: "store", mainBinary: "C:\\Program Files\\WindowsApps\\DoubaoWork.exe" };
  const actual = await win32.discoverAppInstall({
    fromProcess: async () => null,
    fromDesktop: async () => null,
    fromStore: async () => { storeCalls++; return storeInstall; },
  });
  assert.equal(actual, storeInstall);
  assert.equal(storeCalls, 1);
});

test("pickMainProcessRow：子进程与主进程同路径时选中无 --type= 的主进程", () => {
  const rows = [
    { ProcessId: 101, ExecutablePath: APP, CommandLine: `"${APP}" --type=renderer --im-sdk-enabled` },
    { ProcessId: 102, ExecutablePath: APP, CommandLine: `"${APP}" --type=gpu-process` },
    { ProcessId: 103, ExecutablePath: APP, CommandLine: `${APP} --type=crashpad-handler` },
    { ProcessId: 104, ExecutablePath: APP, CommandLine: `${APP} --type=utility --utility-sub-type=network.mojom.NetworkService` },
    { ProcessId: 105, ExecutablePath: APP, CommandLine: `"${APP}" --start_time=1789883576256` },
  ];
  const main = win32.pickMainProcessRow(rows);
  assert.ok(main, "应选出主进程");
  assert.equal(main.ProcessId, 105);
});

test("pickMainProcessRow：全是子进程时返回 null，不冒充主进程", () => {
  const rows = [
    { ProcessId: 101, ExecutablePath: APP, CommandLine: `"${APP}" --type=renderer` },
    { ProcessId: 102, ExecutablePath: APP, CommandLine: `${APP} --type=crashpad-handler` },
  ];
  assert.equal(win32.pickMainProcessRow(rows), null);
  assert.equal(win32.pickMainProcessRow(null), null);
  assert.equal(win32.pickMainProcessRow([]), null);
});

test("pickMainProcessRow：只认 DoubaoWork.exe 路径，不误选 DoubaoLinkRouter 等同名子目录程序", () => {
  const rows = [
    { ProcessId: 201, ExecutablePath: "C:\\x\\app\\DoubaoLinkRouter.exe", CommandLine: `"C:\\x\\app\\DoubaoLinkRouter.exe"` },
    { ProcessId: 202, ExecutablePath: "C:\\x\\Doubao.exe", CommandLine: `"C:\\x\\Doubao.exe"` },
  ];
  assert.equal(win32.pickMainProcessRow(rows), null);
});

test("pickMainProcessRow：Store 版主进程（无 --type=，路径在 WindowsApps）同样可识别", () => {
  const storeApp = "C:\\Program Files\\WindowsApps\\pkg\\DoubaoWork.exe";
  const rows = [
    { ProcessId: 301, ExecutablePath: storeApp, CommandLine: `"${storeApp}" --type=renderer` },
    { ProcessId: 302, ExecutablePath: storeApp, CommandLine: `"${storeApp}" --start_time=1` },
  ];
  assert.equal(win32.pickMainProcessRow(rows).ProcessId, 302);
});

test("pickMainProcessRow：命令行空/缺失时返回 null，不误判为主进程", () => {
  const rows = [
    { ProcessId: 401, ExecutablePath: APP, CommandLine: "" },
    { ProcessId: 402, ExecutablePath: APP },
    { ProcessId: 403, ExecutablePath: APP, CommandLine: null },
  ];
  assert.equal(win32.pickMainProcessRow(rows), null);
});


test("createDesktopShortcut：生成指向启动cmd的.lnk，含 WorkingDirectory/Description/IconLocation", async () => {
  if (process.platform !== "win32") return;
  const desktop = fs.mkdtempSync(path.join(os.tmpdir(), "dws-desk-"));
  try {
    const launcher = path.join(desktop, "启动豆包工作.cmd");
    fs.writeFileSync(launcher, "@echo off\r\n");
    const icon = path.join(desktop, "AppIcon.ico");
    fs.writeFileSync(icon, "x");
    const link = await win32.createDesktopShortcut(launcher, "豆包工作皮肤", desktop, {
      iconPath: icon, description: "启动带皮肤的豆包工作", workingDir: desktop, legacyFolderPath: desktop,
      shortcutArguments: "-WindowStyle Hidden -NoProfile -File C:\\test\\启动豆包工作皮肤.ps1",
    });
    const read = (prop) => execFileSync("powershell.exe",
      ["-NoProfile","-Command",`(New-Object -ComObject WScript.Shell).CreateShortcut('${link}').${prop}`],
      { encoding: "utf8" }).trim();
    assert.equal(read("TargetPath"), launcher);
    assert.equal(read("WorkingDirectory"), desktop);
    assert.equal(read("Description"), "启动带皮肤的豆包工作");
    assert.match(read("IconLocation"), /AppIcon\.ico,?0?$/);
    assert.match(read("Arguments"), /-WindowStyle Hidden/);
  } finally { fs.rmSync(desktop, { recursive: true, force: true }); }
});

test("createDesktopShortcut：PowerShell 目标还需匹配 -File 参数才视为本项目入口", async () => {
  if (process.platform !== "win32") return;
  const desktop = fs.mkdtempSync(path.join(os.tmpdir(), "dws-desk-args-"));
  try {
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const ours = path.join(desktop, "启动入口", "启动豆包工作皮肤.ps1");
    fs.mkdirSync(path.dirname(ours), { recursive: true });
    fs.writeFileSync(ours, "# ours\r\n");
    const ourArgs = `-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "${ours}"`;
    await win32.createDesktopShortcut(powershell, "豆包工作皮肤", desktop, { shortcutArguments: ourArgs });
    await win32.createDesktopShortcut(powershell, "豆包工作皮肤", desktop, { shortcutArguments: ourArgs });
    const other = path.join(desktop, "other.ps1");
    await assert.rejects(
      win32.createDesktopShortcut(powershell, "豆包工作皮肤", desktop, {
        shortcutArguments: `-WindowStyle Hidden -File "${other}"`,
      }),
      /其他目标/
    );
  } finally { fs.rmSync(desktop, { recursive: true, force: true }); }
});

test("createDesktopShortcut：旧版指向文件夹的.lnk 可升级，指向其他目标不覆盖", async () => {
  if (process.platform !== "win32") return;
  const desktop = fs.mkdtempSync(path.join(os.tmpdir(), "dws-desk2-"));
  try {
    const folder = path.join(desktop, "启动入口");
    fs.mkdirSync(folder, { recursive: true });
    const launcher = path.join(folder, "启动豆包工作.cmd");
    fs.writeFileSync(launcher, "@echo off\r\n");
    const link = path.join(desktop, "豆包工作皮肤.lnk");
    // 先建一个指向文件夹的旧版 .lnk
    execFileSync("powershell.exe", ["-NoProfile","-Command",
      `$ws=New-Object -ComObject WScript.Shell;$s=$ws.CreateShortcut('${link}');$s.TargetPath='${folder}';$s.Save()`]);
    // 升级为直接指向 cmd（legacyFolderPath=folder）
    await win32.createDesktopShortcut(launcher, "豆包工作皮肤", desktop, { workingDir: folder, legacyFolderPath: folder });
    const target = execFileSync("powershell.exe", ["-NoProfile","-Command",
      `(New-Object -ComObject WScript.Shell).CreateShortcut('${link}').TargetPath`], { encoding: "utf8" }).trim();
    assert.equal(target, launcher);
    // 不同目标不覆盖
    await assert.rejects(
      win32.createDesktopShortcut("C:\\Windows\\notepad.exe", "豆包工作皮肤", desktop),
      /其他目标/
    );
  } finally { fs.rmSync(desktop, { recursive: true, force: true }); }
});

// ─── H3：桌面目录走 Known Folder ─────────────────────────

test("paths：DWS_DESKTOP_DIR 覆盖 desktopDir（测试可旁路 Known Folder 检测）", () => {
  const original = process.env.DWS_DESKTOP_DIR;
  try {
    process.env.DWS_DESKTOP_DIR = path.join(os.tmpdir(), "dws-desktop-override");
    const p = win32.paths();
    assert.equal(p.desktopDir, path.join(os.tmpdir(), "dws-desktop-override"));
  } finally {
    if (original === undefined) delete process.env.DWS_DESKTOP_DIR;
    else process.env.DWS_DESKTOP_DIR = original;
  }
});

test("paths：无 DWS_DESKTOP_DIR 时 desktopDir 走 Known Folder 且结果缓存", () => {
  if (process.platform !== "win32") return;
  const original = process.env.DWS_DESKTOP_DIR;
  delete process.env.DWS_DESKTOP_DIR;
  win32._resetDesktopDirCacheForTest();
  try {
    const expected = execFileSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath('Desktop')"],
      { encoding: "utf8" }).trim();
    assert.ok(expected, "Known Folder 应返回非空桌面路径");
    const p1 = win32.paths();
    assert.equal(p1.desktopDir, expected);
    // 第二次调用命中模块级缓存，结果一致（不重复 spawn powershell）
    const p2 = win32.paths();
    assert.equal(p2.desktopDir, expected);
  } finally {
    if (original === undefined) delete process.env.DWS_DESKTOP_DIR;
    else process.env.DWS_DESKTOP_DIR = original;
    win32._resetDesktopDirCacheForTest();
  }
});

// ─── M11：ps1 日志/锁路径按 dataRoot 插值 ────────────────

test("silentLauncherScript：dataRoot 插值进日志路径、内置 Node 路径与 mutex 名", () => {
  const root = "C:\\Users\\tester\\AppData\\Local\\DoubaoWorkSkin";
  const ps1 = win32.silentLauncherScript("C:\\ignored\\skin.cmd", root);
  assert.ok(ps1.includes("$dataRoot = 'C:\\Users\\tester\\AppData\\Local\\DoubaoWorkSkin'"));
  assert.ok(ps1.includes("Join-Path $dataRoot 'launcher.log'"));
  assert.ok(ps1.includes("Join-Path $dataRoot 'engine\\runtime\\node.exe'"));
  assert.ok(ps1.includes("Local\\DoubaoWorkSkin.Launcher.C__Users_tester_AppData_Local_DoubaoWorkSkin"));
});

test("launcherScripts：传入 dataRoot 时生成 VBS+PS1 链和自动 force 的控制台入口", () => {
  const root = "D:\\custom\\DoubaoWorkSkin";
  const scripts = win32.launcherScripts("C:\\x\\skin.cmd", root);
  const ps1 = scripts["启动豆包工作皮肤.ps1"];
  assert.ok(ps1.includes("$dataRoot = 'D:\\custom\\DoubaoWorkSkin'"));
  assert.ok(scripts["launcher.vbs"].includes("WScript.Arguments(0)"));
  const cmd = scripts["启动豆包工作.cmd"];
  assert.ok(!cmd.includes("choice /c YN"));
  assert.ok(cmd.includes("start --force"));
});

test("launcherScripts：不传 dataRoot 时使用平台 dataRoot，不依赖启动入口内的 skin.cmd", () => {
  if (process.platform !== "win32") return;
  const command = "C:\\Users\\tester\\AppData\\Local\\DoubaoWorkSkin\\skin.cmd";
  const scripts = win32.launcherScripts(command);
  const ps1 = scripts["启动豆包工作皮肤.ps1"];
  assert.ok(ps1.includes("engine\\runtime\\node.exe"));
  assert.ok(ps1.includes("engine\\scripts\\installed-cli.mjs"));
  assert.doesNotMatch(ps1, /启动入口\\skin\.cmd/);
  assert.ok(scripts["启动豆包工作.cmd"].includes(command));
});
