import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const defaultDataRoot = path.join(os.homedir(), "Library/Application Support/DoubaoWorkSkin");
export const defaultEnginePath = path.join(defaultDataRoot, "engine");

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function atomicWrite(file, text, mode = 0o600) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, text, { mode, flag: "wx" });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export async function prepareUserData({ projectRoot, dataRoot = defaultDataRoot, enginePath = path.join(dataRoot, "engine") } = {}) {
  const skinsDir = path.join(dataRoot, "skins");
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(dataRoot, 0o700);
  await fs.mkdir(skinsDir, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(path.join(projectRoot, "skins"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const destination = path.join(skinsDir, entry.name);
    // 已存在的目录（包括用户调整过的内置皮肤）绝不覆盖。
    if (await fs.lstat(destination).then(() => true, error => {
      if (error.code === "ENOENT") return false;
      throw error;
    })) continue;
    const temporary = await fs.mkdtemp(path.join(skinsDir, ".seed-"));
    try {
      await fs.cp(path.join(projectRoot, "skins", entry.name), temporary, { recursive: true });
      try {
        await fs.rename(temporary, destination);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      }
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }

  const node = path.join(enginePath, "runtime/bin/node");
  const bridge = path.join(enginePath, "scripts/installed-cli.mjs");
  const command = path.join(dataRoot, "skin");
  await atomicWrite(command, `#!/bin/sh\nunset NODE_OPTIONS NODE_PATH\nexport DWS_STATE_ROOT=${shellQuote(dataRoot)}\nexec ${shellQuote(node)} ${shellQuote(bridge)} "$@"\n`, 0o700);
  const sourceGuide = await fs.readFile(path.join(projectRoot, "AGENTS.md"), "utf8");
  const installedGuide = `# 已安装的脚本版皮肤工具：优先按本节操作

安装脚本已准备专用 Node.js，无需安装开发环境。

- 唯一命令入口：\`${command}\`。shell 中需正确引用完整路径。
- 将下文所有 \`node skin.mjs ...\` 替换成 \`${shellQuote(command)} ...\`。
- 将 \`npm run check\` 替换成 \`${shellQuote(command)} check\`。
- 个人皮肤目录：\`${skinsDir}\`。所有新建和调整在这里完成，不修改 engine 内的代码。
- 共享 CSS 和选择器只读参考：\`${path.join(enginePath, "src")}\`。
- 首次启用或需要重启时，请用户双击桌面“豆包工作皮肤”文件夹里的“启动豆包工作.command”。Agent 不执行 --force，也不运行此启动脚本代替用户确认。
- 重新安装或更新不会覆盖已有个人皮肤目录、状态和上次选择。新版本新增的内置皮肤会在安装时补入。
- v2.2.2 起加载器自动兼容旧主题的状态条和菜单规则；重新应用即可，无需改写个人主题文件。
- 完成应用后执行 \`verify <主题ID>\`。仅准备文件不能报告皮肤已生效。
- 本节替代下文源码版的环境检查、项目路径和双击 .command 说明；其余制作及安全规则仍适用。

---

${sourceGuide}`;
  await atomicWrite(path.join(dataRoot, "AGENTS.md"), installedGuide);
  return { dataRoot, skinsDir, command };
}

export function agentPrompt(dataRoot = defaultDataRoot) {
  return `请读取本机文件「${path.join(dataRoot, "AGENTS.md")}」，按其中的已安装版说明，先列出可用皮肤的中文名称，再帮我切换或制作皮肤。只有验证通过才报告成功；如果需要重启豆包工作，告诉我双击桌面“豆包工作皮肤”文件夹里的启动入口，不要在当前任务中重启应用。`;
}
