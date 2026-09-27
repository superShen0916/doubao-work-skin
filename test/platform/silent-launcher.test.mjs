import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import * as win32 from "../../src/platform/win32.mjs";
import { installTargets } from "../../scripts/install.mjs";

const SYSTEM_ROOT = process.env.SystemRoot || "C:\\Windows";
const PS = path.join(SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const WSCRIPT = path.join(SYSTEM_ROOT, "System32", "wscript.exe");

function makeFixture(exitCode) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dws-launcher-"));
  const entryDir = path.join(dataRoot, "启动入口");
  const runtimeDir = path.join(dataRoot, "engine", "runtime");
  const scriptsDir = path.join(dataRoot, "engine", "scripts");
  const calls = path.join(dataRoot, "calls.txt");
  fs.mkdirSync(entryDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(runtimeDir, "node.exe"));
  fs.writeFileSync(path.join(scriptsDir, "installed-cli.mjs"), `
import fs from "node:fs";
fs.appendFileSync(process.env.DWS_TEST_CALLS, process.argv.slice(2).join(" ") + "\\n", "utf8");
console.error("中文错误流不是 PowerShell 异常");
const code = Number(process.env.DWS_TEST_EXIT || 0);
if (code === 0) fs.writeFileSync(new URL("../../state.json", import.meta.url), JSON.stringify({ doubaoWorkPid: process.pid }), "utf8");
process.exit(code);
`, "utf8");
  const scripts = win32.launcherScripts(path.join(dataRoot, "skin.cmd"), dataRoot);
  const ps1Path = path.join(entryDir, "启动豆包工作皮肤.ps1");
  const vbsPath = path.join(entryDir, "launcher.vbs");
  fs.writeFileSync(ps1Path, "\uFEFF" + scripts["启动豆包工作皮肤.ps1"], "utf8");
  fs.writeFileSync(vbsPath, scripts["launcher.vbs"], "utf8");
  return { dataRoot, entryDir, calls, ps1Path, vbsPath, exitCode };
}

function fixtureEnv(fixture, extraEnv = {}) {
  return {
    ...process.env,
    DWS_TEST_CALLS: fixture.calls,
    DWS_TEST_EXIT: String(fixture.exitCode),
    DWS_LAUNCHER_LOG: path.join(fixture.dataRoot, "launcher.log"),
    DWS_LAUNCHER_MUTEX: `Local\\DwsSilentLauncher.${process.pid}.${path.basename(fixture.dataRoot)}`,
    DWS_LAUNCHER_NO_UI: "1",
    ...extraEnv,
  };
}

function runPs1(fixture, extraEnv = {}) {
  try {
    execFileSync(PS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture.ps1Path], {
      env: fixtureEnv(fixture, extraEnv), timeout: 15_000,
    });
    return 0;
  } catch (error) {
    return error.status ?? 1;
  }
}

function readCalls(fixture) {
  return fs.readFileSync(fixture.calls, "utf8").replace(/\r/g, "").trim().split("\n").map((s) => s.trim());
}

function waitForFile(file, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(`等待文件超时: ${file}`);
}

function waitForText(file, pattern, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(file) && pattern.test(fs.readFileSync(file, "utf8"))) return;
    } catch (error) {
      // wscript can return just as Add-Content flushes/releases the log.
      if (!["EBUSY", "EPERM", "ENOENT"].includes(error.code)) throw error;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(`等待日志超时: ${file}`);
}

function removeFixture(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

test("桌面 ps1：只执行一次 start --force，并尝试激活窗口", { skip: process.platform !== "win32" }, () => {
  const fx = makeFixture(0);
  try {
    assert.equal(runPs1(fx), 0);
    assert.deepEqual(readCalls(fx), ["start --force"]);
    const log = fs.readFileSync(path.join(fx.dataRoot, "launcher.log"), "utf8");
    assert.match(log, /中文错误流不是 PowerShell 异常/);
    assert.match(log, /force exit=0/);
    assert.match(log, /已恢复并置前豆包工作 PID|状态 PID 不再属于豆包工作|窗口恢复失败|窗口置前未确认/);
    assert.doesNotMatch(log, /启动器异常/);
  } finally { fs.rmSync(fx.dataRoot, { recursive: true, force: true }); }
});

test("桌面 ps1：force 返回 2 时不重复执行", { skip: process.platform !== "win32" }, () => {
  const fx = makeFixture(2);
  try {
    assert.equal(runPs1(fx), 2);
    assert.deepEqual(readCalls(fx), ["start --force"]);
    const log = fs.readFileSync(path.join(fx.dataRoot, "launcher.log"), "utf8");
    assert.match(log, /force exit=2/);
    assert.doesNotMatch(log, /启动器异常/);
  } finally { fs.rmSync(fx.dataRoot, { recursive: true, force: true }); }
});

test("桌面 ps1：其他失败码只执行一次 force 并记录失败", { skip: process.platform !== "win32" }, () => {
  const fx = makeFixture(7);
  try {
    assert.equal(runPs1(fx), 7);
    assert.deepEqual(readCalls(fx), ["start --force"]);
    const log = fs.readFileSync(path.join(fx.dataRoot, "launcher.log"), "utf8");
    assert.match(log, /失败 code=7/);
  } finally { fs.rmSync(fx.dataRoot, { recursive: true, force: true }); }
});

test("VBS 正式入口由 wscript 托管并启动同目录 PS1", { skip: process.platform !== "win32" }, () => {
  const fx = makeFixture(0);
  try {
    const vbs = fs.readFileSync(fx.vbsPath, "utf8");
    assert.match(vbs, /shell\.Run command, 0, False/);
    assert.match(vbs, /WScript\.Arguments\(0\)/);
    execFileSync(WSCRIPT, [fx.vbsPath, fx.ps1Path], { env: fixtureEnv(fx), timeout: 5_000, windowsHide: true });
    waitForFile(fx.calls);
    assert.deepEqual(readCalls(fx), ["start --force"]);
    const logPath = path.join(fx.dataRoot, "launcher.log");
    waitForText(logPath, /launcher completed/);
    const log = fs.readFileSync(logPath, "utf8");
    assert.match(log, /force exit=0/);
    assert.doesNotMatch(log, /启动器异常/);
  } finally { removeFixture(fx.dataRoot); }
});

test("命名互斥锁防止桌面入口重复执行", { skip: process.platform !== "win32" }, async () => {
  const fx = makeFixture(0);
  const mutex = `Local\\DwsSilentLauncher.Concurrent.${process.pid}`;
  const ready = path.join(fx.dataRoot, "mutex-ready");
  const holderScript = `$m=New-Object System.Threading.Mutex($false,'${mutex}');$null=$m.WaitOne();[IO.File]::WriteAllText('${ready}','ready');Start-Sleep -Seconds 30;$m.ReleaseMutex();$m.Dispose()`;
  const holder = spawn(PS, ["-NoProfile", "-NonInteractive", "-Command", holderScript], { stdio: "ignore", windowsHide: true });
  try {
    waitForFile(ready);
    assert.equal(runPs1(fx, { DWS_LAUNCHER_MUTEX: mutex }), 0);
    assert.equal(fs.existsSync(fx.calls), false);
    const log = fs.readFileSync(path.join(fx.dataRoot, "launcher.log"), "utf8");
    assert.match(log, /已有启动器在运行/);
  } finally {
    holder.kill();
    fs.rmSync(fx.dataRoot, { recursive: true, force: true });
  }
});

test("桌面 ps1：清理继承的 Node 注入选项，不加载外部代码", { skip: process.platform !== "win32" }, () => {
  const fx = makeFixture(0);
  try {
    assert.equal(runPs1(fx, { NODE_OPTIONS: '--require "C:\\does-not-exist\\hook.cjs"', NODE_PATH: 'C:\\untrusted' }), 0);
    assert.deepEqual(readCalls(fx), ["start --force"]);
  } finally { removeFixture(fx.dataRoot); }
});

test("桌面 ps1：缺少 Node 时明确失败，不假报成功", { skip: process.platform !== "win32" }, () => {
  const fx = makeFixture(0);
  try {
    fs.unlinkSync(path.join(fx.dataRoot, 'engine', 'runtime', 'node.exe'));
    assert.equal(runPs1(fx), 1);
    assert.equal(fs.existsSync(fx.calls), false);
    assert.match(fs.readFileSync(path.join(fx.dataRoot, 'launcher.log'), 'utf8'), /专用 Node.js 不存在/);
  } finally { removeFixture(fx.dataRoot); }
});

function instrumentFixture(fx) {
  const script = fs.readFileSync(fx.ps1Path, 'utf8');
  const activation = path.join(fx.dataRoot, 'activation-called');
  const failure = path.join(fx.dataRoot, 'failure-called');
  const quote = value => value.replaceAll("'", "''");
  fs.writeFileSync(fx.ps1Path, script.replace('$mutex = $null', `
function Activate-DoubaoWork { [IO.File]::WriteAllText('${quote(activation)}', 'called') }
function Show-Failure([string]$Message) { [IO.File]::WriteAllText('${quote(failure)}', $Message) }
$mutex = $null`), 'utf8');
  return { activation, failure };
}

function holdLog(fx, share) {
  const ready = path.join(fx.dataRoot, 'lock-ready');
  const release = path.join(fx.dataRoot, 'lock-release');
  const script = `
$ErrorActionPreference='Stop'
$f=[IO.File]::Open('${path.join(fx.dataRoot,'launcher.log')}',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::${share})
try {
  [IO.File]::WriteAllText('${ready}', 'ready')
  $deadline=[DateTime]::UtcNow.AddSeconds(25)
  while (-not [IO.File]::Exists('${release}') -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 20 }
} finally { $f.Dispose() }
`;
  const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script,'utf16le').toString('base64')], { stdio:'ignore', windowsHide:true });
  waitForFile(ready);
  return async () => {
    const exited = new Promise(resolve => child.once('exit', resolve));
    fs.writeFileSync(release, 'release');
    await exited;
  };
}

for (const code of [0, 7]) {
  test(`日志独占锁耗尽重试仍保留真实退出码 ${code}`, { skip: process.platform !== 'win32' }, async () => {
    const fx = makeFixture(code);
    const markers = instrumentFixture(fx);
    const release = holdLog(fx, 'None');
    try {
      assert.equal(runPs1(fx), code);
      assert.deepEqual(readCalls(fx), ['start --force']);
      assert.equal(fs.existsSync(markers.activation), code === 0);
      assert.equal(fs.existsSync(markers.failure), code !== 0);
    } finally { await release(); removeFixture(fx.dataRoot); }
  });
}

test('日志路径不可写也不阻断成功启动、窗口恢复或污染返回值', { skip: process.platform !== 'win32' }, () => {
  const fx = makeFixture(0);
  const markers = instrumentFixture(fx);
  try {
    assert.equal(runPs1(fx, { DWS_LAUNCHER_LOG: fx.dataRoot }), 0);
    assert.deepEqual(readCalls(fx), ['start --force']);
    assert.ok(fs.existsSync(markers.activation));
    assert.equal(fs.existsSync(markers.failure), false);
  } finally { removeFixture(fx.dataRoot); }
});

test('日志短暂失败会重试且重试预算有界', { skip: process.platform !== 'win32' }, () => {
  const fx = makeFixture(0);
  const scriptPath = path.join(fx.dataRoot, 'logger-test.ps1');
  try {
    const source = fs.readFileSync(fx.ps1Path, 'utf8').split('$mutex = $null')[0];
    fs.writeFileSync(scriptPath, source + `
$script:writes=0
function Add-Content { $script:writes++; if ($script:writes -lt 3) { throw [IO.IOException]::new('transient') } }
Write-Log 'retry'
if ($script:writes -ne 3) { throw 'retry contract' }
$script:writes=0
function Add-Content { $script:writes++; throw [IO.IOException]::new('locked') }
Write-Log 'exhaust'
Write-Log 'no further delay'
if ($script:writes -ne 4) { throw 'bounded budget' }
`, 'utf8');
    execFileSync(PS, ['-NoProfile','-NonInteractive','-File',scriptPath], { env:fixtureEnv(fx),timeout:15000,windowsHide:true });
  } finally { removeFixture(fx.dataRoot); }
});
test("Windows 安装计划将桌面快捷方式指向 wscript + 正式 VBS", () => {
  const shortcuts = "C:\\Users\\Test User\\AppData\\Local\\DoubaoWorkSkin\\启动入口";
  const plan = installTargets("win32", {
    shortcuts,
    engine: "C:\\Users\\Test User\\AppData\\Local\\DoubaoWorkSkin\\engine",
    applicationsDir: "C:\\Users\\Test User\\Applications",
  });
  assert.equal(path.basename(plan.desktop.target).toLowerCase(), "wscript.exe");
  assert.equal(plan.desktop.shortcutArguments, `"${path.join(shortcuts, "launcher.vbs")}" "${path.join(shortcuts, "启动豆包工作皮肤.ps1")}"`);
  assert.ok(plan.desktop.legacyShortcuts.some((entry) => path.basename(entry.target).toLowerCase() === "powershell.exe"
    && entry.file.endsWith("启动豆包工作皮肤.ps1")));
});
