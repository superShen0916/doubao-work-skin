#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { realpathSync } from "node:fs";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareUserData, agentPrompt, defaultDataRoot } from "../src/user-data.mjs";
import { launcherScripts, createDesktopShortcut, ensurePrivateDir } from "../src/platform/index.mjs";

export { launcherScripts };

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = "doubao-work-skin-script-install-v1";

export async function install({
  projectRoot = ROOT,
  runtimeDir,
  dataRoot = process.env.DWS_STATE_ROOT || defaultDataRoot,
  desktopDir = process.env.DWS_DESKTOP_DIR || path.join(os.homedir(), "Desktop"),
  validate = async (engine) => {
    const node = path.join(engine, "runtime/bin/node");
    await exec(node, ["--input-type=module", "-e", `
      import { discoverThemes, loadTheme } from './src/theme.mjs';
      if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 版本过低');
      for (const name of await discoverThemes()) await loadTheme({ name });
    `], { cwd: engine, env: { HOME: os.homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  },
} = {}) {
  if (!runtimeDir) throw new Error("缺少专用运行环境，请双击安装皮肤.command");
  await fs.mkdir(dataRoot, { recursive: true });
  await ensurePrivateDir(dataRoot).catch(() => {});
  const lock = path.join(dataRoot, ".install-lock");
  try { await fs.mkdir(lock); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`已有安装正在进行。若上次安装意外中断，请确认没有安装进程后删除 ${lock} 再重试。`);
    throw error;
  }
  let staging;
  let backup;
  const engine = path.join(dataRoot, "engine");
  try {
    const exists = await fs.lstat(engine).then(() => true, (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (exists) {
      const marker = await fs.readFile(path.join(engine, ".installation"), "utf8").catch(() => "");
      if (marker !== MARKER || (await fs.lstat(engine)).isSymbolicLink()) throw new Error("安装目录已有其他内容，未覆盖。");
    }
    staging = await fs.mkdtemp(path.join(dataRoot, ".engine-new-"));
    for (const name of ["skin.mjs", "src", "skins", "AGENTS.md", "CONTRIBUTING.md", "README.md", "LICENSE", "package.json"]) {
      await fs.cp(path.join(projectRoot, name), path.join(staging, name), { recursive: true });
    }
    await fs.mkdir(path.join(staging, "scripts"));
    await fs.copyFile(path.join(projectRoot, "scripts/installed-cli.mjs"), path.join(staging, "scripts/installed-cli.mjs"));
    await fs.mkdir(path.join(staging, "runtime/bin"), { recursive: true });
    await fs.copyFile(path.join(runtimeDir, "bin/node"), path.join(staging, "runtime/bin/node"));
    await fs.chmod(path.join(staging, "runtime/bin/node"), 0o755).catch(() => {});
    await fs.copyFile(path.join(runtimeDir, "LICENSE"), path.join(staging, "runtime/LICENSE"));
    await fs.writeFile(path.join(staging, ".installation"), MARKER);
    await validate(staging);
    if (exists) {
      const previous = await import(pathToFileURL(path.join(engine, "src/runtime.mjs")));
      await previous.stopWatchProcess({ state: null });
      backup = `${staging}-previous`;
      await fs.rename(engine, backup);
    }
    try {
      await fs.rename(staging, engine);
      staging = null;
      const user = await prepareUserData({ projectRoot: engine, dataRoot, enginePath: engine });
      const shortcuts = path.join(dataRoot, "启动入口");
      await fs.mkdir(shortcuts, { recursive: true });
      await ensurePrivateDir(shortcuts).catch(() => {});
      for (const [name, text] of Object.entries(launcherScripts(user.command))) {
        await fs.writeFile(path.join(shortcuts, name), text, { mode: 0o700 });
      }
      await fs.writeFile(path.join(shortcuts, "给豆包工作的提示词.txt"), `${agentPrompt(dataRoot)}\n`, { mode: 0o600 });
      try {
        await createDesktopShortcut(shortcuts, "豆包工作皮肤", desktopDir);
      } catch (error) { console.warn(`桌面入口未创建：${error.message}\n请手动打开：${shortcuts}`); }
      if (backup) {
        await fs.rm(backup, { recursive: true, force: true }).catch((error) => console.warn(`安装成功，旧版本备份未清理：${error.message}`));
        backup = null;
      }
      console.log(`已安装到：${dataRoot}\n个人皮肤和上次选择已保留。\n启动入口：${shortcuts}`);
      return { ...user, engine, shortcuts };
    } catch (error) {
      await fs.rm(engine, { recursive: true, force: true });
      if (backup) { await fs.rename(backup, engine); backup = null; }
      throw error;
    }
  } finally {
    if (staging) await fs.rm(staging, { recursive: true, force: true });
    await fs.rmdir(lock);
  }
}

if (process.argv[1] && (() => {
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})()) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--runtime-dir") {
    console.error("请双击安装皮肤.command，或由 Agent 执行该文件完成安装。");
    process.exitCode = 1;
  } else {
    install({ runtimeDir: path.resolve(args[1]) }).catch((error) => { console.error(`安装失败：${error.message}`); process.exitCode = 1; });
  }
}
