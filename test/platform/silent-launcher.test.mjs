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

test("桌面 ps1：只执行一次 start --force，并尝试激活窗口", () => {
  if (process.platform !== "win32") return;
  const fx = makeFixture(0);
  try {
    assert.equal(runPs1(fx), 0);
    assert.deepEqual(readCalls(fx), ["start --force"]);
    const log = fs.readFileSync(path.join(fx.dataRoot, "launcher.log"), "utf8");
    assert.match(log, /中文错误流不是 PowerShell 异常/);
    assert.match(log, /force exit=0/);
    assert.match(log, /已激活豆包工作 PID|未能自动激活豆包工作 PID/);
    assert.doesNotMatch(log, /启动器异常/);
  } finally { fs.rmSync(fx.dataRoot, { recursive: true, force: true }); }
});

test("桌面 ps1：force 返回 2 时不重复执行", () => {
  if (process.platform !== "win32") return;
  const fx = makeFixture(2);
  try {
    assert.equal(runPs1(fx), 2);
    assert.deepEqual(readCalls(fx), ["start --force"]);
    const log = fs.readFileSync(path.join(fx.dataRoot, "launcher.log"), "utf8");
    assert.match(log, /force exit=2/);
    assert.doesNotMatch(log, /启动器异常/);
  } finally { fs.rmSync(fx.dataRoot, { recursive: true, force: true }); }
});

test("桌面 ps1：其他失败码只执行一次 force 并记录失败", () => {
  if (process.platform !== "win32") return;
  const fx = makeFixture(7);
  try {
    assert.equal(runPs1(fx), 7);
    assert.deepEqual(readCalls(fx), ["start --force"]);
    const log = fs.readFileSync(path.join(fx.dataRoot, "launcher.log"), "utf8");
    assert.match(log, /失败 code=7/);
  } finally { fs.rmSync(fx.dataRoot, { recursive: true, force: true }); }
});

test("VBS 正式入口由 wscript 托管并启动同目录 PS1", () => {
  if (process.platform !== "win32") return;
  const fx = makeFixture(0);
  try {
    const vbs = fs.readFileSync(fx.vbsPath, "utf8");
    assert.match(vbs, /shell\.Run command, 0, False/);
    assert.match(vbs, /WScript\.Arguments\(0\)/);
    execFileSync(WSCRIPT, [fx.vbsPath, fx.ps1Path], { env: fixtureEnv(fx), timeout: 5_000, windowsHide: true });
    waitForFile(fx.calls);
    assert.deepEqual(readCalls(fx), ["start --force"]);
  } finally { fs.rmSync(fx.dataRoot, { recursive: true, force: true }); }
});

test("命名互斥锁防止桌面入口重复执行", async () => {
  if (process.platform !== "win32") return;
  const fx = makeFixture(0);
  const mutex = `Local\\DwsSilentLauncher.Concurrent.${process.pid}`;
  const holderScript = `$m=New-Object System.Threading.Mutex($false,'${mutex}');$null=$m.WaitOne();Start-Sleep -Seconds 4;$m.ReleaseMutex();$m.Dispose()`;
  const holder = spawn(PS, ["-NoProfile", "-NonInteractive", "-Command", holderScript], { stdio: "ignore", windowsHide: true });
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(runPs1(fx, { DWS_LAUNCHER_MUTEX: mutex }), 0);
    assert.equal(fs.existsSync(fx.calls), false);
    const log = fs.readFileSync(path.join(fx.dataRoot, "launcher.log"), "utf8");
    assert.match(log, /已有启动器在运行/);
  } finally {
    holder.kill();
    fs.rmSync(fx.dataRoot, { recursive: true, force: true });
  }
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
