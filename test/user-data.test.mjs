import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareUserData, agentPrompt } from "../src/user-data.mjs";

const exec = promisify(execFile);

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
    assert.equal((await fs.stat(user.command)).mode & 0o777, 0o700);
    assert.ok(!(await fs.readdir(user.skinsDir)).some(name => name.startsWith(".seed-")));
  });
});

test("固定命令入口使用内置 Node，正确处理空格、引号和调用参数", async () => {
  await fixture(async options => {
    const user = await prepareUserData(options);
    const bin = path.join(options.enginePath, "runtime/bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "node"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    const { stdout } = await exec(user.command, ["start", "name with spaces", "$(touch never-run)"]);
    assert.deepEqual(stdout.trimEnd().split("\n"), [
      path.join(options.enginePath, "scripts/installed-cli.mjs"),
      "start", "name with spaces", "$(touch never-run)",
    ]);
    assert.ok(agentPrompt(options.dataRoot).includes(path.join(options.dataRoot, "AGENTS.md")));
  });
});
