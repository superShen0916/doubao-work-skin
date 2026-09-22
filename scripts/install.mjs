#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { realpathSync } from "node:fs";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareUserData, agentPrompt, defaultDataRoot, shellQuote } from "../src/user-data.mjs";
import { DOUBAOWORK_PGREP_PATTERN } from "../src/app-identity.mjs";
import {
  launcherScripts as platformLauncherScripts,
  createDesktopShortcut,
  ensurePrivateDir,
  paths as platformPaths,
} from "../src/platform/index.mjs";

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = "doubao-work-skin-script-install-v1";
const IS_WIN = process.platform === "win32";
// M10：按平台给出正确的双击入口文案。
const INSTALLER_ENTRY = IS_WIN ? "安装皮肤.cmd" : "安装皮肤.command";

// ─── macOS 启动脚本（与 main v2.2.4 一致） ─────────────────

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
  if (( result != 0 )); then
    # 启动失败后用 --force 重试一次，由启动流程检查 CDP 并在需要时重启
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
  const existing = await fs.lstat(appPath).catch(() => null);
  if (existing) {
    let isOurs = false;
    try {
      const plist = await fs.readFile(path.join(appPath, "Contents/Info.plist"), "utf8");
      isOurs = plist.includes("com.doubaowork.skin.launcher");
    } catch {}
    if (!isOurs) throw new Error("~/Applications 已存在同名内容，未覆盖");
  }
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
    await fs.access(path.join(tempApp, "Contents/Info.plist"));
    await fs.access(path.join(tempApp, "Contents/MacOS/Launcher"));
    const backupPath = appPath + ".bak";
    if (existing) await fs.rename(appPath, backupPath);
    try {
      await fs.rename(tempApp, appPath);
    } catch (e) {
      if (existing) await fs.rename(backupPath, appPath);
      throw e;
    }
    if (existing) await fs.rm(backupPath, { recursive: true, force: true });
  } finally {
    await fs.rm(tempApp, { recursive: true, force: true }).catch(() => {});
  }
  return appPath;
}

// 纯平台安装计划：install() 按此执行，便于在 Windows 上对 darwin 计划做断言
function powershellExe() {
  const sysRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

// M8：升级 rename 前检查是否还有进程占用 engine 目录（旧换肤 watch 的 node.exe）。
// Windows 下文件被占用时 rename 会 EPERM；与其让 fs.rename 抛裸 EPERM，不如提前给出可操作的错误。
// 查询失败不阻塞安装（交由后续 rename 报错）。仅 Windows 生效。
async function isEngineInUse(enginePath) {
  if (!IS_WIN) return false;
  try {
    const escaped = enginePath.replace(/'/g, "''");
    const script = `
      $rows = Get-CimInstance Win32_Process | Where-Object {
        ($_.ExecutablePath -like '*node.exe') -and
        ($_.CommandLine -like '*${escaped}*') -and
        ($_.CommandLine -match 'injector|watch|skin\\.mjs|installed-cli|skin\\.cmd')
      }
      @($rows | Measure-Object).Count
    `;
    const { stdout } = await exec(powershellExe(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true, timeout: 10_000 });
    return Number(String(stdout).trim()) > 0;
  } catch {
    return false;
  }
}

async function waitForEngineFree(enginePath, { timeoutMs = 5_000 } = {}) {
  if (!IS_WIN) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await isEngineInUse(enginePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (await isEngineInUse(enginePath)) {
    // 超时后继续，rename 真失败时会报 EPERM（不阻塞测试/短生命周期进程）
  }
}

export function installTargets(platform, { shortcuts, engine, applicationsDir }) {
  if (platform === "win32") {
    return {
      launcherSource: "platform",
      desktop: {
        kind: "lnk",
        name: "豆包工作皮肤",
        target: path.join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "wscript.exe"),
        shortcutArguments: `"${path.join(shortcuts, "launcher.vbs")}" "${path.join(shortcuts, "启动豆包工作皮肤.ps1")}"`,
        iconPath: path.join(engine, "assets", "AppIcon.ico"),
        workingDir: shortcuts,
        legacyFolderPath: shortcuts,
        legacyCmdPath: path.join(shortcuts, "启动豆包工作.cmd"),
        legacyShortcuts: [{
          target: powershellExe(),
          file: path.join(shortcuts, "启动豆包工作皮肤.ps1"),
        }],
      },
      launcherApp: null,
      iconAsset: "assets/AppIcon.ico",
    };
  }
  return {
    launcherSource: "mac",
    desktop: { kind: "symlink", name: "豆包换肤", target: shortcuts },
    launcherApp: { applicationsDir, iconAsset: "assets/AppIcon.icns" },
    iconAsset: "assets/AppIcon.icns",
  };
}

export async function install({
  projectRoot = ROOT,
  runtimeDir,
  dataRoot = process.env.DWS_STATE_ROOT || defaultDataRoot,
  // H3：桌面目录统一走平台层（Windows 用 Known Folder [Environment]::GetFolderPath('Desktop')），
  // 不再在这里自己拼 os.homedir()/Desktop。DWS_DESKTOP_DIR 仍可覆盖（测试用）。
  desktopDir = process.env.DWS_DESKTOP_DIR || platformPaths().desktopDir,
  applicationsDir = process.env.DWS_APPLICATIONS_DIR || path.join(os.homedir(), "Applications"),
  validate = async (engine) => {
    const node = IS_WIN
      ? path.join(engine, "runtime/node.exe")
      : path.join(engine, "runtime/bin/node");
    const validateEnv = IS_WIN
      ? { ...process.env }
      : { HOME: os.homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
    await exec(node, ["--input-type=module", "-e", `
      import { discoverThemes, loadTheme } from './src/theme.mjs';
      if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 版本过低');
      for (const name of await discoverThemes()) await loadTheme({ name });
    `], { cwd: engine, env: validateEnv });
  },
} = {}) {
  if (!runtimeDir) throw new Error(`缺少专用运行环境，请双击${INSTALLER_ENTRY}`);
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
    if (await fs.access(path.join(projectRoot, "assets")).then(() => true, () => false)) {
      await fs.cp(path.join(projectRoot, "assets"), path.join(staging, "assets"), { recursive: true });
    }
    await fs.mkdir(path.join(staging, "scripts"));
    await fs.copyFile(path.join(projectRoot, "scripts/installed-cli.mjs"), path.join(staging, "scripts/installed-cli.mjs"));
    if (IS_WIN) {
      await fs.mkdir(path.join(staging, "runtime"), { recursive: true });
      await fs.copyFile(path.join(runtimeDir, "node.exe"), path.join(staging, "runtime/node.exe"));
    } else {
      await fs.mkdir(path.join(staging, "runtime/bin"), { recursive: true });
      await fs.copyFile(path.join(runtimeDir, "bin/node"), path.join(staging, "runtime/bin/node"));
      await fs.chmod(path.join(staging, "runtime/bin/node"), 0o755).catch(() => {});
    }
    await fs.copyFile(path.join(runtimeDir, "LICENSE"), path.join(staging, "runtime/LICENSE"));
    await fs.writeFile(path.join(staging, ".installation"), MARKER);
    await validate(staging);
    if (exists) {
      const previous = await import(pathToFileURL(path.join(engine, "src/runtime.mjs")));
      await previous.stopWatchProcess({ state: null });
      // M8：rename 前确认没有进程占用 engine（Windows 文件锁导致 EPERM）。
      await waitForEngineFree(engine);
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
      const plan = installTargets(process.platform, { shortcuts, engine, applicationsDir });
      const scripts = plan.launcherSource === "platform" ? platformLauncherScripts(user.command, dataRoot) : launcherScripts(user.command);
      for (const [name, text] of Object.entries(scripts)) {
        // PowerShell 5.1 读取无 BOM 的 .ps1 按 ANSI 解析，中文会乱码导致语法错误；写 UTF-8 BOM
        const content = name.endsWith(".ps1") ? "\uFEFF" + text : text;
        await fs.writeFile(path.join(shortcuts, name), content, { mode: 0o700 });
        if (plan.launcherSource === "mac") await fs.chmod(path.join(shortcuts, name), 0o700);
      }
      await fs.writeFile(path.join(shortcuts, "给豆包工作的提示词.txt"), `${agentPrompt(dataRoot)}\n`, { mode: 0o600 });
      if (plan.desktop.kind === "lnk") {
        try {
          await createDesktopShortcut(plan.desktop.target, plan.desktop.name, desktopDir, {
            iconPath: plan.desktop.iconPath,
            description: "启动带皮肤的豆包工作",
            workingDir: plan.desktop.workingDir,
            legacyFolderPath: plan.desktop.legacyFolderPath,
            legacyCmdPath: plan.desktop.legacyCmdPath,
            legacyShortcuts: plan.desktop.legacyShortcuts,
            shortcutArguments: plan.desktop.shortcutArguments,
          });
        } catch (error) { console.warn(`桌面入口未创建：${error.message}\n请手动打开：${shortcuts}`); }
      } else {
        try {
          await fs.mkdir(desktopDir, { recursive: true });
          const link = path.join(desktopDir, plan.desktop.name);
          const existingLink = await fs.lstat(link).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
          if (!existingLink) await fs.symlink(shortcuts, link);
          else if (!existingLink.isSymbolicLink() || await fs.readlink(link) !== shortcuts) throw new Error("桌面已有同名内容，未覆盖");
        } catch (error) { console.warn(`桌面入口未创建：${error.message}\n请在 Finder 中打开：${shortcuts}`); }
        if (plan.launcherApp) {
          try {
            const appPath = await createLauncherApp({ projectRoot, command: user.command, applicationsDir: plan.launcherApp.applicationsDir });
            console.log(`已创建启动 App：${appPath}（可拖到 Dock）`);
          } catch (error) {
            console.warn(`启动 App 创建失败（不影响皮肤功能）：${error.message}\n请使用桌面"${plan.desktop.name}"里的"启动豆包工作.command"启动。`);
          }
        }
      }
      if (backup) {
        await fs.rm(backup, { recursive: true, force: true }).catch((error) => console.warn(`安装成功，旧版本备份未清理：${error.message}`));
        backup = null;
      }
      console.log(`已安装到：${dataRoot}\n个人皮肤和上次选择已保留。\n启动入口：${shortcuts}`);
      return { ...user, engine, shortcuts };
    } catch (error) {
      await fs.rm(engine, { recursive: true, force: true });
      if (backup) {
        // M8：恢复旧版本失败时不要静默丢弃备份，保留在磁盘上供人工核对。
        try {
          await fs.rename(backup, engine);
        } catch (restoreError) {
          console.warn(`旧版本自动恢复失败，备份仍保留在：${backup}\n请手动核对后恢复。`);
        }
        backup = null;
      }
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
    console.error(`请双击${INSTALLER_ENTRY}，或由 Agent 执行该文件完成安装。`);
    process.exitCode = 1;
  } else {
    install({ runtimeDir: path.resolve(args[1]) }).catch((error) => { console.error(`安装失败：${error.message}`); process.exitCode = 1; });
  }
}
