#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const dist = path.join(root, "dist");
// 使用 UTF-8 文件名，兼容客户端用 Python/跨平台 ZIP 库导入技能。
// macOS ditto 写出的中文名称可被部分 ZIP 库按旧编码解读。
function zipDirectory(directory, output) {
  execFileSync("python3", ["-c", `
import pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(root.rglob('*')):
        if file.is_file():
            archive.write(file, file.relative_to(root.parent))
`, directory, output]);
}
await fs.mkdir(dist, { recursive: true });
const temp = await fs.mkdtemp(path.join(dist, ".release-"));
try {
  const payload = path.join(temp, "豆包换肤");
  await fs.mkdir(payload);
  for (const name of ["安装皮肤.command", "启动豆包工作.command", "skin.mjs", "src", "skins", "README.md", "AGENTS.md", "CONTRIBUTING.md", "RELEASING.md", "SECURITY.md", "LICENSE", "package.json"]) {
    await fs.cp(path.join(root, name), path.join(payload, name), { recursive: true });
  }
  // 发布包只包含安装所需的 .icns，源 PNG 不打包
  await fs.mkdir(path.join(payload, "assets"), { recursive: true });
  await fs.copyFile(path.join(root, "assets/AppIcon.icns"), path.join(payload, "assets/AppIcon.icns"));
  await fs.mkdir(path.join(payload, "scripts"));
  for (const name of ["install.mjs", "installed-cli.mjs"]) await fs.copyFile(path.join(root, "scripts", name), path.join(payload, "scripts", name));
  for (const name of ["安装皮肤.command", "启动豆包工作.command"]) await fs.chmod(path.join(payload, name), 0o755);
  await fs.writeFile(path.join(payload, "先看这里.txt"), "首次使用：双击 安装皮肤.command，自动准备运行环境。\n装好后：从启动台打开「豆包换肤」App（推荐，可拖到 Dock，无需确认），或在桌面“豆包换肤”里双击启动入口。\n无需安装 Node.js、Git、Homebrew 或开发工具；首次安装需要联网。\n需要重启时请保存工作并等待当前 Agent 任务结束。\n更新：下载新版，重新双击安装文件；已有皮肤和偏好保留。\n");
  const zip = path.join(dist, `DoubaoWorkSkin-${pkg.version}-macos-scripts.zip`);
  await fs.rm(zip, { force: true });
  zipDirectory(payload, zip);
  const hash = createHash("sha256").update(await fs.readFile(zip)).digest("hex");
  await fs.writeFile(`${zip}.sha256`, `${hash}  ${path.basename(zip)}\n`);
  console.log(`已生成：${zip}\nApple 芯片和 Intel 共用此包；安装时自动选择运行环境。`);
  const skill = path.join(temp, "doubao-work-skin");
  await fs.mkdir(path.join(skill, "assets"), { recursive: true });
  await fs.copyFile(path.join(root, "skills/doubao-work-skin/SKILL.md"), path.join(skill, "SKILL.md"));
  // 统一说明和程序从同一份发布内容复制，不维护第二份流程。
  await fs.cp(payload, path.join(skill, "assets/project"), { recursive: true });
  const skillZip = path.join(dist, `doubao-work-skin-${pkg.version}-skill.zip`);
  await fs.rm(skillZip, { force: true });
  zipDirectory(skill, skillZip);
  const skillHash = createHash("sha256").update(await fs.readFile(skillZip)).digest("hex");
  await fs.writeFile(`${skillZip}.sha256`, `${skillHash}  ${path.basename(skillZip)}\n`);
  console.log(`Skill 包：${skillZip}`);
} finally { await fs.rm(temp, { recursive: true, force: true }); }
