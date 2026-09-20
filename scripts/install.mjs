#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { realpathSync } from "node:fs";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareUserData, shellQuote, agentPrompt, defaultDataRoot } from "../src/user-data.mjs";
import { DOUBAOWORK_PGREP_PATTERN } from "../src/app-identity.mjs";

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = "doubao-work-skin-script-install-v1";

export function launcherScripts(command) {
  const run = shellQuote(command);
  return {
    "启动豆包工作.command": `#!/bin/zsh
set -u
unset NODE_OPTIONS NODE_PATH
${run} start
result=$?
if (( result == 2 )); then
  if [[ ! -t 0 ]]; then
    print -u2 '需要重启。请保存工作后由用户双击此入口确认。'
    exit 2
  fi
  print '\n需要重启豆包工作。请保存工作，并等待 Agent 当前任务结束。'
  read -r 'answer?确认已保存并重启？输入 y 后回车，其他输入取消：'
  if [[ "$answer" == [yY] ]]; then
    ${run} start --force
    result=$?
  else
    print '已取消，豆包工作保持打开。'
  fi
fi
exit $result
`,
    "恢复官方外观.command": `#!/bin/zsh\nunset NODE_OPTIONS NODE_PATH\n${run} disable\n`,
    "复制换肤提示词.command": `#!/bin/zsh
set -eu
unset NODE_OPTIONS NODE_PATH
prompt_text="$(${run} prompt)"
print -rn -- "$prompt_text" | /usr/bin/pbcopy
print '已复制，粘贴到豆包工作对话即可。'
`,
  };
}

export function launcherApp({ command, version = "1.0.0", pgrepPattern = DOUBAOWORK_PGREP_PATTERN }) {
  const skin = shellQuote(command);
  const executable = `#!/bin/zsh
# 智能启动带皮肤的豆包工作：未运行直接启动，已运行则让 skin start 自己处理 CDP 检查和重启
set -u
unset NODE_OPTIONS NODE_PATH
SKIN=${skin}
DATA_ROOT="$(/usr/bin/dirname "$SKIN")"
LAUNCHER_LOG="$DATA_ROOT/app-launcher.log"
# 命令路径可通过环境变量覆盖（仅供测试 mock；生产环境使用系统绝对路径）
PGREP="\${DWS_TEST_PGREP:-/usr/bin/pgrep}"
OPEN="\${DWS_TEST_OPEN:-/usr/bin/open}"
# 1. 判断豆包工作是否在运行
if ! "$PGREP" -f "${pgrepPattern}" >/dev/null 2>&1; then
  # 未运行 → 直接启动带皮肤
  "$SKIN" start >> "$LAUNCHER_LOG" 2>&1
  result=$?
else
  # 已运行 → 让 skin start 自己处理（检查 CDP、复用或重启）
  "$SKIN" start >> "$LAUNCHER_LOG" 2>&1
  result=$?
  if (( result == 2 )); then
    # 需要重启带 CDP，直接 --force（不询问）
    "$SKIN" start --force >> "$LAUNCHER_LOG" 2>&1
    result=$?
  fi
fi
# 2. 启动成功后激活豆包工作窗口到前台
if (( result == 0 )); then
  "$OPEN" /Applications/DoubaoWork.app
fi
# 3. 启动失败时弹原生对话框提示用户（osascript 失败不影响退出码）
if (( result != 0 )); then
  /usr/bin/osascript -e "display dialog \\"豆包换肤启动失败（错误码 $result），请双击桌面\'豆包换肤\'里的启动入口查看原因，或查看日志：$LAUNCHER_LOG\\" buttons {\\"好\\"} default button 1 with title \\"豆包换肤\\"" >/dev/null 2>&1
fi
exit $result
`;
  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleInfoDictionaryVersion</key>
\t<string>6.0</string>
\t<key>CFBundleName</key>
\t<string>豆包换肤</string>
\t<key>CFBundleDisplayName</key>
\t<string>豆包换肤</string>
\t<key>CFBundleIdentifier</key>
\t<string>com.doubaowork.skin.launcher</string>
\t<key>CFBundleVersion</key>
\t<string>${version}</string>
\t<key>CFBundleShortVersionString</key>
\t<string>${version}</string>
\t<key>CFBundleExecutable</key>
\t<string>Launcher</string>
\t<key>CFBundleIconFile</key>
\t<string>AppIcon</string>
\t<key>CFBundlePackageType</key>
\t<string>APPL</string>
\t<key>LSMinimumSystemVersion</key>
\t<string>13.5</string>
\t<key>NSHighResolutionCapable</key>
\t<true/>
</dict>
</plist>
`;
  return { executable, infoPlist };
}

export async function createLauncherApp({ projectRoot, command, applicationsDir }) {
  const pkg = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  const version = pkg.version || "1.0.0";
  const appPath = path.join(applicationsDir, "豆包换肤.app");
  await fs.mkdir(applicationsDir, { recursive: true });
  // 已存在同名内容时，仅覆盖本项目创建的 App
  const existing = await fs.lstat(appPath).catch(() => null);
  if (existing) {
    let isOurs = false;
    try {
      const plist = await fs.readFile(path.join(appPath, "Contents/Info.plist"), "utf8");
      isOurs = plist.includes("com.doubaowork.skin.launcher");
    } catch {}
    if (!isOurs) throw new Error("~/Applications 已存在同名内容，未覆盖");
  }
  // 先在临时目录构建新 App，校验通过后再原子替换，避免构建失败丢失旧启动器
  const tempApp = await fs.mkdtemp(path.join(applicationsDir, ".app-new-"));
  try {
    await fs.mkdir(path.join(tempApp, "Contents/MacOS"), { recursive: true });
    await fs.mkdir(path.join(tempApp, "Contents/Resources"), { recursive: true });
    const app = launcherApp({ command, version });
    await fs.writeFile(path.join(tempApp, "Contents/Info.plist"), app.infoPlist, { mode: 0o644 });
    await fs.writeFile(path.join(tempApp, "Contents/MacOS/Launcher"), app.executable, { mode: 0o755 });
    await fs.chmod(path.join(tempApp, "Contents/MacOS/Launcher"), 0o755);
    const iconSource = path.join(projectRoot, "assets/AppIcon.icns");
    if (await fs.access(iconSource).then(() => true, () => false)) {
      await fs.copyFile(iconSource, path.join(tempApp, "Contents/Resources/AppIcon.icns"));
    }
    // 校验关键文件存在
    await fs.access(path.join(tempApp, "Contents/Info.plist"));
    await fs.access(path.join(tempApp, "Contents/MacOS/Launcher"));
    // 校验通过，原子替换：先备份旧 App，再替换，失败时恢复
    const backupPath = appPath + ".bak";
    if (existing) {
      await fs.rename(appPath, backupPath);
    }
    try {
      await fs.rename(tempApp, appPath);
    } catch (e) {
      if (existing) {
        await fs.rename(backupPath, appPath);
      }
      throw e;
    }
    if (existing) {
      await fs.rm(backupPath, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(tempApp, { recursive: true, force: true }).catch(() => {});
  }
  return appPath;
}

export async function install({
  projectRoot = ROOT,
  runtimeDir,
  dataRoot = process.env.DWS_STATE_ROOT || defaultDataRoot,
  desktopDir = process.env.DWS_DESKTOP_DIR || path.join(os.homedir(), "Desktop"),
  applicationsDir = process.env.DWS_APPLICATIONS_DIR || path.join(os.homedir(), "Applications"),
  validate = async engine => {
    const node = path.join(engine, "runtime/bin/node");
    await exec(node, ["--input-type=module", "-e", `
      import { discoverThemes, loadTheme } from './src/theme.mjs';
      if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 版本过低');
      for (const name of await discoverThemes()) await loadTheme({ name });
    `], { cwd: engine, env: { HOME: os.homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  },
} = {}) {
  if (!runtimeDir) throw new Error("缺少专用运行环境，请双击安装皮肤.command");
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
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
    const exists = await fs.lstat(engine).then(() => true, error => {
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
    await fs.chmod(path.join(staging, "runtime/bin/node"), 0o755);
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
      await fs.mkdir(shortcuts, { recursive: true, mode: 0o700 });
      for (const [name, text] of Object.entries(launcherScripts(user.command))) {
        await fs.writeFile(path.join(shortcuts, name), text, { mode: 0o700 });
        await fs.chmod(path.join(shortcuts, name), 0o700);
      }
      await fs.writeFile(path.join(shortcuts, "给豆包工作的提示词.txt"), `${agentPrompt(dataRoot)}\n`, { mode: 0o600 });
      try {
        await fs.mkdir(desktopDir, { recursive: true });
        const link = path.join(desktopDir, "豆包换肤");
        const existing = await fs.lstat(link).catch(error => { if (error.code === "ENOENT") return null; throw error; });
        if (!existing) await fs.symlink(shortcuts, link);
        else if (!existing.isSymbolicLink() || await fs.readlink(link) !== shortcuts) throw new Error("桌面已有同名内容，未覆盖");
      } catch (error) { console.warn(`桌面入口未创建：${error.message}\n请在 Finder 中打开：${shortcuts}`); }
      // 创建启动 App（~/Applications/豆包换肤.app），双击直接启动带皮肤的豆包工作，无需确认
      try {
        const appPath = await createLauncherApp({ projectRoot, command: user.command, applicationsDir });
        console.log(`已创建启动 App：${appPath}（可拖到 Dock）`);
      } catch (error) {
        console.warn(`启动 App 创建失败（不影响皮肤功能）：${error.message}\n请使用桌面“豆包换肤”里的“启动豆包工作.command”启动。`);
      }
      if (backup) {
        await fs.rm(backup, { recursive: true, force: true }).catch(error => console.warn(`安装成功，旧版本备份未清理：${error.message}`));
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
    install({ runtimeDir: path.resolve(args[1]) }).catch(error => { console.error(`安装失败：${error.message}`); process.exitCode = 1; });
  }
}
