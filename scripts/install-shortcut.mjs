#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(root, "启动豆包工作.command");
const shortcut = path.join(os.homedir(), "Desktop", "豆包工作（皮肤启动）.command");

try {
  if (process.platform !== "darwin") throw new Error("桌面快捷方式仅支持 macOS");
  await fs.chmod(launcher, 0o755);
  try {
    await fs.symlink(launcher, shortcut);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const target = await fs.readlink(shortcut).catch(() => null);
    if (!target || path.resolve(path.dirname(shortcut), target) !== launcher) {
      throw new Error(`已有同名文件，未覆盖：${shortcut}`);
    }
  }
  console.log(`桌面快捷方式已就绪：${shortcut}`);
  console.log("双击进入已安装的皮肤启动入口；需要重启时会请求确认，请先保存工作。未安装时会提示先安装。");
  console.log("快捷方式依赖当前项目目录；移动项目后请删除旧快捷方式并重新安装。");
} catch (error) {
  console.error(`创建快捷方式失败：${error.message}`);
  process.exitCode = 1;
}
