#!/usr/bin/env node
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareUserData, agentPrompt, defaultDataRoot } from "../src/user-data.mjs";

export async function main(args = process.argv.slice(2)) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dataRoot = process.env.DWS_STATE_ROOT || defaultDataRoot;
  const fs = await import("node:fs/promises");
  if (await fs.access(path.join(dataRoot, ".install-lock")).then(() => true, () => false)) throw new Error("安装或更新正在进行，请完成后再操作皮肤。");
  const user = await prepareUserData({ projectRoot, dataRoot });
  process.env.DWS_STATE_ROOT = dataRoot;
  process.env.DWS_SKINS_DIR = user.skinsDir;
  // 双击启动环境没有 Homebrew PATH；所有系统工具均来自 macOS。
  process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  const [command] = args;
  if (command === "prepare") return 0;
  if (command === "prompt") { console.log(agentPrompt(dataRoot)); return 0; }
  if (command === "check") {
    const { discoverThemes, loadTheme } = await import("../src/theme.mjs");
    const names = await discoverThemes();
    if (!names.length) throw new Error("未找到皮肤");
    for (const name of names) {
      const theme = await loadTheme({ name });
      console.log(`✓ ${theme.theme.name}`);
    }
    console.log(`${names.length} 套皮肤检查通过`);
    return 0;
  }
  if (command === "disable") {
    const { createCli } = await import("../skin.mjs");
    const { findDoubaoWorkPid, clearRuntimeState } = await import("../src/runtime.mjs");
    if (!await findDoubaoWorkPid()) {
      await createCli().stop({ keepAppearance: true });
      await clearRuntimeState();
      console.log("豆包工作已退出，皮肤后台已停止。下次正常打开即为官方外观。");
      return 0;
    }
    return createCli().stop();
  }
  return (await import("../skin.mjs")).main(args);
}

if (process.argv[1] && (() => {
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})()) {
  main().then(code => { process.exitCode = code || 0; }).catch(error => {
    console.error(error.code === "ENOENT" ? `文件不存在，请确认已安装豆包工作或重新运行安装皮肤.command。\n${error.message}` : error.message);
    process.exitCode = error.exitCode || 1;
  });
}
