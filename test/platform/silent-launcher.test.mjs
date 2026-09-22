import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import * as win32 from "../../src/platform/win32.mjs";

const PS = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function makeFixture(exitCode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dws-ps1-"));
  const calls = path.join(dir, "calls.txt");
  // fake skin.cmd: 记录参数到 calls.txt，然后以指定码退出
  const cmd = `@echo off\r\necho %* >> "${calls}"\r\nexit /b ${exitCode}\r\n`;
  fs.writeFileSync(path.join(dir, "skin.cmd"), cmd);
  const ps1 = win32.launcherScripts(path.join(dir, "skin.cmd"))["启动豆包工作皮肤.ps1"];
  fs.writeFileSync(path.join(dir, "启动豆包工作皮肤.ps1"), "\uFEFF" + ps1);
  return { dir, calls, ps1Path: path.join(dir, "启动豆包工作皮肤.ps1") };
}

function runPs1(fixture, extraEnv = {}) {
  const log = path.join(fixture.dir, "launcher.log");
  const mutex = `Local\\DwsSilentLauncher.${process.pid}.${path.basename(fixture.dir)}`;
  const env = { ...process.env, DWS_LAUNCHER_LOG: log, DWS_LAUNCHER_MUTEX: mutex, ...extraEnv };
  try {
    execFileSync(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fixture.ps1Path], { env, timeout: 15_000 });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

test("静默 ps1：start exit 0 不 force，写日志", () => {
  if (process.platform !== "win32") return;
  const fx = makeFixture(0);
  try {
    const code = runPs1(fx, { DWS_LAUNCHER_NO_UI: "1" });
    assert.equal(code, 0);
    const calls = fs.readFileSync(fx.calls, "utf8").replace(/\r/g, "").trim();
    assert.equal(calls, "start");
    const log = fs.readFileSync(path.join(fx.dir, "launcher.log"), "utf8");
    assert.ok(log.includes("start"));
    assert.ok(!log.includes("force"));
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test("静默 ps1：start exit 2 自动 start --force 一次", () => {
  if (process.platform !== "win32") return;
  const fx = makeFixture(2);
  try {
    const code = runPs1(fx, { DWS_LAUNCHER_NO_UI: "1" });
    // fake cli 对 --force 也返回 2，所以最终码 2
    assert.equal(code, 2);
    const calls = fs.readFileSync(fx.calls, "utf8").replace(/\r/g, "").trim().split("\n").map(s => s.trim());
    assert.deepEqual(calls, ["start", "start --force"]);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test("静默 ps1：失败写日志", () => {
  if (process.platform !== "win32") return;
  const fx = makeFixture(7);
  try {
    runPs1(fx, { DWS_LAUNCHER_NO_UI: "1" });
    const log = fs.readFileSync(path.join(fx.dir, "launcher.log"), "utf8");
    assert.ok(log.includes("失败"));
    assert.ok(log.includes("code=7"));
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test("静默 ps1：真实安装布局从启动入口调用 dataRoot 固定 CLI", () => {
  if (process.platform !== "win32") return;
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dws-real-layout-"));
  const entryDir = path.join(dataRoot, "启动入口");
  const calls = path.join(dataRoot, "calls.txt");
  const cli = path.join(dataRoot, "skin.cmd");
  const ps1Path = path.join(entryDir, "启动豆包工作皮肤.ps1");
  fs.mkdirSync(entryDir, { recursive: true });
  fs.writeFileSync(cli, `@echo off\r\necho %* >> "${calls}"\r\nexit /b 0\r\n`);
  const ps1 = win32.launcherScripts(cli, dataRoot)["启动豆包工作皮肤.ps1"];
  fs.writeFileSync(ps1Path, "\uFEFF" + ps1);
  try {
    assert.equal(fs.existsSync(path.join(entryDir, "skin.cmd")), false);
    const code = runPs1({ dir: dataRoot, ps1Path }, { DWS_LAUNCHER_NO_UI: "1" });
    assert.equal(code, 0);
    assert.equal(fs.readFileSync(calls, "utf8").replace(/\r/g, "").trim(), "start");
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("静默 ps1：命名互斥锁防止并发执行", async () => {
  if (process.platform !== "win32") return;
  const fx = makeFixture(0);
  const mutex = `Local\\DwsSilentLauncher.Concurrent.${process.pid}`;
  const holderScript = `$m=New-Object System.Threading.Mutex($false,'${mutex}');$null=$m.WaitOne();Start-Sleep -Seconds 4;$m.ReleaseMutex();$m.Dispose()`;
  const holder = spawn(PS, ["-NoProfile", "-NonInteractive", "-Command", holderScript], { stdio: "ignore" });
  try {
    await new Promise(resolve => setTimeout(resolve, 500));
    const code = runPs1(fx, { DWS_LAUNCHER_NO_UI: "1", DWS_LAUNCHER_MUTEX: mutex });
    assert.equal(code, 0);
    assert.equal(fs.existsSync(fx.calls), false);
    const log = fs.readFileSync(path.join(fx.dir, "launcher.log"), "utf8");
    assert.ok(log.includes("已有启动器在运行"));
  } finally {
    holder.kill();
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});
