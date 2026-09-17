import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { install, launcherScripts } from "../scripts/install.mjs";

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
    for (const directory of ["src", "skins/sample", "scripts"]) await fs.mkdir(path.join(projectRoot, directory), { recursive: true });
    for (const name of ["skin.mjs", "AGENTS.md", "CONTRIBUTING.md", "README.md", "LICENSE", "package.json"]) await fs.writeFile(path.join(projectRoot, name), "fixture");
    await fs.writeFile(path.join(projectRoot, "src/runtime.mjs"), "export async function stopWatchProcess() {}\n");
    await fs.writeFile(path.join(projectRoot, "scripts/installed-cli.mjs"), "// fixture\n");
    await fs.writeFile(path.join(projectRoot, "skins/sample/theme.json"), "original");
    await fs.mkdir(path.join(runtimeDir, "bin"), { recursive: true });
    await fs.writeFile(path.join(runtimeDir, "bin/node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.writeFile(path.join(runtimeDir, "node.exe"), "@echo off\r\nexit 0\r\n");
    await fs.writeFile(path.join(runtimeDir, "LICENSE"), "runtime license");
    await fn({ projectRoot, runtimeDir, dataRoot, desktopDir, validate: async () => {} });
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
    if (process.platform === "darwin") {
      assert.equal(await fs.readlink(path.join(options.desktopDir, "豆包工作皮肤")), first.shortcuts);
      assert.equal((await fs.stat(path.join(first.shortcuts, "启动豆包工作.command"))).mode & 0o777, 0o700);
    } else if (process.platform === "win32") {
      assert.ok(await fs.stat(path.join(first.shortcuts, "启动豆包工作.cmd")));
    }
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
    const existing = path.join(options.desktopDir, "豆包工作皮肤");
    await fs.writeFile(existing, "personal file");
    await install(options);
    assert.equal(await fs.readFile(existing, "utf8"), "personal file");
    await fs.writeFile(path.join(options.dataRoot, "engine/.installation"), "someone else");
    await assert.rejects(install(options), /已有其他内容/);
  });
});

test("非交互调用启动入口时不会自动强制重启宿主应用", async () => {
  await fixture(async options => {
    const isWin = process.platform === "win32";
    const command = path.join(options.projectRoot, isWin ? "fake-cli.cmd" : "fake-cli");
    const calls = path.join(options.projectRoot, "calls");
    if (isWin) {
      await fs.writeFile(command, `@echo off\r\necho %* >> "%DWS_TEST_CALLS%"\r\nexit /b 2\r\n`);
    } else {
      await fs.writeFile(command, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DWS_TEST_CALLS"\nexit 2\n', { mode: 0o700 });
    }
    const launcherName = isWin ? "启动豆包工作.cmd" : "启动豆包工作.command";
    const launcher = path.join(options.projectRoot, launcherName);
    await fs.writeFile(launcher, launcherScripts(command)[launcherName], { mode: 0o700 });
    if (isWin) {
      await assert.rejects(exec("cmd.exe", ["/c", launcher], { env: { ...process.env, DWS_TEST_CALLS: calls } }), error => error.code === 2);
    } else {
      await assert.rejects(exec("/bin/zsh", [launcher], { env: { ...process.env, DWS_TEST_CALLS: calls } }), error => error.code === 2);
    }
    assert.equal(await fs.readFile(calls, "utf8"), "start\n");
  });
});
