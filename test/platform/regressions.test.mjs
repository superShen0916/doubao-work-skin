import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { listProcessesByName as listMac } from "../../src/platform/darwin.mjs";
import { terminateProcess, isProcessAlive, silentLauncherScript } from "../../src/platform/win32.mjs";
import { launcherMutexName } from "../../src/platform/windows-launcher.mjs";
import { inspectWatchProcess } from "../../src/runtime.mjs";
import { isEngineInUse } from "../../scripts/install.mjs";
import { powerShellArgs } from "../../src/platform/powershell.mjs";

const exec = promisify(execFile);
const windows = { skip: process.platform !== "win32" && "仅 Windows" };

test("macOS production enumeration retains absolute comm paths and spaces", async () => {
  const browser = "/Applications/DoubaoWork.app/Contents/Helpers/DoubaoWork Browser.app/Contents/MacOS/DoubaoWork Browser";
  const rows = await listMac(["DoubaoWork", "DoubaoWork Browser"], {
    execFileImpl: async (_file, args) => args[0] === "-axo"
      ? { stdout: `10 /Applications/DoubaoWork.app/Contents/MacOS/DoubaoWork\n11 ${browser}\n12 /tmp/Other Browser\n` }
      : { stdout: args[1] === "11" ? `${browser} --port=1` : "/Applications/DoubaoWork.app/Contents/MacOS/DoubaoWork" },
  });
  assert.deepEqual(rows.map(row => row.pid), [10, 11]);
  assert.equal(rows[1].executablePath, browser);
});

test("watch ownership rejects entrypoint suffixes and flag lookalikes", async () => {
  const injectorPath = "C:\\project\\src\\injector.mjs";
  for (const [suffix, flag] of [[".bak", "--watch"], ["/evil", "--watch"], ["", "--watchdog"]]) {
    const found = await inspectWatchProcess(123, {
      projectRoot: "C:\\project", injectorPath,
      inspectProcess: async () => ({ command: `"C:\\node.exe" "${injectorPath}${suffix}" ${flag} --port 9342 --skin "C:\\skins\\sample"`, cwd: null }),
    });
    assert.equal(found, null, `${suffix} ${flag}`);
  }
});

test("launcher mutex distinguishes Unicode roots and normalizes Windows aliases", () => {
  assert.notEqual(launcherMutexName("C:\\皮肤甲"), launcherMutexName("C:\\皮肤乙"));
  assert.equal(launcherMutexName("C:/Users/Tester/Skin"), launcherMutexName("c:\\users\\tester\\skin"));
  assert.ok(launcherMutexName("C:\\" + "a".repeat(400)).length < 256);
  assert.throws(() => silentLauncherScript("ignored", "C:\\x\nexit 1"), /无效/);
  const script = silentLauncherScript("ignored", "C:\\User's 皮肤");
  assert.ok(script.includes("C:\\User''s 皮肤"));
  assert.doesNotMatch(script, /@@(?:DATA_ROOT|MUTEX_NAME|WINDOW_SOURCE)@@/);
});

test("installer idle check returns false for no processes (not Measure-Object's own count)", windows, async () => {
  const root = path.join(os.tmpdir(), `dws-unoccupied-${process.pid}-${Date.now()}`);
  assert.equal(await isEngineInUse(root), false);
});

test("owned headless watch can exit immediately without taskkill graceful timeout", windows, async () => {
  const child = spawn(process.execPath, ["-e", "console.log('ready');setInterval(()=>{},1000)"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  const exited = once(child, "exit");
  try {
    await once(child.stdout, "data");
    await terminateProcess(child.pid, { force: true });
    await exited;
    assert.equal(await isProcessAlive(child.pid), false);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
});

test("Windows app spawn reports async ENOENT and does not hide its GUI", async () => {
  const { spawnApp } = await import("../../src/platform/spawn-app.mjs");
  const { EventEmitter } = await import("node:events");
  let received;
  assert.equal(await spawnApp("C:\\app\\DoubaoWork.exe", 9342, {
    spawnImpl: (_binary, args, options) => {
      received = { args, options };
      const child = new EventEmitter();
      child.pid = 321;
      child.unref = () => {};
      process.nextTick(() => child.emit("spawn"));
      return child;
    },
  }), 321);
  assert.equal(received.options.windowsHide, false);
  await assert.rejects(spawnApp(path.join(os.tmpdir(), 'dws-missing-executable', 'no-app.exe'), 9342), { code: 'ENOENT' });
  await assert.rejects(spawnApp('unused', 65536, { spawnImpl: () => assert.fail('invalid port must not spawn') }), /无效端口/);
});

test("PowerShell transport is ASCII and preserves Unicode", () => {
  const script = "Write-Output '中文路径 日本語';";
  const args = powerShellArgs(script);
  assert.ok(args.includes('-EncodedCommand'));
  assert.ok(args.every(arg => Array.from(arg).every(ch => ch.charCodeAt(0) <= 127)));
  assert.ok(Buffer.from(args.at(-1), 'base64').toString('utf16le').endsWith(script));
});

test("PowerShell Unicode round trip", windows, async () => {
  const { stdout } = await exec('powershell.exe', powerShellArgs("[Console]::OutputEncoding=[Text.Encoding]::UTF8;Write-Output '中文路径 日本語'"), { encoding: 'utf8', windowsHide: true });
  assert.equal(stdout.trim(), '中文路径 日本語');
});

test("generated launcher parses under PS 5.1 and native window helper compiles", windows, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dws-parse-"));
  const ps1 = path.join(root, "launcher.ps1");
  const source = new URL("../../src/platform/windows-window.cs", import.meta.url);
  const shortcutSource = new URL("../../src/platform/windows-shortcut.cs", import.meta.url);
  try {
    await fs.writeFile(ps1, "\uFEFF" + silentLauncherScript("ignored", "C:\\User's 皮肤"), "utf8");
    const csPath = (await import("node:url")).fileURLToPath(source).replaceAll("'", "''");
    const shortcutCsPath = (await import("node:url")).fileURLToPath(shortcutSource).replaceAll("'", "''");
    const script = `$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('${ps1.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors) | Out-Null;if($errors.Count){throw ($errors | Out-String)};Add-Type -TypeDefinition ([IO.File]::ReadAllText('${csPath}'));Add-Type -TypeDefinition ([IO.File]::ReadAllText('${shortcutCsPath}'));$type=[DoubaoWorkSkin.WindowActivation];if($type::TryActivate(0) -ne 'invalid-pid'){throw 'guard failed'};$shortcutType=[DoubaoWorkSkin.Shortcut];if($shortcutType.GetMethod('Save') -eq $null -or $shortcutType.GetMethod('GetTarget') -eq $null){throw 'shortcut helper missing'};$source=[IO.File]::ReadAllText('${csPath}');foreach($api in 'AttachThreadInput','BringWindowToTop','GetCurrentThreadId'){if($source -notmatch $api){throw "missing $api"}};if(-not $type.GetMethod('FindWindow',[Reflection.BindingFlags]'NonPublic,Static')){throw 'FindWindow missing'};Write-Output 'parser-and-compiler-ok'`;
    const result = await exec("powershell.exe", powerShellArgs(script), { windowsHide: true, timeout: 15000 });
    assert.match(result.stdout, /parser-and-compiler-ok/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
