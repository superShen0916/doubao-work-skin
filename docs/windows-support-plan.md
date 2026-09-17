# Windows 版支持方案

> 分支：`windows-support` | 状态：方案设计阶段
> 目标：在不破坏现有 macOS 功能的前提下，让豆包工作皮肤工具完整支持 Windows 桌面端。

---

## 1. 背景与目标

### 1.1 现状

当前项目（v2.2.0）是纯 macOS 实现，核心假设包括：

- 应用安装在 `/Applications/DoubaoWork.app`
- 系统工具为 `ps` / `lsof` / `pgrep` / `shasum` / `tar` / `pbcopy`
- 用户数据目录为 `~/Library/Application Support/DoubaoWorkSkin`
- 安装入口为 zsh `.command` 脚本
- Node.js 运行时为 darwin 二进制（arm64 / x64）
- 进程信号为 POSIX（SIGTERM / SIGKILL）
- 文件权限模型为 Unix（chmod 0o700 / 0o600）

### 1.2 目标

1. **功能对等**：Windows 上实现与 macOS 完全一致的换肤、验证、恢复、自定义主题能力。
2. **零开发依赖**：Windows 用户双击安装脚本即可完成，无需预装 Node.js、Git 或任何开发工具。
3. **代码复用**：通过平台抽象层复用核心逻辑（CDP 注入、主题加载、状态管理），平台差异收敛到独立模块。
4. **向后兼容**：macOS 行为不变，现有测试全部通过；不引入 breaking change。
5. **安全对等**：Windows 上保持同样的端口归属校验、进程身份验证和最小权限原则。

### 1.3 非目标

- 不支持 Windows 7 / 8（仅 Windows 10 1903+ 和 Windows 11）。
- 不支持通过 Microsoft Store 安装的豆包工作版本（如有，后续单独适配）。
- 不在本阶段做 GUI 安装程序（保持脚本安装，与 macOS 一致）。
- 不修改豆包工作应用本身。

---

## 2. 现状分析：macOS 特定点全清单

按模块梳理所有需要适配的平台差异点。

### 2.1 `src/app-identity.mjs`（高优先级）

| 点 | macOS 现状 | Windows 适配 |
|---|---|---|
| 应用二进制路径 | 硬编码 `/Applications/DoubaoWork.app/Contents/MacOS/DoubaoWork` | 需要探测常见安装路径（见 3.2） |
| Helper 二进制路径 | 硬编码 `.../Helpers/DoubaoWork Browser.app/Contents/MacOS/DoubaoWork Browser` | Windows 版通常为 `DoubaoWork.exe` + 多个 `DoubaoWork Helper.exe` |
| 端口归属校验 | `lsof -nP -iTCP:PORT -sTCP:LISTEN -Fp` + `ps -p PID -o comm=` | `netstat -ano \| findstr :PORT` 取 PID → `tasklist /FI "PID eq N"` 验证映像名 |

### 2.2 `src/runtime.mjs`（高优先级）

| 点 | macOS 现状 | Windows 适配 |
|---|---|---|
| 状态目录 | `~/Library/Application Support/DoubaoWorkSkin` | `%APPDATA%\DoubaoWorkSkin`（即 `os.homedir()/AppData/Roaming/DoubaoWorkSkin`） |
| `findDoubaoWorkPid` | `pgrep -f "DoubaoWork.app/Contents/MacOS/DoubaoWork"` | `tasklist /FI "IMAGENAME eq DoubaoWork.exe"` 或通过 CDP 端口反查 |
| `findDoubaoWorkBrowserPids` | `ps -axo pid=,command=` 匹配 Helper 路径 | `tasklist /FI "IMAGENAME eq DoubaoWork Helper.exe"` |
| `defaultInspectProcess` | `ps -p PID -o command=` + `lsof -a -p PID -d cwd -Fn` | `wmic process where ProcessId=PID get CommandLine,ExecutablePath` 或 PowerShell `Get-CimInstance` |
| `findOwnedWatchProcesses` | `ps -axo pid=,command=` 过滤 `injector.mjs --watch` | `tasklist /FI "IMAGENAME eq node.exe"` + `wmic` 取命令行过滤 |
| `stopDoubaoWork` | `process.kill(pid, SIGTERM)` → SIGKILL | `taskkill /PID N /T`（/T 终止子进程树）；Node 的 `process.kill` 在 Windows 上 SIGTERM 映射为 `TerminateProcess`，不优雅 |
| `stopWatchProcess` | SIGTERM → SIGKILL | 同上，用 `taskkill /PID N /T` |
| `launchDoubaoWork` | `spawn(binary, [--remote-debugging-port=...])` detached | 路径不同；Windows 上 `spawn` detached + `unref` 行为有差异，需验证 |
| `spawnWatchProcess` | `spawn(node, [injector, --watch...])` detached | 同上；Windows 上 detached 进程需要 `windowsHide: true` |
| `isProcessAlive` | `process.kill(pid, 0)` | Windows 上 `process.kill(pid, 0)` 可用，但对已退出进程可能抛 EPERM；需配合 `tasklist` 二次确认 |
| 文件权限 | `chmod 0o700` / `0o600` | Windows 无对应概念；`fs.chmod` 在 Windows 上只影响只读位，应跳过或用 ACL（可选） |

### 2.3 `src/user-data.mjs`（高优先级）

| 点 | macOS 现状 | Windows 适配 |
|---|---|---|
| `defaultDataRoot` | `~/Library/Application Support/DoubaoWorkSkin` | `%APPDATA%\DoubaoWorkSkin` |
| `shellQuote` | POSIX 单引号转义 `'...'` + `'\''` | Windows 需要双引号转义或直接用 `child_process` 传数组（不经过 shell） |
| `skin` 命令入口 | 生成 `#!/bin/sh` 脚本 | 生成 `skin.cmd`（Windows 批处理）或 `skin.bat` |
| `prepareUserData` | `fs.chmod(dataRoot, 0o700)` | Windows 跳过 chmod |

### 2.4 `scripts/install.mjs`（高优先级）

| 点 | macOS 现状 | Windows 适配 |
|---|---|---|
| 启动脚本生成 | 生成 zsh `.command` 文件（启动/恢复/复制提示词） | 生成 `.cmd` / `.bat` 批处理文件 |
| 剪贴板 | `/usr/bin/pbcopy` | `clip.exe`（Windows 自带） |
| 桌面入口 | `fs.symlink(shortcuts, 桌面/豆包工作皮肤)` | Windows 符号链接需要管理员权限；改用创建 `.lnk` 快捷方式（PowerShell COM `WScript.Shell`）或直接在桌面创建文件夹快捷方式 |
| Node runtime | 复制 `runtime/bin/node`（darwin 二进制） | 复制 `runtime/node.exe`（win-x64 二进制） |
| `validate` | 用 darwin node 执行校验 | 用 win node 执行校验 |
| PATH 环境 | 不涉及 | 安装脚本需确保能找到系统工具 |

### 2.5 `安装皮肤.command`（高优先级）

macOS 安装入口是 zsh 脚本，Windows 需要对应的 `安装皮肤.cmd`：

| 功能 | macOS 实现 | Windows 实现 |
|---|---|---|
| Shell | zsh | cmd.exe 批处理（或 PowerShell `.ps1`） |
| 架构检测 | `uname -m`（arm64/x86_64） | `%PROCESSOR_ARCHITECTURE%`（AMD64/ARM64） |
| 系统版本 | `sw_vers -productVersion` ≥ 13.5 | `ver` 或 PowerShell `[Environment]::OSVersion` ≥ 10.0.18362 |
| 应用存在性检查 | `[[ -d /Applications/DoubaoWork.app ]]` | 检查常见路径下 `DoubaoWork.exe` 是否存在 |
| 下载 | `curl --fail --location` | Windows 10 1803+ 自带 `curl.exe`；或用 PowerShell `Invoke-WebRequest` |
| 校验 | `shasum -a 256` | `certutil -hashfile FILE SHA256` 或 PowerShell `Get-FileHash` |
| 解压 | `tar -xzf` | Windows 10 1803+ 自带 `tar.exe`；或 PowerShell `Expand-Archive`（仅 zip） |
| Node 包格式 | `node-vXX-darwin-arm64.tar.gz` | `node-vXX-win-x64.zip` |
| 运行安装 | `$runtime_dir/bin/node scripts/install.mjs` | `%runtime_dir%\node.exe scripts\install.mjs` |

**方案选择**：使用 **PowerShell `.ps1` 脚本** 作为 Windows 安装入口，而非 cmd 批处理。原因：
- PowerShell 在 Windows 10/11 上默认可用（5.1+）
- 内置 `Invoke-WebRequest`、`Get-FileHash`、`Expand-Archive`，无需依赖 curl/tar/certutil
- 字符串处理和错误处理远优于 cmd
- 可以直接调用 Node.js 执行 `.mjs`

但需注意：默认 PowerShell 执行策略可能阻止 `.ps1` 运行。解决方案：
- 提供 `安装皮肤.cmd` 作为入口，内部用 `powershell -ExecutionPolicy Bypass -File 安装皮肤.ps1` 调用
- 用户双击 `.cmd` 即可，无需手动改执行策略

### 2.6 `启动豆包工作.command`（高优先级）

同理，Windows 需要 `启动豆包工作.cmd`，内部调用已安装的 `skin.cmd start`，并处理重启确认逻辑。

### 2.7 `scripts/installed-cli.mjs`（中优先级）

| 点 | macOS 现状 | Windows 适配 |
|---|---|---|
| PATH 硬编码 | `process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin"` | Windows 上不应覆盖 PATH（系统工具在 `C:\Windows\System32` 等，用户 PATH 可能包含必要路径）；改为不修改 PATH 或仅追加系统目录 |
| `disable` 命令 | 调用 `findDoubaoWorkPid` + `stop` | 平台抽象后自动适配 |

### 2.8 `src/injector.mjs`（中优先级）

| 点 | macOS 现状 | Windows 适配 |
|---|---|---|
| 退出信号 | `process.on("SIGINT", ...)` / `SIGTERM` | Windows 上没有 SIGINT（Ctrl+C 触发的是 `SIGINT`，Node 支持），但 `taskkill` 发送的是 `CTRL_BREAK_EVENT` 或直接终止；需同时监听 `SIGBREAK` |
| `watchFs` | `fs.watch(skinDir, { recursive: true })` | Windows 上 `recursive: true` 可用（Node 14+ 在 Windows 支持），但事件触发频率和可靠性有差异，需测试 |

### 2.9 `scripts/build-release.mjs`（中优先级）

| 点 | macOS 现状 | Windows 适配 |
|---|---|---|
| 打包 | 仅生成 `DoubaoWorkSkin-<ver>-macos-scripts.zip` | 新增 `DoubaoWorkSkin-<ver>-windows-scripts.zip` |
| 包含文件 | `.command` 脚本 + macOS 说明 | Windows 包包含 `.cmd` / `.ps1` 脚本 + Windows 说明 |
| Skill 包 | 包含 macOS 项目 | Skill 包应同时包含两个平台的脚本（或分平台） |
| ZIP 工具 | `python3` + `zipfile` | 保持不变（Python 跨平台） |

### 2.10 `scripts/check.mjs`（低优先级）

- 目前检查 `.mjs` 语法、JSON、主题 PNG。跨平台无差异，无需修改。
- 但 `execFileSync(process.execPath, ["--check", file])` 在 Windows 上可用。

### 2.11 `scripts/install-shortcut.mjs`（低优先级）

- 目前硬编码 `process.platform !== "darwin"` 报错。
- Windows 适配：创建桌面 `.lnk` 快捷方式（PowerShell COM）。
- 此脚本是源码模式的可选工具，优先级低。

### 2.12 `scripts/diagnose.mjs`（低优先级）

- 纯 CDP 操作，跨平台无差异。

### 2.13 `AGENTS.md` / `README.md` / `CONTRIBUTING.md`（文档）

- 需要新增 Windows 平台的安装、切换、验证、恢复说明。
- AGENTS.md 中所有 macOS 特定命令需要标注平台或提供 Windows 对应命令。
- README 的"快速开始"需要增加 Windows 段落。

### 2.14 CI（`.github/workflows/ci.yml`）

- 目前仅 `macos-latest`。
- 需要增加 `windows-latest` 矩阵，运行 `npm run check` 和 `npm test`。
- 注意：Windows 上测试可能需要调整（路径分隔符、权限等）。

---

## 3. 整体架构设计

### 3.1 平台抽象层

核心思路：**将所有平台差异收敛到 `src/platform/` 目录，通过 `process.platform` 动态选择实现**。核心模块（`skin.mjs`、`injector.mjs`、`theme.mjs`、`cdp.mjs`）不直接调用平台特定 API。

```
src/
├── platform/
│   ├── index.mjs          # 统一导出，根据 process.platform 选择实现
│   ├── types.mjs          # 类型定义（JSDoc）
│   ├── darwin.mjs         # macOS 实现（从现有代码迁移）
│   └── win32.mjs          # Windows 实现（新增）
├── app-identity.mjs       # 改为调用 platform 层
├── runtime.mjs            # 改为调用 platform 层
├── user-data.mjs          # 改为调用 platform 层
├── cdp.mjs                # 不变
├── injector.mjs           # 信号处理微调
├── theme.mjs              # 不变
└── base.css               # 不变
```

### 3.2 平台层接口定义

`src/platform/types.mjs`（JSDoc 接口）：

```javascript
/**
 * @typedef {Object} PlatformPaths
 * @property {string} dataRoot        - 用户数据目录（macOS: ~/Library/Application Support/DoubaoWorkSkin; Windows: %LOCALAPPDATA%\DoubaoWorkSkin）
 * @property {string} defaultSkinsDir - 默认皮肤目录
 * @property {string} desktopDir      - 桌面目录
 */

/**
 * 应用安装信息——统一描述 Store 版和桌面版
 * @typedef {Object} AppInstall
 * @property {'store'|'desktop'} type       - 安装类型
 * @property {string} mainBinary            - 主程序可执行文件绝对路径
 * @property {string} helperBinary          - Helper 可执行文件名（用于进程识别，如 "DoubaoWork Helper.exe"）
 * @property {string} [packageFamilyName]   - Store 包家族名（仅 store 类型）
 * @property {string} [applicationId]       - Store 应用 ID（仅 store 类型）
 * @property {string} [appUserModelId]      - Store 启动标识符 = PackageFamilyName!ApplicationId（仅 store 类型）
 * @property {string} [version]             - 应用版本
 */

/**
 * @typedef {Object} PlatformApi
 * @property {() => PlatformPaths} paths
 * @property {() => Promise<AppInstall|null>} discoverAppInstall  - 探测已安装的豆包工作（优先运行中进程，然后 Store，然后桌面路径）
 * @property {(install: AppInstall, port: number) => Promise<number>} launchApp  - 启动应用并返回 PID；Store 版用 IApplicationActivationManager，桌面版直接 spawn
 * @property {(port: number) => Promise<number[]>} findListeningPids
 * @property {(pid: number) => Promise<string>} getProcessExecutable
 * @property {(pid: number) => Promise<{command: string, cwd: string|null}>} inspectProcess
 * @property {(exeNames: string[]) => Promise<{pid: number, command: string}[]>} listProcessesByName
 * @property {(pid: number) => Promise<boolean>} isProcessAlive
 * @property {(pid: number) => Promise<void>} terminateProcess   - 优雅终止（taskkill /PID）
 * @property {(pid: number) => Promise<void>} killProcessTree    - 强制终止进程树（taskkill /PID /F /T）
 * @property {(command: string) => string} shellQuote
 * @property {() => string} getCliEntryContent   - 生成 skin 命令入口脚本内容
 * @property {() => Object<string,string>} launcherScripts   - 生成启动/恢复/复制提示词脚本
 * @property {(targetPath: string, linkName: string) => Promise<void>} createDesktopShortcut  - 创建桌面快捷方式
 */
```

### 3.3 Windows 应用定位与启动策略（核心设计）

豆包工作 Windows 版有两种分发形态，定位和启动方式完全不同：

| 形态 | 安装位置 | 启动方式 | CDP 兼容性 |
|---|---|---|---|
| **Microsoft Store 版** (MSIX) | `C:\Program Files\WindowsApps\<PackageFamilyName>\` | `IApplicationActivationManager.ActivateApplication` | 不确定——可能吃掉 `--remote-debugging-port` 参数 |
| **桌面 EXE 版** | `%LOCALAPPDATA%\Programs\DoubaoWork\` 或 `%PROGRAMFILES%\DoubaoWork\` | 直接 `spawn(exe, args)` | 可靠——Electron 标准行为 |

> 参考：Codex Dream Skin（同类 CDP 换肤项目，11k+ stars）在 Windows 上面临完全相同的问题。Codex 是纯 Store 应用，它通过 `Get-AppxPackage` 定位，用 `IApplicationActivationManager` 启动，并发现 Store 激活会把 CDP 参数转换成 `codex://` 导航，需要回退到直接启动 exe。

#### 应用定位：三级策略（按优先级）

```
第一级：运行中进程反查（最准确，零猜测）
  - 如果豆包工作正在运行，通过进程名或已有 CDP 端口找到 PID
  - Get-CimInstance Win32_Process 拿 ExecutablePath
  - 从路径自动判断是 Store 版（含 WindowsApps）还是桌面版
  - Store 版同时从进程拿 PackageFamilyName（通过 Get-AppxPackage 反查）

第二级：Store 包探测
  - Get-AppxPackage -Name '*doubao*' 或 '*春田*'
  - 从 manifest 拿 InstallLocation + Executable + ApplicationId
  - 验证 SignatureKind -eq 'Store'，排除开发模式包
  - 拼出 AppUserModelId = PackageFamilyName!ApplicationId

第三级：桌面安装路径探测
  - %LOCALAPPDATA%\Programs\DoubaoWork\DoubaoWork.exe
  - %LOCALAPPDATA%\Programs\豆包工作\DoubaoWork.exe
  - %LOCALAPPDATA%\DoubaoWork\app-*\DoubaoWork.exe（Squirrel 模式）
  - %PROGRAMFILES%\DoubaoWork\DoubaoWork.exe
  - %PROGRAMFILES(X86)%\DoubaoWork\DoubaoWork.exe

兜底：环境变量 DWS_APP_PATH=C:\custom\path\DoubaoWork.exe
```

**多版本共存时的选择规则**：
1. 正在运行的版本优先（用户当前在用的）
2. 都没运行时，**桌面版优先**（CDP 兼容性更可靠）
3. 只有 Store 版时，使用 Store 版但需额外验证 CDP 可用性

#### 应用启动：双轨制 + CDP 验证闭环

**桌面版启动**（直接 spawn）：

```javascript
spawn(install.mainBinary, [
  "--remote-debugging-address=127.0.0.1",
  `--remote-debugging-port=${port}`,
], {
  detached: true,
  stdio: ["ignore", logFd, errFd],
  windowsHide: true,  // Windows 专用：不弹出控制台窗口
});
child.unref();
```

**Store 版启动**（COM 接口激活 + 回退）：

```
1. 用 IApplicationActivationManager.ActivateApplication(appUserModelId, "--remote-debugging-port=PORT") 启动
2. 等待最多 10 秒，检查 CDP 端口是否监听且归属豆包进程
3. 如果 CDP 端口起来了 → 成功
4. 如果没起来（Store 激活吃掉了参数）→ 关闭应用，尝试直接启动 exe
   Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=PORT"
5. 直接启动也失败（权限问题，WindowsApps ACL）→ 报错：
   "检测到 Microsoft Store 版豆包工作，该版本可能不支持调试端口。
    请从官网 https://www.doubao.com/download/desktop 下载桌面版安装后重试。"
```

**统一验证**（无论哪种启动方式）：
- 启动后必须通过 `waitForCdp(port)` 验证端口真的在监听
- 且通过 `assertDoubaoWorkPort(port)` 验证监听进程属于豆包工作
- 两者都通过才视为启动成功，否则按失败处理并给出明确错误

> **关键设计决策**：不假设 `--remote-debugging-port` 一定生效。Store 版 Electron 应用（如 Codex）已被证实会在包激活时吞掉或转换调试参数。启动后的 CDP 端口验证是唯一可靠的成功判据。

### 3.4 Windows 端口归属校验方案

macOS 用 `lsof` + `ps`，Windows 用 PowerShell 结构化命令（参考 Codex Dream Skin 的实现）：

```powershell
# 1. 拿监听指定端口的 PID（结构化输出，无需解析文本）
Get-NetTCPConnection -State Listen -LocalPort $port | Select-Object OwningProcess, LocalAddress

# 2. 拿进程可执行文件完整路径
Get-CimInstance Win32_Process -Filter "ProcessId = $pid" | Select-Object ExecutablePath

# 3. 验证 ExecutablePath 指向豆包工作的安装目录
```

**方案选择理由**（不用 `netstat` + `tasklist`）：
- `Get-NetTCPConnection` 在 PowerShell 5.1+（Windows 10 1607+ 自带）可用，输出结构化对象，比解析 `netstat -ano` 文本可靠
- `Get-CimInstance Win32_Process` 直接返回 `ExecutablePath` 和 `CommandLine`，比 `tasklist` 信息更全
- `wmic` 已在 Windows 11 24H2 弃用，`Get-CimInstance` 是其官方替代
- Node.js 通过 `execFile("powershell", ["-NoProfile", "-Command", "..."])` 调用，单次调用完成端口+进程验证

**在 Node.js 中的封装**：

```javascript
async function findListeningPids(port) {
  const ps = `Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -ExpandProperty OwningProcess`;
  const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  return stdout.split("\n").map(s => Number(s.trim())).filter(n => n > 0);
}

async function getProcessExecutable(pid) {
  const ps = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath`;
  const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  return stdout.trim() || null;
}
```

### 3.5 Windows 进程管理方案

| 操作 | Windows 实现 | 说明 |
|---|---|---|
| 查找主进程 | `Get-CimInstance Win32_Process -Filter "Name='DoubaoWork.exe'"` | 返回 PID、CommandLine、ExecutablePath |
| 查找 Helper 进程 | `Get-CimInstance Win32_Process -Filter "Name='DoubaoWork Helper.exe'"` | Electron GPU/渲染进程 |
| 查找 watch 进程 | `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` + CommandLine 过滤 `injector.mjs --watch` | 一次调用拿全量信息 |
| 优雅终止 | `taskkill /PID N` | 发送 WM_CLOSE，控制台程序等价 Ctrl+C |
| 强制终止进程树 | `taskkill /PID N /F /T` | /F 强制，/T 含子进程 |
| 进程存活检查 | `Get-Process -Id N -ErrorAction SilentlyContinue` | 有输出则存活 |

**为什么不用 `tasklist`**：`tasklist` 不返回 CommandLine，无法区分哪个 node.exe 是我们的 watch 进程。`Get-CimInstance Win32_Process` 一次返回 PID、CommandLine、ExecutablePath，信息完整且结构化。

**watch 进程识别**：优先从状态文件读取 `injectorPid`，然后用 `Get-CimInstance` 验证该 PID 的 CommandLine 包含 `injector.mjs --watch` 且 ExecutablePath 指向我们的 Node runtime。状态文件丢失时，遍历所有 `node.exe` 进程过滤 CommandLine。

**进程终止的 Windows 特性**：
- Node.js 的 `process.kill(pid, 'SIGTERM')` 在 Windows 上映射为 `TerminateProcess`（强制终止，不优雅），所以必须用 `taskkill /PID N` 做优雅终止
- `taskkill /PID N` 对 GUI 程序发送 WM_CLOSE，对控制台程序发送 CTRL_C_EVENT，有机会优雅退出
- 优雅终止超时后用 `taskkill /PID N /F /T` 强制清理整个进程树

### 3.6 Windows 安装入口方案

#### 文件结构

```
发布包根目录/
├── 安装皮肤.cmd          # 用户双击入口（调用 PowerShell）
├── 安装皮肤.ps1          # 实际安装逻辑（PowerShell）
├── 启动豆包工作.cmd      # 启动入口（调用已安装的 skin.cmd）
├── skin.mjs
├── src/
├── skins/
├── scripts/
│   ├── install.mjs       # 跨平台安装逻辑
│   └── installed-cli.mjs # 跨平台 CLI 入口
├── README.md
├── AGENTS.md
└── ...
```

#### `安装皮肤.cmd` 内容

```batch
@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0安装皮肤.ps1"
if errorlevel 1 (
  echo.
  echo 安装失败，请截图以上错误信息。
  pause
)
endlocal
```

#### `安装皮肤.ps1` 核心逻辑

```powershell
# 1. 检查系统版本（Windows 10 1903+）
# 2. 检查豆包工作是否已安装（探测路径 + 注册表）
# 3. 检测架构（AMD64 / ARM64）
# 4. 下载 Node.js win-x64 zip（带 SHA256 校验）
# 5. 解压到临时目录
# 6. 调用 node.exe scripts/install.mjs --runtime-dir <解压目录>
# 7. 输出安装完成提示
```

### 3.7 Windows 已安装命令入口

macOS 生成 `skin`（sh 脚本），Windows 生成 `skin.cmd`：

```batch
@echo off
setlocal
set "DWS_STATE_ROOT=%LOCALAPPDATA%\DoubaoWorkSkin"
set "DWS_SKINS_DIR=%LOCALAPPDATA%\DoubaoWorkSkin\skins"
"%LOCALAPPDATA%\DoubaoWorkSkin\engine\runtime\node.exe" "%LOCALAPPDATA%\DoubaoWorkSkin\engine\scripts\installed-cli.mjs" %*
endlocal
```

> 数据目录使用 `%LOCALAPPDATA%`（而非 `%APPDATA%`），因为 engine 内含 Node.js 二进制（~30MB），不应随域账户漫游；与 Codex Dream Skin 等同类项目一致。

### 3.8 Windows 桌面快捷方式方案

macOS 用符号链接指向 `启动入口` 文件夹。Windows 上：
- 符号链接需要管理员权限，不适合普通用户
- 方案：在桌面创建 `豆包工作皮肤.lnk` 快捷方式，目标指向 `%LOCALAPPDATA%\DoubaoWorkSkin\启动入口` 文件夹
- 用 PowerShell COM 对象创建：

```powershell
$ws = New-Object -ComObject WScript.Shell
$shortcut = $ws.CreateShortcut("$env:USERPROFILE\Desktop\豆包工作皮肤.lnk")
$shortcut.TargetPath = "$env:LOCALAPPDATA\DoubaoWorkSkin\启动入口"
$shortcut.Save()
```

### 3.9 跨平台文件权限处理

Windows 没有 Unix 权限模型。策略：
- `fs.chmod(path, 0o700)` 在 Windows 上：只设置只读位（0o400/0o200 映射为只读），0o700 实际效果是取消只读。这不是我们想要的。
- **方案**：封装 `ensurePrivateDir` / `ensurePrivateFile` 函数，在 Windows 上空操作（no-op），在 macOS 上执行 chmod。
- 可选增强：Windows 上用 ACL 设置仅当前用户可访问（`icacls`），但这增加复杂度，第一阶段不做。

---

## 4. 各模块详细适配方案

### 4.1 `src/platform/` 新增模块

#### `src/platform/index.mjs`

```javascript
import * as darwin from "./darwin.mjs";
import * as win32 from "./win32.mjs";

const implementations = { darwin, win32 };
const platform = process.platform;

if (!implementations[platform]) {
  throw new Error(`不支持的操作系统: ${platform}；目前支持 macOS 和 Windows`);
}

export const {
  paths,
  appBinaries,
  findListeningPids,
  getProcessExecutable,
  inspectProcess,
  listProcesses,
  isProcessAlive,
  terminateProcess,
  killProcessTree,
  shellQuote,
  generateCliEntry,
  launcherScripts,
  ensurePrivateDir,
  ensurePrivateFile,
} = implementations[platform];
```

#### `src/platform/darwin.mjs`

从现有 `runtime.mjs`、`app-identity.mjs`、`user-data.mjs` 中迁移 macOS 特定逻辑。

#### `src/platform/win32.mjs`

新增 Windows 实现，核心函数：

```javascript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

function psCommand(script) {
  return execFileAsync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" });
}

// 通过 Get-NetTCPConnection 查找监听端口的 PID
export async function findListeningPids(port) {
  const { stdout } = await psCommand(`Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -ExpandProperty OwningProcess`);
  return stdout.split("\n").map(s => Number(s.trim())).filter(n => n > 0);
}

// 通过 Get-CimInstance 获取进程可执行文件路径
export async function getProcessExecutable(pid) {
  const { stdout } = await psCommand(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath`);
  return stdout.trim() || null;
}

// 通过 Get-CimInstance 获取进程命令行（Windows 上获取 cwd 需要 NtQueryInformationProcess，第一阶段返回 null）
export async function inspectProcess(pid) {
  const { stdout } = await psCommand(`Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object CommandLine, ExecutablePath | ConvertTo-Json -Compress`);
  const data = JSON.parse(stdout.trim() || "{}");
  return { command: data.CommandLine || "", cwd: null };
}

// 按可执行文件名列出进程
export async function listProcessesByName(exeNames) {
  const filter = exeNames.map(name => `Name='${name}'`).join(" OR ");
  const { stdout } = await psCommand(`Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId, CommandLine, ExecutablePath | ConvertTo-Json -Compress`);
  const data = JSON.parse(stdout.trim() || "[]");
  return (Array.isArray(data) ? data : [data]).map(p => ({
    pid: Number(p.ProcessId),
    command: p.CommandLine || "",
    executable: p.ExecutablePath || null,
  }));
}

// 优雅终止（taskkill 发送 WM_CLOSE / CTRL_C）
export async function terminateProcess(pid) {
  await execFileAsync("taskkill", ["/PID", String(pid)]).catch(() => {});
  for (let i = 0; i < 10; i++) {
    if (!await isProcessAlive(pid)) return;
    await new Promise(r => setTimeout(r, 500));
  }
  await killProcessTree(pid);
}

// 强制终止进程树
export async function killProcessTree(pid) {
  await execFileAsync("taskkill", ["/PID", String(pid), "/F", "/T"]).catch(() => {});
}

// 进程存活检查
export async function isProcessAlive(pid) {
  try {
    await execFileAsync("powershell", ["-NoProfile", "-Command", `Get-Process -Id ${pid} -ErrorAction Stop`], { encoding: "utf8" });
    return true;
  } catch { return false; }
}
```

### 4.2 `src/app-identity.mjs` 重构

将硬编码路径和平台特定命令改为从 platform 层获取：

```javascript
import { discoverAppInstall, findListeningPids, getProcessExecutable } from "./platform/index.mjs";

// 缓存已探测的应用安装信息，避免重复探测
let cachedInstall = null;

export async function getAppInstall() {
  if (!cachedInstall) cachedInstall = await discoverAppInstall();
  return cachedInstall;
}

export async function assertDoubaoWorkPort(port) {
  const install = await getAppInstall();
  if (!install) throw new Error("未找到豆包工作安装");
  const pids = await findListeningPids(port);
  if (!pids.length) throw new Error("未找到监听进程");
  const allowedDir = path.dirname(install.mainBinary).toLowerCase();
  for (const pid of pids) {
    const exe = await getProcessExecutable(pid);
    // 验证可执行文件位于豆包工作安装目录下（覆盖主进程和 Helper 进程）
    if (!exe || !path.dirname(exe).toLowerCase().startsWith(allowedDir)) {
      throw new Error("监听进程不属于豆包工作");
    }
  }
}
```

> 关键变化：不再硬编码 `/Applications/DoubaoWork.app/...`，而是通过 `discoverAppInstall()` 动态获取当前平台的应用安装信息。端口校验验证进程可执行文件位于安装目录下，而非匹配固定文件名。

### 4.3 `src/runtime.mjs` 重构

将以下函数改为调用 platform 层：
- `createRuntimePaths` → `platform.paths()`
- `defaultInspectProcess` → `platform.inspectProcess()`
- `findOwnedWatchProcesses` 中的 `ps` → `platform.listProcessesByName(['node.exe'])`
- `findDoubaoWorkPid` → 用 `platform.listProcessesByName([主进程名])`
- `findDoubaoWorkBrowserPids` → 用 `platform.listProcessesByName([Helper 进程名])`
- `stopDoubaoWork` / `stopWatchProcess` → `platform.terminateProcess()` / `platform.killProcessTree()`
- `isProcessAlive` → `platform.isProcessAlive()`
- `ensureRuntimeRoot` 中的 chmod → Windows 上 no-op

`launchDoubaoWork` 改为调用 `platform.launchApp(install, port)`，由 platform 层统一处理：
- 桌面版：直接 spawn exe，加 `windowsHide: true`
- Store 版：`IApplicationActivationManager` 包激活，启动后验证 CDP 端口，不生效则回退直接启动 exe
- 两种方式都返回 PID，调用方统一用 `waitForCdp` 验证

`spawnWatchProcess` 的 spawn 调用保持不变，但 Windows 上加 `windowsHide: true`。

### 4.4 `src/user-data.mjs` 重构

- `defaultDataRoot` → `platform.paths().dataRoot`
- `shellQuote` → `platform.shellQuote()`
- `prepareUserData` 中生成 `skin` 入口 → `platform.generateCliEntry()`
- chmod → `platform.ensurePrivateDir()` / `ensurePrivateFile()`

### 4.5 `scripts/install.mjs` 重构

- `launcherScripts` → `platform.launcherScripts()`
- 桌面符号链接 → platform 层的 `createDesktopShortcut()`
- Node runtime 路径 → platform 层的 `nodeRuntimePath()`
- chmod → platform 层

### 4.6 `scripts/installed-cli.mjs` 调整

- 移除 `process.env.PATH = "/usr/bin:..."` 硬编码，改为 platform 层处理或不修改
- 其余逻辑跨平台

### 4.7 `src/injector.mjs` 调整

- 增加 `process.on("SIGBREAK", shutdown)`（Windows 上 taskkill 可能触发 SIGBREAK）
- `fs.watch` 的 `recursive: true` 在 Windows 上可用，保持不变

### 4.8 新增 Windows 脚本

| 文件 | 用途 |
|---|---|
| `安装皮肤.cmd` | Windows 安装入口（双击运行） |
| `安装皮肤.ps1` | PowerShell 安装逻辑 |
| `启动豆包工作.cmd` | Windows 启动入口（源码模式） |

### 4.9 `scripts/build-release.mjs` 调整

- 新增 Windows 发布包构建逻辑
- Windows 包包含 `.cmd` / `.ps1` 脚本，不包含 `.command`
- macOS 包保持不变
- Skill 包包含两个平台的完整项目

---

## 5. 数据目录与状态兼容性

### 5.1 目录结构

Windows 数据目录：`%LOCALAPPDATA%\DoubaoWorkSkin`（即 `C:\Users\<用户名>\AppData\Local\DoubaoWorkSkin`）

> 选择 Local 而非 Roaming 的理由：engine 内含 Node.js 二进制（~30MB），不应随域账户漫游；本工具是纯本地工具，无漫游需求。与 Codex Dream Skin 等同类项目一致。

```
DoubaoWorkSkin/
├── AGENTS.md              # 安装版操作指南
├── state.json             # 运行状态
├── preferences.json       # 皮肤偏好
├── injector.log           # watch 进程日志
├── injector-error.log     # watch 错误日志
├── doubaowork-launch.log  # 应用启动日志
├── skins/                 # 个人皮肤目录
│   └── ...
├── engine/                # 安装的程序（含 Node runtime）
│   ├── runtime/
│   │   └── node.exe       # Windows 版 Node.js
│   ├── src/
│   ├── skins/
│   ├── scripts/
│   ├── skin.mjs
│   └── ...
└── 启动入口/
    ├── 启动豆包工作.cmd
    ├── 恢复官方外观.cmd
    └── 复制换肤提示词.cmd
```

### 5.2 状态文件格式

`state.json` 格式完全跨平台兼容（JSON），无需修改。PID 在 Windows 上同样是数字。

### 5.3 跨平台迁移

macOS 和 Windows 的状态目录不同，用户不会在两个系统间共享状态。如果用户通过云盘同步 home 目录，可能冲突，但这是极端场景，第一阶段不处理。

---

## 6. 测试策略

### 6.1 单元测试

现有测试（`test/` 目录）大部分是跨平台的，但以下测试需要调整：

| 测试文件 | 调整点 |
|---|---|
| `runtime.test.mjs` | `findDoubaoWorkPid`、`stopDoubaoWork` 等依赖平台实现的测试，需要注入 mock 的 platform 层 |
| `app-identity.test.mjs` | `assertDoubaoWorkPort` 测试需要 mock platform 层 |
| `install.test.mjs` | 安装逻辑测试需要适配 Windows 路径和脚本生成 |
| `user-data.test.mjs` | `defaultDataRoot`、`shellQuote` 测试需要按平台断言 |
| `cli.test.mjs` | CLI 逻辑本身跨平台，但路径相关断言需要调整 |

**策略**：
1. 所有 platform 层函数通过依赖注入传入，测试时用 mock 替代
2. 新增 `test/platform/win32.test.mjs`，专门测试 Windows 平台实现的输出解析逻辑（netstat/tasklist 输出解析）
3. 新增 `test/platform/darwin.test.mjs`，将现有 macOS 特定测试迁移至此

### 6.2 CI 矩阵

```yaml
jobs:
  check:
    strategy:
      matrix:
        os: [macos-latest, windows-latest]
        node: [22, 24]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: npm run check
      - run: npm test
```

### 6.3 手动验证清单（Windows 真机）

在实际 Windows 机器上验证：

- [ ] 双击 `安装皮肤.cmd` 能完成安装（含 Node.js 下载校验）
- [ ] 桌面出现"豆包工作皮肤"快捷方式
- [ ] 双击 `启动豆包工作.cmd` 能启动应用并换肤
- [ ] `skin.cmd list` 列出所有皮肤
- [ ] `skin.cmd start <主题>` 启动并验证通过
- [ ] `skin.cmd switch <主题>` 切换皮肤
- [ ] `skin.cmd verify <主题>` 验证通过
- [ ] `skin.cmd stop` 恢复官方外观
- [ ] `skin.cmd disable`（应用未运行时）正常工作
- [ ] watch 进程在应用重启后能自动重新注入
- [ ] 自定义皮肤制作流程正常
- [ ] `恢复官方外观.cmd` 正常工作
- [ ] `复制换肤提示词.cmd` 能复制到剪贴板
- [ ] 卸载/删除数据目录后重新安装正常

---

## 7. 实施步骤与优先级

### Phase 1：平台抽象层搭建（核心，必须先做）

1. 创建 `src/platform/types.mjs`（接口定义）
2. 创建 `src/platform/darwin.mjs`（从现有代码迁移 macOS 实现）
3. 创建 `src/platform/index.mjs`（统一导出）
4. 重构 `src/app-identity.mjs` 调用 platform 层
5. 重构 `src/runtime.mjs` 调用 platform 层
6. 重构 `src/user-data.mjs` 调用 platform 层
7. 运行现有测试，确保 macOS 行为完全不变
8. 提交，CI 通过

**验收标准**：`npm run check` + `npm test` 在 macOS 上全部通过，功能与重构前一致。

### Phase 2：Windows 平台实现

1. 创建 `src/platform/win32.mjs`（Windows 实现）
2. 实现应用定位（三级策略：进程反查 → Store 包探测 → 桌面路径遍历）
3. 实现 Store 应用启动（`IApplicationActivationManager` COM 接口 + CDP 验证回退）
4. 实现桌面应用启动（直接 spawn + `windowsHide: true`）
5. 实现端口校验（`Get-NetTCPConnection` + `Get-CimInstance Win32_Process`）
6. 实现进程查找与管理（`Get-CimInstance` + `taskkill`）
7. 实现路径与 shellQuote
8. 实现 CLI 入口生成（skin.cmd）
9. 实现启动脚本生成（.cmd）
10. 实现桌面快捷方式创建（PowerShell COM `WScript.Shell`）
11. 编写 Windows 平台层单元测试（mock PowerShell 输出）

**验收标准**：Windows 平台层单元测试通过；`npm run check` + `npm test` 在 Windows CI 上通过。

### Phase 3：Windows 安装与分发

1. 编写 `安装皮肤.ps1`（PowerShell 安装逻辑）
2. 编写 `安装皮肤.cmd`（双击入口）
3. 编写 `启动豆包工作.cmd`（源码模式启动入口）
4. 重构 `scripts/install.mjs` 支持 Windows
5. 重构 `scripts/build-release.mjs` 生成 Windows 发布包
6. 更新 CI 增加 windows-latest 矩阵
7. 更新 `scripts/installed-cli.mjs`（PATH 处理）

**验收标准**：能在 macOS 上构建出 Windows 发布包；Windows CI 上 check + test 通过。

### Phase 4：文档与收尾

1. 更新 `AGENTS.md`（增加 Windows 平台说明）
2. 更新 `README.md`（增加 Windows 快速开始）
3. 更新 `CONTRIBUTING.md`（开发与测试说明）
4. 更新 `package.json` description（去掉"macOS"限定）
5. 全量回归测试（macOS + Windows）
6. Windows 真机手动验证

**验收标准**：文档完整；两个平台测试全通过；Windows 真机验证通过。

---

## 8. 风险与开放问题

### 8.1 高风险

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| **Store 版豆包工作不保留 `--remote-debugging-port` 参数** | Store 版无法开启 CDP，换肤不可用 | 启动后验证 CDP 端口，不生效时报清晰错误并提示安装桌面版；桌面版优先策略 |
| **Store 版直接启动 exe 权限不足** | WindowsApps ACL 阻止直接执行 | 优先用 `IApplicationActivationManager` 包激活；直接启动仅作回退且预期可能失败 |
| Windows 版豆包工作的实际进程名/Helper 名未知 | 进程识别和端口校验失败 | Phase 2 前在 Windows 机器上确认；进程名支持配置，通过 `AppInstall.helperBinary` 传入 |
| Windows 上 `spawn detached` + `unref` 行为差异 | watch 进程可能随父进程退出 | 用 `detached: true` + `stdio: 'ignore'` + `windowsHide: true` + `child.unref()`；真机验证 |
| PowerShell 执行策略限制 | 用户无法运行 .ps1 | 安装入口用 .cmd 包装 `-ExecutionPolicy Bypass`；安装后生成的脚本用 RemoteSigned |
| `Get-NetTCPConnection` 在极旧 Windows 版本不可用 | 端口校验失败 | 要求 Windows 10 1607+（PowerShell 5.1+）；安装脚本检查系统版本 |
| Windows Defender 或企业策略拦截脚本/Node 下载 | 安装失败 | 文档中说明；提供手动下载 Node.js 的备选方案 |
| 中文用户名/路径含非 ASCII 字符 | 脚本/路径处理出错 | 全程 UTF-8；PowerShell 设置 `[Console]::OutputEncoding = [Text.Encoding]::UTF8`；测试中文路径场景 |

### 8.2 中风险

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| `fs.watch({ recursive: true })` 在 Windows 上事件可靠性 | 皮肤热更新可能不触发 | watch 模式已有 3 秒轮询兜底，不依赖 fs.watch |
| Windows 上获取进程 cwd 困难（需要 NtQueryInformationProcess） | inspectWatchProcess 的 cwd 校验受限 | 第一阶段 Windows 上 cwd 返回 null，改用 injector 路径绝对匹配校验 |
| Node.js Windows 版体积较大（约 30MB zip） | 下载时间长 | 与 macOS 版类似，可接受；支持缓存已下载文件 |
| 中文路径/用户名包含非 ASCII 字符 | 脚本/路径处理可能出错 | 全程使用 UTF-8；PowerShell 默认 UTF-8（5.1 需设置 `[Console]::OutputEncoding`）；测试中文用户名场景 |

### 8.3 开放问题（需 Windows 真机验证）

1. **Store 版豆包工作是否保留 `--remote-debugging-port` 参数**：这是最关键的问题。Codex（同类 Store 应用）已被证实在包激活时会吃掉 CDP 参数。豆包工作 Store 版需要验证：
   - `IApplicationActivationManager.ActivateApplication(appUserModelId, "--remote-debugging-port=9342")` 后端口是否监听？
   - 如果不监听，直接启动 `WindowsApps\...\DoubaoWork.exe --remote-debugging-port=9342` 是否有权限？
   - 如果 Store 版完全不支持 CDP，方案退化为仅支持桌面 EXE 版，安装时检测到 Store 版提示用户下载桌面版。
2. **Windows 版豆包工作的进程名和 Helper 进程名**：假设为 `DoubaoWork.exe` 和 `DoubaoWork Helper.exe`，需真机确认。Store 版的实际 exe 名可能不同（如 Codex Store 版实际是 `ChatGPT.exe`）。
3. **桌面 EXE 版的安装路径和安装器类型**：假设为 NSIS per-user 安装到 `%LOCALAPPDATA%\Programs\DoubaoWork\`，需确认是否为 Squirrel 模式（带 `app-x.y.z` 版本子目录）。
4. **Windows 版豆包工作的页面 URL scheme**：macOS 版使用 `doubaowork:` / `chrome:` protocol，Windows 版应一致，但需验证。
5. **是否需要支持 ARM64 Windows**：Node.js 提供 win-arm64 构建，但豆包工作 Windows 版是否有 ARM64 版本未知。第一阶段仅支持 x64。
6. **Store 版的 PackageFamilyName 和 ApplicationId**：需要从 `Get-AppxPackage` 实际获取，当前假设包名含 `doubao` 或 `春田`，需真机确认精确值。

---

## 9. 文件变更总览

### 新增文件

```
src/platform/
├── index.mjs
├── types.mjs
├── darwin.mjs
└── win32.mjs

安装皮肤.cmd          # Windows 安装入口
安装皮肤.ps1          # Windows 安装逻辑
启动豆包工作.cmd      # Windows 启动入口（源码模式）

test/platform/
├── darwin.test.mjs   # macOS 平台层测试
└── win32.test.mjs    # Windows 平台层测试

docs/windows-support-plan.md  # 本文档
```

### 修改文件

```
src/app-identity.mjs     # 调用 platform 层
src/runtime.mjs          # 调用 platform 层
src/user-data.mjs        # 调用 platform 层
src/injector.mjs         # 增加 SIGBREAK 处理
scripts/install.mjs      # 跨平台安装逻辑
scripts/installed-cli.mjs # PATH 处理
scripts/build-release.mjs # Windows 发布包
scripts/check.mjs        # 可能需要微调
scripts/install-shortcut.mjs # Windows 快捷方式
AGENTS.md                # Windows 说明
README.md                # Windows 快速开始
CONTRIBUTING.md          # 开发说明
package.json             # description 更新
.github/workflows/ci.yml  # Windows CI 矩阵
```

### 不修改文件

```
src/cdp.mjs              # 纯 CDP 协议，跨平台
src/theme.mjs            # 主题加载，跨平台
src/base.css             # CSS，跨平台
src/selectors.json       # 选择器，跨平台
src/capture-dom.mjs      # 截图工具，跨平台
skins/*                  # 主题资源，跨平台
test/cli.test.mjs        # 可能需要微调路径断言
test/theme.test.mjs      # 跨平台
test/injector.test.mjs   # 跨平台
test/cdp.test.mjs        # 跨平台
test/privacy.test.mjs    # 跨平台
test/screenshots.test.mjs # 跨平台
```

---

## 10. 总结

本方案通过引入 `src/platform/` 平台抽象层，将 macOS 特定逻辑与核心换肤逻辑分离。Windows 适配的核心设计决策：

1. **应用定位三级策略**：运行中进程反查（最准确）→ Store 包探测（`Get-AppxPackage`）→ 桌面路径遍历；多版本共存时桌面版优先
2. **应用启动双轨制**：桌面版直接 spawn exe；Store 版用 `IApplicationActivationManager` COM 接口激活，启动后验证 CDP 端口，不生效则回退直接启动并提示用户
3. **启动后必须验证 CDP**：不假设 `--remote-debugging-port` 一定生效（Store 应用可能吃掉参数），端口验证是唯一成功判据
4. **进程与端口管理**：`Get-NetTCPConnection` + `Get-CimInstance Win32_Process` 替代 `netstat`/`tasklist`/`wmic`，结构化输出更可靠
5. **安装入口**：PowerShell `.ps1` + `.cmd` wrapper（`-ExecutionPolicy Bypass`）替代 zsh `.command`
6. **数据目录**：`%LOCALAPPDATA%\DoubaoWorkSkin`（Local，不漫游，因 engine 含 Node.js 二进制）
7. **桌面快捷方式**：`.lnk`（PowerShell COM `WScript.Shell`）替代 symlink
8. **进程终止**：`taskkill /PID N`（优雅）→ `taskkill /PID N /F /T`（强制进程树），替代 POSIX 信号

核心换肤逻辑（CDP 注入、主题加载、CSS 构建、状态管理）完全复用，预计代码复用率 > 80%。

参考项目：Codex Dream Skin（GitHub 11k+ stars，同类 CDP 换肤工具，已解决 Store 应用启动与 CDP 参数兼容性问题）。

建议按 Phase 1 → 2 → 3 → 4 顺序实施，每个 Phase 结束后运行全量测试确保 macOS 行为不受影响。
