import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { install, launcherScripts, launcherApp } from "../scripts/install.mjs";

const exec = promisify(execFile);

test("经符号链接打开的项目仍实际运行 CLI，而非静默退出", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "dws-link-"));
  try {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const alias = path.join(temp, "project-link");
    await fs.symlink(repo, alias);
    const { stdout } = await exec(process.execPath, [path.join(alias, "skin.mjs"), "list"], { env: { ...process.env, DWS_STATE_ROOT: path.join(temp, "state") } });
    assert.match(stdout, /海风微语/);
    assert.match(stdout, /晴窗猫咪/);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

async function fixture(fn) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "dws-install-"));
  try {
    const projectRoot = path.join(temp, "project");
    const runtimeDir = path.join(temp, "runtime");
    const dataRoot = path.join(temp, "Application Support/skin");
    const desktopDir = path.join(temp, "Desktop");
    const applicationsDir = path.join(temp, "Applications");
    for (const directory of ["src", "skins/sample", "scripts"]) await fs.mkdir(path.join(projectRoot, directory), { recursive: true });
    for (const name of ["skin.mjs", "AGENTS.md", "CONTRIBUTING.md", "README.md", "LICENSE", "package.json"]) await fs.writeFile(path.join(projectRoot, name), "fixture");
    await fs.writeFile(path.join(projectRoot, "src/runtime.mjs"), "export async function stopWatchProcess() {}\n");
    await fs.writeFile(path.join(projectRoot, "scripts/installed-cli.mjs"), "// fixture\n");
    await fs.writeFile(path.join(projectRoot, "skins/sample/theme.json"), "original");
    await fs.mkdir(path.join(runtimeDir, "bin"), { recursive: true });
    await fs.writeFile(path.join(runtimeDir, "bin/node"), "#!/bin/sh\nexit 0\n");
    await fs.writeFile(path.join(runtimeDir, "LICENSE"), "runtime license");
    await fn({ projectRoot, runtimeDir, dataRoot, desktopDir, applicationsDir, validate: async () => {} });
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

test("脚本安装升级程序但保留个人皮肤、偏好和固定桌面入口", async () => {
  await fixture(async options => {
    const first = await install(options);
    await fs.writeFile(path.join(first.skinsDir, "sample/theme.json"), "my changes");
    await fs.writeFile(path.join(options.dataRoot, "preferences.json"), '{"lastTheme":"sample"}');
    await fs.writeFile(path.join(options.projectRoot, "skin.mjs"), "new version");
    await install(options);
    assert.equal(await fs.readFile(path.join(first.engine, "skin.mjs"), "utf8"), "new version");
    assert.equal(await fs.readFile(path.join(first.skinsDir, "sample/theme.json"), "utf8"), "my changes");
    assert.equal(await fs.readFile(path.join(options.dataRoot, "preferences.json"), "utf8"), '{"lastTheme":"sample"}');
    assert.equal(await fs.readlink(path.join(options.desktopDir, "豆包换肤")), first.shortcuts);
    assert.equal((await fs.stat(path.join(first.shortcuts, "启动豆包工作.command"))).mode & 0o777, 0o700);
    assert.ok(!(await fs.readdir(options.dataRoot)).some(name => name.startsWith(".engine-") || name === ".install-lock"));
  });
});

test("候选程序检查失败不会替换旧程序或清除用户数据", async () => {
  await fixture(async options => {
    const first = await install(options);
    await assert.rejects(install({ ...options, validate: async () => { throw new Error("invalid candidate"); } }), /invalid candidate/);
    assert.equal(await fs.readFile(path.join(first.engine, "skin.mjs"), "utf8"), "fixture");
    assert.equal(await fs.readFile(path.join(first.skinsDir, "sample/theme.json"), "utf8"), "original");
    assert.ok(!(await fs.readdir(options.dataRoot)).includes(".install-lock"));
  });
});

test("旧安装升级后兼容个人 CSS，保留背景、配色、专属样式及偏好文件", async () => {
  await fixture(async options => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    for (const name of ["theme.mjs", "theme-compat.mjs", "base.css"]) {
      await fs.copyFile(path.join(root, "src", name), path.join(options.projectRoot, "src", name));
    }
    await fs.writeFile(path.join(options.projectRoot, "package.json"), '{"version":"2.2.1","type":"module"}');
    const first = await install(options);
    const config = JSON.parse(await fs.readFile(path.join(root, "skins/seaside-breeze/theme.json"), "utf8"));
    config.id = "sample";
    config.name = "我的定制海风";
    config.colors.accent = "#123456";
    const personal = path.join(first.skinsDir, "sample");
    const legacy = await fs.readFile(path.join(root, "test/fixtures/legacy-theme.css"), "utf8");
    const originals = {
      "theme.json": JSON.stringify(config),
      "background.png": "personal background bytes",
      "skin.css": legacy,
    };
    for (const [name, content] of Object.entries(originals)) await fs.writeFile(path.join(personal, name), content);
    const preferences = '{"lastTheme":"sample"}';
    await fs.writeFile(path.join(first.dataRoot, "preferences.json"), preferences);
    await fs.writeFile(path.join(options.projectRoot, "package.json"), '{"version":"2.2.2","type":"module"}');
    await install(options);
    await install(options);
    const { loadTheme } = await import(pathToFileURL(path.join(first.engine, "src/theme.mjs")));
    const loaded = await loadTheme({ skinDir: personal });
    assert.equal(loaded.skinCss, legacy);
    assert.equal(loaded.theme.colors.accent, "#123456");
    assert.ok(loaded.finalCss.includes(':not([class~="z-[-1]"])'));
    assert.ok(loaded.finalCss.lastIndexOf("backdrop-filter: none") > loaded.finalCss.lastIndexOf("backdrop-filter: blur"));
    assert.ok(loaded.finalCss.includes("#personal-card { color: rgb(123, 45, 67); border-radius: 23px; }"));
    assert.ok(loaded.finalCss.includes("换肤 v2.2.2"));
    for (const [name, content] of Object.entries(originals)) assert.equal(await fs.readFile(path.join(personal, name), "utf8"), content);
    assert.equal(await fs.readFile(path.join(first.dataRoot, "preferences.json"), "utf8"), preferences);
    assert.ok(!(await fs.readdir(options.dataRoot)).some(name => name.startsWith(".engine-") || name === ".install-lock"));
  });
});

test("桌面存在同名文件时保留原文件；未知引擎目录不覆盖", async () => {
  await fixture(async options => {
    await fs.mkdir(options.desktopDir);
    const existing = path.join(options.desktopDir, "豆包换肤");
    await fs.writeFile(existing, "personal file");
    await install(options);
    assert.equal(await fs.readFile(existing, "utf8"), "personal file");
    await fs.writeFile(path.join(options.dataRoot, "engine/.installation"), "someone else");
    await assert.rejects(install(options), /已有其他内容/);
  });
});

test("非交互调用启动入口时不会自动强制重启宿主应用", async () => {
  await fixture(async options => {
    const command = path.join(options.projectRoot, "fake-cli");
    const calls = path.join(options.projectRoot, "calls");
    await fs.writeFile(command, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DWS_TEST_CALLS"\nexit 2\n', { mode: 0o700 });
    const launcher = path.join(options.projectRoot, "launch.command");
    await fs.writeFile(launcher, launcherScripts(command)["启动豆包工作.command"], { mode: 0o700 });
    await assert.rejects(exec("/bin/zsh", [launcher], { env: { ...process.env, DWS_TEST_CALLS: calls } }), error => error.code === 2);
    assert.equal(await fs.readFile(calls, "utf8"), "start\n");
  });
});

test("安装时创建启动 App，包含智能启动脚本和图标", async () => {
  await fixture(async options => {
    const applicationsDir = path.join(options.dataRoot, "..", "Applications");
    // 准备有效 package.json 和图标资源
    await fs.writeFile(path.join(options.projectRoot, "package.json"), '{"version":"2.2.2","type":"module"}');
    await fs.mkdir(path.join(options.projectRoot, "assets"), { recursive: true });
    await fs.writeFile(path.join(options.projectRoot, "assets/AppIcon.icns"), "fake-icns-bytes");
    await install({ ...options, applicationsDir });
    const appPath = path.join(applicationsDir, "豆包换肤.app");
    // 验证目录结构
    assert.ok(await fs.stat(path.join(appPath, "Contents/Info.plist")).then(() => true, () => false));
    assert.ok(await fs.stat(path.join(appPath, "Contents/MacOS/Launcher")).then(() => true, () => false));
    assert.ok(await fs.stat(path.join(appPath, "Contents/Resources/AppIcon.icns")).then(() => true, () => false));
    // 验证可执行权限
    assert.equal((await fs.stat(path.join(appPath, "Contents/MacOS/Launcher"))).mode & 0o777, 0o755);
    // 验证 Info.plist 内容
    const plist = await fs.readFile(path.join(appPath, "Contents/Info.plist"), "utf8");
    assert.ok(plist.includes("com.doubaowork.skin.launcher"));
    assert.ok(plist.includes("豆包换肤"));
    assert.ok(plist.includes("2.2.2"));
    // 验证启动脚本包含智能启动逻辑
    const launcher = await fs.readFile(path.join(appPath, "Contents/MacOS/Launcher"), "utf8");
    assert.ok(launcher.includes('"$PGREP" -f'));
    assert.ok(launcher.includes("start --force"));
    assert.ok(!launcher.includes("read -r")); // 不包含交互式确认
  });
});

test("已存在本项目创建的 App 时覆盖重建", async () => {
  await fixture(async options => {
    const applicationsDir = path.join(options.dataRoot, "..", "Applications");
    await fs.writeFile(path.join(options.projectRoot, "package.json"), '{"version":"2.2.2","type":"module"}');
    await fs.mkdir(path.join(options.projectRoot, "assets"), { recursive: true });
    await fs.writeFile(path.join(options.projectRoot, "assets/AppIcon.icns"), "icns-v1");
    // 先创建一个旧版本的 App
    await install({ ...options, applicationsDir });
    const appPath = path.join(applicationsDir, "豆包换肤.app");
    const oldPlist = await fs.readFile(path.join(appPath, "Contents/Info.plist"), "utf8");
    assert.ok(oldPlist.includes("2.2.2"));
    // 修改版本号，重新安装，应覆盖
    await fs.writeFile(path.join(options.projectRoot, "package.json"), '{"version":"2.3.0","type":"module"}');
    await fs.writeFile(path.join(options.projectRoot, "assets/AppIcon.icns"), "icns-v2");
    await install({ ...options, applicationsDir });
    const newPlist = await fs.readFile(path.join(appPath, "Contents/Info.plist"), "utf8");
    assert.ok(newPlist.includes("2.3.0"));
    assert.ok(!newPlist.includes("2.2.2"));
  });
});

test("已存在非本项目的同名 App 时跳过不覆盖", async () => {
  await fixture(async options => {
    const applicationsDir = path.join(options.dataRoot, "..", "Applications");
    await fs.writeFile(path.join(options.projectRoot, "package.json"), '{"version":"2.2.2","type":"module"}');
    await fs.mkdir(path.join(options.projectRoot, "assets"), { recursive: true });
    await fs.writeFile(path.join(options.projectRoot, "assets/AppIcon.icns"), "icns");
    // 预先创建一个非本项目的同名 App
    const appPath = path.join(applicationsDir, "豆包换肤.app");
    await fs.mkdir(path.join(appPath, "Contents"), { recursive: true });
    await fs.writeFile(path.join(appPath, "Contents/Info.plist"), '<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>com.other.app</string></dict></plist>');
    await install({ ...options, applicationsDir });
    // 应保留原 App，不被覆盖
    const plist = await fs.readFile(path.join(appPath, "Contents/Info.plist"), "utf8");
    assert.ok(plist.includes("com.other.app"));
    assert.ok(!plist.includes("com.doubaowork.skin.launcher"));
  });
});

test("assets/AppIcon.icns 不存在时 App 仍创建但无图标", async () => {
  await fixture(async options => {
    const applicationsDir = path.join(options.dataRoot, "..", "Applications");
    await fs.writeFile(path.join(options.projectRoot, "package.json"), '{"version":"2.2.2","type":"module"}');
    // 不创建 assets 目录
    await install({ ...options, applicationsDir });
    const appPath = path.join(applicationsDir, "豆包换肤.app");
    assert.ok(await fs.stat(path.join(appPath, "Contents/Info.plist")).then(() => true, () => false));
    assert.ok(await fs.stat(path.join(appPath, "Contents/MacOS/Launcher")).then(() => true, () => false));
    // 图标文件不存在
    assert.ok(!(await fs.stat(path.join(appPath, "Contents/Resources/AppIcon.icns")).then(() => true, () => false)));
  });
});

test("launcherApp 未传 version 时回退到 1.0.0", async () => {
  await fixture(async options => {
    const applicationsDir = path.join(options.dataRoot, "..", "Applications");
    // package.json 内容是 "fixture"（无效 JSON），但 App 创建被 try/catch 包裹
    // 这里直接测 launcherApp 的回退逻辑
    const app = launcherApp({ command: "/tmp/skin", version: undefined });
    assert.ok(app.infoPlist.includes("1.0.0"));
  });
});

test("launcherApp 生成的启动脚本通过 zsh 语法检查", async () => {
  const app = launcherApp({ command: "/tmp/test skin/skin", version: "2.2.2" });
  const tmpScript = path.join(os.tmpdir(), `dws-launcher-syntax-${process.pid}.sh`);
  try {
    await fs.writeFile(tmpScript, app.executable, { mode: 0o755 });
    await exec("/bin/zsh", ["-n", tmpScript]);
  } finally {
    await fs.rm(tmpScript, { force: true });
  }
});

// Launcher 行为测试：用 mock 的 pgrep/open/skin 验证各分支的调用序列
async function runLauncherScenario({ pgrepExit = 0, statusOutput = "", startExit = 0, startForceExit = 0 } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "dws-launcher-behavior-"));
  const callLog = path.join(temp, "calls.log");
  const pgrepScript = path.join(temp, "mock-pgrep");
  const openScript = path.join(temp, "mock-open");
  const skinScript = path.join(temp, "mock-skin");
  await fs.writeFile(pgrepScript, `#!/bin/sh\necho "pgrep" >> "${callLog}"\nexit ${pgrepExit}\n`, { mode: 0o755 });
  await fs.writeFile(openScript, `#!/bin/sh\necho "open $*" >> "${callLog}"\nexit 0\n`, { mode: 0o755 });
  await fs.writeFile(skinScript, `#!/bin/sh
echo "skin $*" >> "${callLog}"
case "$1" in
  status) printf '%s' "$MOCK_STATUS_OUTPUT"; exit 0;;
  start)
    if [ "$2" = "--force" ]; then exit "$MOCK_START_FORCE_EXIT"; fi
    exit "$MOCK_START_EXIT";;
  *) exit 0;;
esac
`, { mode: 0o755 });
  const app = launcherApp({ command: skinScript, version: "2.2.2" });
  const launcherScript = path.join(temp, "Launcher");
  await fs.writeFile(launcherScript, app.executable, { mode: 0o755 });
  try {
    await exec("/bin/zsh", [launcherScript], {
      env: {
        ...process.env,
        DWS_TEST_PGREP: pgrepScript,
        DWS_TEST_OPEN: openScript,
        MOCK_STATUS_OUTPUT: statusOutput,
        MOCK_START_EXIT: String(startExit),
        MOCK_START_FORCE_EXIT: String(startForceExit),
      },
    });
  } catch {
    // 某些场景预期非0退出码，忽略
  }
  const log = await fs.readFile(callLog, "utf8").catch(() => "");
  await fs.rm(temp, { recursive: true, force: true });
  return log.trim().split("\n").filter(Boolean);
}

test("Launcher 行为：应用未运行时调用 skin start 成功后激活窗口", async () => {
  const calls = await runLauncherScenario({ pgrepExit: 1 });
  assert.deepEqual(calls, ["pgrep", "skin start", "open /Applications/DoubaoWork.app"]);
});

test("Launcher 行为：无皮肤但有 CDP 时调用 skin start 成功，不触发 --force", async () => {
  const calls = await runLauncherScenario({
    pgrepExit: 0,
    statusOutput: '{"running": false,"port": 9342}',
    startExit: 0,
  });
  assert.deepEqual(calls, ["pgrep", "skin start", "open /Applications/DoubaoWork.app"]);
});

test("Launcher 行为：无皮肤且无 CDP 时调用 skin start --force", async () => {
  const calls = await runLauncherScenario({
    pgrepExit: 0,
    statusOutput: '{"running": false,"port": null}',
    startExit: 2,
    startForceExit: 0,
  });
  assert.deepEqual(calls, ["pgrep", "skin start", "skin start --force", "open /Applications/DoubaoWork.app"]);
});
