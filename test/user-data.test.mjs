import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { prepareUserData, agentPrompt } from "../src/user-data.mjs";

const execFileAsync = promisify(execFile);

async function fixture(fn) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dws-desktop-"));
  try {
    const projectRoot = path.join(directory, "project");
    const dataRoot = path.join(directory, "Application Support/personal");
    const enginePath = path.join(directory, "Someone's Application Support/engine");
    await fs.mkdir(path.join(projectRoot, "skins/sample"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "skins/sample/theme.json"), '{"id":"sample"}');
    await fs.writeFile(path.join(projectRoot, "AGENTS.md"), "Agent instructions v1");
    await fn({ projectRoot, dataRoot, enginePath });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test("首次安装复制内置皮肤，升级保留个人皮肤、修改与状态，仅补充新主题", async () => {
  await fixture(async options => {
    const user = await prepareUserData(options);
    const personalTheme = path.join(user.skinsDir, "sample/theme.json");
    await fs.writeFile(personalTheme, "my edits");
    await fs.mkdir(path.join(user.skinsDir, "my-garden"));
    await fs.writeFile(path.join(user.skinsDir, "my-garden/theme.json"), "custom theme");
    await fs.writeFile(path.join(user.dataRoot, "preferences.json"), '{"lastTheme":"my-garden"}');
    await fs.writeFile(path.join(user.dataRoot, "state.json"), "live state");
    await fs.mkdir(path.join(options.projectRoot, "skins/new-theme"));
    await fs.writeFile(path.join(options.projectRoot, "skins/new-theme/theme.json"), "new builtin");
    await fs.writeFile(path.join(options.projectRoot, "skins/sample/theme.json"), "upstream changed");
    await fs.writeFile(path.join(options.projectRoot, "AGENTS.md"), "Agent instructions v2");
    await prepareUserData(options);
    assert.equal(await fs.readFile(personalTheme, "utf8"), "my edits");
    assert.equal(await fs.readFile(path.join(user.skinsDir, "my-garden/theme.json"), "utf8"), "custom theme");
    assert.equal(await fs.readFile(path.join(user.skinsDir, "new-theme/theme.json"), "utf8"), "new builtin");
    assert.equal(await fs.readFile(path.join(user.dataRoot, "preferences.json"), "utf8"), '{"lastTheme":"my-garden"}');
    assert.equal(await fs.readFile(path.join(user.dataRoot, "state.json"), "utf8"), "live state");
    assert.match(await fs.readFile(path.join(user.dataRoot, "AGENTS.md"), "utf8"), /Agent instructions v2/);
    if (process.platform !== "win32") assert.equal((await fs.stat(user.command)).mode & 0o777, 0o700);
    assert.ok(!(await fs.readdir(user.skinsDir)).some(name => name.startsWith(".seed-")));
  });
});

test("固定命令入口使用内置 Node，正确处理空格、引号和调用参数", async () => {
  await fixture(async options => {
    const user = await prepareUserData(options);
    // 按平台准备假 Node：Windows 上 .exe 必须是真可执行文件（批斗内容命名为 .exe 会被
    // Windows 拒绝执行），故复制当前测试进程的真 node.exe，并让 bridge 回显 argv。
    if (process.platform === "win32") {
      const runtimeDir = path.join(options.enginePath, "runtime");
      await fs.mkdir(runtimeDir, { recursive: true });
      await fs.copyFile(process.execPath, path.join(runtimeDir, "node.exe"));
      await fs.mkdir(path.join(options.enginePath, "scripts"), { recursive: true });
      await fs.writeFile(path.join(options.enginePath, "scripts/installed-cli.mjs"),
        "process.argv.slice(1).forEach((a) => console.log(a));\n");
    } else {
      const bin = path.join(options.enginePath, "runtime/bin");
      await fs.mkdir(bin, { recursive: true });
      await fs.writeFile(path.join(bin, "node"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    }
    // Windows 上 user.command 是 .cmd，须经 cmd；Node execFile 会对自带引号的参数二次转义，
    // 故用 exec（单条命令字符串）一次性传入。
    // Windows：.cmd 经 cmd 执行；用 shell:true 让整串命令原样交给 cmd.exe，
    // 避免 execFile 对已含引号的参数二次转义。mac 保持原有 execFileAsync。
    const stdout = process.platform === "win32"
      ? execFileSync(`"${user.command}" start "name with spaces" "$(touch never-run)"`, { encoding: "utf8", shell: true })
      : (await execFileAsync(user.command, ["start", "name with spaces", "$(touch never-run)"])).stdout;
    assert.deepEqual(stdout.trimEnd().split("\n"), [
      path.join(options.enginePath, "scripts/installed-cli.mjs"),
      "start", "name with spaces", "$(touch never-run)",
    ]);
    assert.ok(agentPrompt(options.dataRoot).includes(path.join(options.dataRoot, "AGENTS.md")));
    if (process.platform === "win32") {
      assert.match(agentPrompt(options.dataRoot), /桌面「豆包工作皮肤」快捷方式/);
      const guide = await fs.readFile(path.join(user.dataRoot, "AGENTS.md"), "utf8");
      assert.match(guide, /桌面的「豆包工作皮肤」快捷方式（\.lnk）/);
      assert.match(guide, /恢复官方外观\.cmd/);
      assert.doesNotMatch(guide, /双击桌面"豆包工作皮肤"文件夹/);
    }
  });
});

test("中文+空格路径下 .cmd 入口仍正确透传参数", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dws-中文-"));
  try {
    const projectRoot = path.join(directory, "项目");
    const dataRoot = path.join(directory, "数据 目录");
    const enginePath = path.join(directory, "我的 皮肤 引擎/engine");
    await fs.mkdir(path.join(projectRoot, "skins/sample"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "skins/sample/theme.json"), '{"id":"sample"}');
    await fs.writeFile(path.join(projectRoot, "AGENTS.md"), "中文指令");
    const user = await prepareUserData({ projectRoot, dataRoot, enginePath });
    if (process.platform === "win32") {
      const runtimeDir = path.join(enginePath, "runtime");
      await fs.mkdir(runtimeDir, { recursive: true });
      await fs.copyFile(process.execPath, path.join(runtimeDir, "node.exe"));
      await fs.mkdir(path.join(enginePath, "scripts"), { recursive: true });
      await fs.writeFile(path.join(enginePath, "scripts/installed-cli.mjs"),
        "process.argv.slice(1).forEach((a) => console.log(a));\n");
      const stdout = execFileSync(`"${user.command}" start "海风 微语"`, { encoding: "utf8", shell: true });
      assert.deepEqual(stdout.trimEnd().split("\n"), [
        path.join(enginePath, "scripts/installed-cli.mjs"),
        "start", "海风 微语",
      ]);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});