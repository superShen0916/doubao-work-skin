#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const dist = path.join(root, "dist");

// 跨平台找 python：优先 python3，回退 python
function pythonBin() {
  for (const bin of ["python3", "python"]) {
    try { execFileSync(bin, ["--version"], { stdio: "ignore" }); return bin; }
    catch {}
  }
  throw new Error("需要 python3 或 python 来写 ZIP（标准库 zipfile）");
}

function zipDirectory(directory, output) {
  execFileSync(pythonBin(), ["-c", `
import pathlib, sys, zipfile, stat
root = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(root.rglob('*')):
        if file.is_file():
            arc = file.relative_to(root.parent).as_posix()
            info = zipfile.ZipInfo.from_file(file, arc)
            executable = arc.endswith('.command') or arc.endswith('.sh')
            # Windows 构建机没有可复用的 Unix mode；显式写入 Unix 普通文件类型和权限。
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | (0o755 if executable else 0o644)) << 16
            with open(file, 'rb') as fh:
                archive.writestr(info, fh.read(), zipfile.ZIP_DEFLATED)
`, directory, output]);
}

await fs.mkdir(dist, { recursive: true });
const temp = await fs.mkdtemp(path.join(dist, ".release-"));
try {
  // ─── macOS 包 ───
  const mac = path.join(temp, "豆包换肤");
  await fs.mkdir(mac);
  for (const name of ["安装皮肤.command", "启动豆包工作.command", "skin.mjs", "src", "skins", "README.md", "AGENTS.md", "CONTRIBUTING.md", "RELEASING.md", "SECURITY.md", "LICENSE", "package.json"]) {
    await fs.cp(path.join(root, name), path.join(mac, name), { recursive: true });
  }
  await fs.mkdir(path.join(mac, "assets"), { recursive: true });
  await fs.copyFile(path.join(root, "assets/AppIcon.icns"), path.join(mac, "assets/AppIcon.icns"));
  await fs.mkdir(path.join(mac, "scripts"));
  for (const name of ["install.mjs", "installed-cli.mjs"]) await fs.copyFile(path.join(root, "scripts", name), path.join(mac, "scripts", name));
  for (const name of ["安装皮肤.command", "启动豆包工作.command"]) await fs.chmod(path.join(mac, name), 0o755);
  await fs.writeFile(path.join(mac, "先看这里.txt"), "首次使用：双击 安装皮肤.command，自动准备运行环境。\n装好后：从启动台打开「豆包换肤」App（推荐，可拖到 Dock，无需确认），或在桌面“豆包换肤”里双击启动入口。\n无需安装 Node.js、Git、Homebrew 或开发工具；首次安装需要联网。\n需要重启时请保存工作并等待当前 Agent 任务结束。\n更新：下载新版，重新双击安装文件；已有皮肤和偏好保留。\n");
  const macZip = path.join(dist, `DoubaoWorkSkin-${pkg.version}-macos-scripts.zip`);
  await fs.rm(macZip, { force: true });
  zipDirectory(mac, macZip);
  const macHash = createHash("sha256").update(await fs.readFile(macZip)).digest("hex");
  await fs.writeFile(`${macZip}.sha256`, `${macHash}  ${path.basename(macZip)}\n`);
  console.log(`已生成：${macZip}`);

  // ─── Windows 包 ───
  const win = path.join(temp, "win-payload", "豆包换肤");
  await fs.mkdir(win, { recursive: true });
  for (const name of ["安装皮肤.cmd", "安装皮肤.ps1", "skin.mjs", "src", "skins", "README.md", "AGENTS.md", "CONTRIBUTING.md", "RELEASING.md", "SECURITY.md", "LICENSE", "package.json"]) {
    await fs.cp(path.join(root, name), path.join(win, name), { recursive: true });
  }
  await fs.mkdir(path.join(win, "assets"), { recursive: true });
  await fs.copyFile(path.join(root, "assets/AppIcon.ico"), path.join(win, "assets/AppIcon.ico"));
  await fs.mkdir(path.join(win, "scripts"));
  for (const name of ["install.mjs", "installed-cli.mjs"]) await fs.copyFile(path.join(root, "scripts", name), path.join(win, "scripts", name));
  await fs.writeFile(path.join(win, "先看这里.txt"), "首次使用：解压后双击 安装皮肤.cmd，按提示操作（会自动准备运行环境，需要联网）。\n装好后：保存工作并等待当前任务结束，再从桌面双击「豆包工作皮肤」；双击即授权本次换肤重启，成功后会尝试把应用窗口切到前台。\n全程无需输入 y，也不会显示终端黑框；失败时会弹窗并保留 launcher.log。\n更新：下载新版重新解压并双击 安装皮肤.cmd；已有皮肤和偏好保留。\n支持范围：Windows 10/11 桌面版（x64），Microsoft Store 版与 ARM64 未实测。\n");
  const winZip = path.join(dist, `DoubaoWorkSkin-${pkg.version}-windows-scripts.zip`);
  await fs.rm(winZip, { force: true });
  zipDirectory(win, winZip);
  const winHash = createHash("sha256").update(await fs.readFile(winZip)).digest("hex");
  await fs.writeFile(`${winZip}.sha256`, `${winHash}  ${path.basename(winZip)}\n`);
  console.log(`已生成：${winZip}`);

  // ─── Skill 包：跨平台完整 project（两套入口 + icns/ico） ───
  const skill = path.join(temp, "doubao-work-skin");
  await fs.mkdir(path.join(skill, "assets"), { recursive: true });
  await fs.copyFile(path.join(root, "skills/doubao-work-skin/SKILL.md"), path.join(skill, "SKILL.md"));
  const skillProject = path.join(skill, "assets/project");
  await fs.mkdir(skillProject, { recursive: true });
  for (const name of ["安装皮肤.command", "安装皮肤.cmd", "安装皮肤.ps1", "启动豆包工作.command", "skin.mjs", "src", "skins", "README.md", "AGENTS.md", "CONTRIBUTING.md", "RELEASING.md", "SECURITY.md", "LICENSE", "package.json"]) {
    await fs.cp(path.join(root, name), path.join(skillProject, name), { recursive: true });
  }
  await fs.mkdir(path.join(skillProject, "assets"), { recursive: true });
  if (await fs.access(path.join(root, "assets/AppIcon.icns")).then(() => true, () => false)) {
    await fs.copyFile(path.join(root, "assets/AppIcon.icns"), path.join(skillProject, "assets/AppIcon.icns"));
  }
  if (await fs.access(path.join(root, "assets/AppIcon.ico")).then(() => true, () => false)) {
    await fs.copyFile(path.join(root, "assets/AppIcon.ico"), path.join(skillProject, "assets/AppIcon.ico"));
  }
  await fs.mkdir(path.join(skillProject, "scripts"), { recursive: true });
  for (const name of ["install.mjs", "installed-cli.mjs"]) await fs.copyFile(path.join(root, "scripts", name), path.join(skillProject, "scripts", name));
  const skillZip = path.join(dist, `doubao-work-skin-${pkg.version}-skill.zip`);
  await fs.rm(skillZip, { force: true });
  zipDirectory(skill, skillZip);
  const skillHash = createHash("sha256").update(await fs.readFile(skillZip)).digest("hex");
  await fs.writeFile(`${skillZip}.sha256`, `${skillHash}  ${path.basename(skillZip)}\n`);
  console.log(`Skill 包：${skillZip}`);
} finally { await fs.rm(temp, { recursive: true, force: true }); }
