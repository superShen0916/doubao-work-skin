#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const dist = path.join(root, "dist");

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

const COMMON_FILES = ["skin.mjs", "src", "skins", "README.md", "AGENTS.md", "CONTRIBUTING.md", "RELEASING.md", "SECURITY.md", "LICENSE", "package.json"];
const SCRIPT_FILES = ["install.mjs", "installed-cli.mjs"];

async function buildPayload(targetDir, platform) {
  await fs.mkdir(targetDir, { recursive: true });
  for (const name of COMMON_FILES) {
    await fs.cp(path.join(root, name), path.join(targetDir, name), { recursive: true });
  }
  await fs.mkdir(path.join(targetDir, "scripts"));
  for (const name of SCRIPT_FILES) {
    await fs.copyFile(path.join(root, "scripts", name), path.join(targetDir, "scripts", name));
  }
  if (platform === "macos") {
    for (const name of ["安装皮肤.command", "启动豆包工作.command"]) {
      await fs.copyFile(path.join(root, name), path.join(targetDir, name));
      await fs.chmod(path.join(targetDir, name), 0o755);
    }
    await fs.writeFile(path.join(targetDir, "先看这里.txt"), "首次使用：双击 安装皮肤.command，自动准备运行环境。\n装好后：在桌面“豆包工作皮肤”里双击启动入口。\n无需安装 Node.js、Git、Homebrew 或开发工具；首次安装需要联网。\n需要重启时请保存工作并等待当前 Agent 任务结束。\n更新：下载新版，重新双击安装文件；已有皮肤和偏好保留。\n");
  } else if (platform === "windows") {
    for (const name of ["安装皮肤.cmd", "安装皮肤.ps1"]) {
      await fs.copyFile(path.join(root, name), path.join(targetDir, name));
    }
    await fs.writeFile(path.join(targetDir, "先看这里.txt"), "首次使用：双击 安装皮肤.cmd，自动准备运行环境。\n装好后：在桌面“豆包工作皮肤”里双击启动入口。\n无需安装 Node.js、Git 或开发工具；首次安装需要联网。\n需要重启时请保存工作并等待当前 Agent 任务结束。\n更新：下载新版，重新双击安装文件；已有皮肤和偏好保留。\n");
  }
}

await fs.mkdir(dist, { recursive: true });
const temp = await fs.mkdtemp(path.join(dist, ".release-"));
try {
  // macOS 发布包（根目录保持 豆包工作皮肤/，与校验器一致）
  const macPayload = path.join(temp, "豆包工作皮肤");
  await buildPayload(macPayload, "macos");
  const macZip = path.join(dist, `DoubaoWorkSkin-${pkg.version}-macos-scripts.zip`);
  await fs.rm(macZip, { force: true });
  zipDirectory(macPayload, macZip);
  const macHash = createHash("sha256").update(await fs.readFile(macZip)).digest("hex");
  await fs.writeFile(`${macZip}.sha256`, `${macHash}  ${path.basename(macZip)}\n`);
  console.log(`已生成：${macZip}`);

  // Windows 发布包
  const winPayload = path.join(temp, "豆包工作皮肤-windows");
  await buildPayload(winPayload, "windows");
  const winZip = path.join(dist, `DoubaoWorkSkin-${pkg.version}-windows-scripts.zip`);
  await fs.rm(winZip, { force: true });
  zipDirectory(winPayload, winZip);
  const winHash = createHash("sha256").update(await fs.readFile(winZip)).digest("hex");
  await fs.writeFile(`${winZip}.sha256`, `${winHash}  ${path.basename(winZip)}\n`);
  console.log(`已生成：${winZip}`);

  // Skill 包（使用 macOS payload，因为 skill 主要在 macOS 上使用）
  const skill = path.join(temp, "doubao-work-skin");
  await fs.mkdir(path.join(skill, "assets"), { recursive: true });
  await fs.copyFile(path.join(root, "skills/doubao-work-skin/SKILL.md"), path.join(skill, "SKILL.md"));
  await fs.cp(macPayload, path.join(skill, "assets/project"), { recursive: true });
  const skillZip = path.join(dist, `doubao-work-skin-${pkg.version}-skill.zip`);
  await fs.rm(skillZip, { force: true });
  zipDirectory(skill, skillZip);
  const skillHash = createHash("sha256").update(await fs.readFile(skillZip)).digest("hex");
  await fs.writeFile(`${skillZip}.sha256`, `${skillHash}  ${path.basename(skillZip)}\n`);
  console.log(`Skill 包：${skillZip}`);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
