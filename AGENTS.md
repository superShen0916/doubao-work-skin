# Agent 操作指南

本指南适用于在用户 Mac 或 Windows PC 上安装、切换、制作和恢复豆包工作皮肤的 Agent。需要本机文件与命令执行权限；云端沙箱不能操作用户电脑上的应用。

用户请求阅读、审查或修改本仓库时，只进行对应的开发工作，不安装工具、不切换皮肤。开发与测试规则见 [CONTRIBUTING.md](./CONTRIBUTING.md)。安装版的补充文档位于用户数据目录内的 `engine/`；该目录仅供读取，不在其中开发或制作个人皮肤。

## 平台支持

- **macOS**：13.5+，Apple 芯片或 Intel，应用路径 `/Applications/DoubaoWork.app`
- **Windows**：10 1809+（x64），支持桌面 EXE 版和 Microsoft Store 版；桌面版优先，Store 版自动兼容
- 数据目录：macOS 为 `~/Library/Application Support/DoubaoWorkSkin`，Windows 为 `%LOCALAPPDATA%\DoubaoWorkSkin`

## 安装与环境准备

接受仓库链接或本地项目目录作为入口。对于安装或换肤请求，按需完成环境准备；仅查询项目信息时不执行安装。

1. 确认能在用户本机执行命令。macOS 需要系统 ≥ 13.5 且存在 `/Applications/DoubaoWork.app`；Windows 需要系统 ≥ 10 1809（x64），支持桌面 EXE 版或 Microsoft Store 版豆包工作。如果只有网页阅读或云端沙箱能力，说明无法操作本机，并给出 README 中的双击安装步骤；不要把云端下载或执行当作本机安装。
2. 先检查本机 `~/Library/Application Support/DoubaoWorkSkin/AGENTS.md` 和同目录的 `skin` 是否存在。已安装且未请求更新时，读取该说明后直接执行换肤，无需下载或安装；当前已在阅读安装版说明时不循环读取。请求更新时继续获取指定版本。入口缺失或执行失败时先诊断具体问题，不删除个人皮肤或将重装作为默认修复方式。
3. 未安装且已有完整本地项目时，直接使用它。只有 GitHub 链接时，从用户给出的仓库页面获取实际下载地址：优先使用该仓库正式 Release 中的 `DoubaoWorkSkin-<版本>-macos-scripts.zip`，并核对随包 `.sha256`；没有脚本发布包时，下载该仓库默认分支的源码 ZIP。用户指定版本或分支时以其选择为准，不静默换成其他版本。不要猜仓库地址、分支名或发布文件 URL。
4. 在独立的本地临时目录中下载并完整解压，可用 macOS 自带的 `/usr/bin/curl` 和 `/usr/bin/ditto -x -k`，无需安装 Git、Python 或 Homebrew。curl 应使用 HTTPS、跟随重定向并在 HTTP 错误时失败（如 `--fail --location --proto '=https' --proto-redir '=https'`）。从解压结果定位包含 `AGENTS.md`、`安装皮肤.command`、`scripts/install.mjs`、`skin.mjs`、`package.json`、`src/` 和 `skins/` 的项目根目录；不要依赖 ZIP 顶层目录名，也不要只下载一个脚本。校验失败或文件不全时停止，报告具体原因。
5. 读取下载版本的 `AGENTS.md`，按“执行安装”操作，然后转到安装版说明。由项目安装器下载和校验专用 Node.js；不要另写安装器或要求用户配置开发环境。
6. 按下文“切换与验证”完成用户请求。更新后重新应用目标主题并验证，不能把安装成功当作换肤成功。

从 v2.2.2 起，加载器会在内存中兼容旧内置主题及其个人副本里的状态条和菜单样式规则，个人主题文件保持原样。为获取这两处修复，只需更新程序后重新应用并验证，不要覆盖用户的背景、配色或整份 `skin.css`。

仅在仓库链接和本地目录都无法从上下文找到、下载受权限限制，或缺少必需能力时，向用户索取缺失信息。已有链接时不要反过来要求用户提供下载目录。用户请求更新时才下载新版并运行安装脚本。

## 执行安装

普通用户不需要开发环境。拿到完整项目目录后，macOS 执行 `/bin/zsh ./安装皮肤.command`，Windows 执行 `安装皮肤.cmd`（内部调用 PowerShell）。脚本从 Node.js 官方下载固定版本、校验摘要并安装到用户目录。无需 `npm install`、Homebrew、Git 或管理员权限。首次安装需要网络，安装本身不会退出豆包工作。

成功后优先阅读 `~/Library/Application Support/DoubaoWorkSkin/AGENTS.md` 并使用其中的固定命令入口，不再依赖下载目录。需要启用或重启时，让用户保存工作、等待当前任务结束，再双击桌面“豆包工作皮肤”内的启动文件。不要替用户运行带重启确认的快捷入口。

下文的 `node skin.mjs` 和 Node.js 环境检查仅适用于直接从源码运行；安装版使用已安装指南中的替代命令。

## 切换与验证

安装版使用固定命令入口，例如：

macOS：
```sh
"$HOME/Library/Application Support/DoubaoWorkSkin/skin" list
"$HOME/Library/Application Support/DoubaoWorkSkin/skin" start sunlit-atelier
"$HOME/Library/Application Support/DoubaoWorkSkin/skin" verify sunlit-atelier
```

Windows：
```cmd
"%LOCALAPPDATA%\DoubaoWorkSkin\skin.cmd" list
"%LOCALAPPDATA%\DoubaoWorkSkin\skin.cmd" start sunlit-atelier
"%LOCALAPPDATA%\DoubaoWorkSkin\skin.cmd" verify sunlit-atelier
```

如果安装版指南指定了不同路径，以该指南为准。下文的 `skin` 是此完整路径的简称，不要求它已加入 PATH；无需检查系统 Node.js，也不在安装目录运行 npm 命令。

从 `list` 或主题配置读取中文名称、ID 和描述。明确指定名称时匹配实际 ID，不直接将用户原话拼接进 shell。未指定主题或风格的换肤请求默认使用「海风微语」（`seaside-breeze`）；明确的风格或定制要求优先。普通切换不修改主题文件。

`start <ID>` 成功后执行 `verify <ID>`，验证通过才报告生效。`status.running` 仅表示后台进程存在。需要重启时按“重启与任务衔接”给出步骤，其他错误报告实际原因。

## 更新内置主题修复

用户请求更新皮肤、升级版本时，按以下流程操作。`engine/` 会被替换，但实际使用的 `skins/` 目录中已存在的主题不会被自动覆盖。已知上游修复了 bug 时可以说明更新方式，不因发现新版就擅自更新用户安装。

### 目录关系

```
~/Library/Application Support/DoubaoWorkSkin/
├── engine/          # 程序引擎：base.css、注入器、内置主题的种子副本，更新时整体替换
└── skins/           # 实际加载的皮肤目录（DWS_SKINS_DIR 指向这里），已存在的主题不被覆盖
```

注入器从 `skins/` 加载主题，从 `engine/src/base.css` 加载共享样式。v2.2.2 的加载器会兼容旧状态条和菜单规则，因此本次修复只需更新程序并重新应用，无需同步主题文件。其他未由加载器兼容的主题设计变更，才需要按差异合并。

### 更新步骤

1. **更新 engine/**：用户提供仓库链接或发布包时，按“安装与环境准备”下载并运行 `安装皮肤.command`；已有完整本地项目时直接执行 `/bin/zsh ./安装皮肤.command`。这会替换 `engine/` 并停止旧注入器。
2. **识别修复范围**：先读新版发布说明。旧状态条和菜单规则已由 v2.2.2 加载器处理，直接进入第 4 步。若用户要求同步其他主题改动，再读取 `engine/skins/` 列表识别内置主题；同名目录也可能含个人修改，不能视为可整份覆盖。
3. **按需备份并合并**：只处理用户要求更新的主题。在 `skins/` 外备份对应目录，对比 `engine/skins/<id>/` 与个人副本，仅合并所需修复，保留用户额外样式。`theme.json` 和 `background.png` 默认保留用户版本；配色修复也只合并相关字段。不同 ID 的用户自定义主题不自动同步。
4. **重新应用**：安装更新已停止旧注入器，直接执行 `skin start <当前主题ID>`。若只合并了文件且 watch 仍在运行，可等待热更新后验证；需要重新加载时使用 `skin stop --keep-appearance` 后再 `skin start <当前主题ID>`。如需重启应用，按“重启与任务衔接”交给用户执行。
5. **验证**：执行 `skin verify <当前主题ID>`，确认注入成功。有界面查看能力时，检查修复点是否实际生效（如推理强度子菜单可点击、输入框上方无线条）；没有查看能力时，告诉用户已完成哪些检查并请其反馈。

### 注意事项

- 不要直接删除 `skins/` 整个目录来"刷新"，这会删掉用户的自定义主题和个人调整。
- 用户说"更新皮肤"但没有提供版本或链接时，结合当前上下文确定目标；明确要求更新程序时沿用已有仓库入口。仅在无法判断是更新程序还是调整外观时再澄清。
- 备份目录放到 `skins/` 之外，避免带有 `theme.json` 的备份目录被发现为额外主题。单个 `.bak` 文件不会被发现器当成主题，但也不必留在活动主题目录中。
- 更新后如果用户反馈样式异常，先检查是否是自定义修改被覆盖，从备份恢复对应文件。

## 源码模式操作步骤

仅适用于明确选择直接从源码运行的用户。普通换肤请求优先使用上面的安装流程及安装版固定入口。

1. 确定本地项目根目录，确认包含 `skin.mjs`、`package.json` 和 `skins/`。只有 GitHub 链接时先按上文下载，不假定所有用户都安装在同一个路径。
2. 确认可以在用户的本机上执行命令。云端沙箱或普通聊天环境无法操作本机应用，不要将沙箱中的执行结果当成本机结果。
3. 在项目根目录检查 Node.js 版本（`node --version`，需要 ≥ 22），然后运行 `node skin.mjs list`。本项目没有第三方运行依赖，无需 `npm install`。
4. 按"切换与验证"的主题选择规则，执行 `node skin.mjs start <ID>`，不加 `--force`；成功后执行 `node skin.mjs verify <ID>`。

所有命令应使用项目根目录作为工作目录；路径含空格时正确引用。不要执行 `launch`、`启动豆包工作.command` 或绕过页面与进程身份校验来掩盖失败。`安装皮肤.command`（macOS）和 `安装皮肤.cmd`（Windows）是允许 Agent 执行的环境准备入口，不会退出应用。

## 创建与调整自定义皮肤

用户负责提供图片、风格偏好和效果反馈；Agent 负责主题文件、配色、校验与应用。不要要求用户编写 JSON、CSS 或选择器。

### 制作流程

1. 读取用户素材与要求。用户只给出风格时，可以在具备图像生成能力的情况下生成背景；没有该能力就说明需要用户提供图片，不编造已生成的素材。
2. 选择接近目标风格的现有主题作为起点，复制到一个尚未存在的新目录。普通新建任务不覆盖已有主题；修改用户自己的主题时，仅改对应目录，不改共享 `src/base.css` 或其他主题。
3. 设置用户可读的中文名称、描述和唯一的小写 kebab-case ID。目录名必须与 ID 一致。保留完整颜色字段，让正文、按钮、输入框与背景协调。
4. 将最终背景保存为新目录中的 `background.png`。使用正确的图像转换工具输出 PNG，不能只把 JPEG/WebP 的扩展名改成 `.png`。不引用目录外文件或远程资源。
5. 优先通过配色和背景裁剪焦点实现效果。确需专属样式时编辑 `skin.css`，复用 `--dws-*` 变量和稳定选择器，不加入主题 ID 的核心代码分支。
6. 安装版运行固定入口的 `skin check`，检查个人主题配置及资源能否加载；完整源码仓库运行 `npm run check`，还会检查源码语法和内置背景的 PNG 格式。用户要求应用时执行 `start` 和 `verify`，不使用 `--force`。仅要求制作或预览时，交付制作结果即可。
7. 有界面查看能力时，检查新建对话、正文、输入框、侧栏与右侧面板的可读性。命令验证只能证明注入状态，不能替代视觉检查；没有查看能力时，告诉用户已完成哪些检查，并请其反馈实际效果。

用户继续提出调整时，沿用新主题目录并重新检查；用户要求切回旧主题时，使用切换命令，不删除新主题。

### 主题文件与配置

```text
skins/<theme-id>/
├── theme.json          # 名称、版本、明暗、配色及可选背景
├── background.png      # 本仓库主题统一使用 PNG
└── skin.css            # 可选的主题专属样式
```

`theme.json` 的完整示例：

```json
{
  "id": "my-garden",
  "name": "我的花园",
  "version": "1.0.0",
  "description": "柔和绿色与安静花园，中央保持清晰易读。",
  "appearance": "light",
  "background": { "image": "background.png", "focusX": 0.5, "focusY": 0.5 },
  "colors": {
    "bg-primary": "#e6efee",
    "bg-secondary": "#eef3f1",
    "bg-tertiary": "#f7f5ef",
    "text-primary": "#2a3a3a",
    "text-secondary": "#5a6a6a",
    "text-tertiary": "#8a9a9a",
    "accent": "#5ba8a0",
    "accent-alt": "#d4a574",
    "border": "rgba(91, 140, 143, 0.20)",
    "sidebar-bg": "rgba(233, 241, 239, 0.84)",
    "card-bg": "rgba(247, 248, 244, 0.89)",
    "input-bg": "rgba(247, 248, 244, 0.95)",
    "selection-color": "#e8fff8"
  }
}
```

颜色映射为 `--dws-*` 变量（如 `accent` → `--dws-accent`），完整映射见 `src/theme.mjs`。`background.focusX` / `focusY` 为 0–1 的裁剪焦点。加载器也支持 JPEG/WebP，但本项目制作规范统一使用 `background.png`；源码检查会额外校验 PNG 文件头。

### 构图与样式约定

背景建议约 16:10，例如 1586×992。左侧 0–280px 留给侧栏，中间 380–1080px 保持低对比度，主体尽量放在右侧 1100–1586px，顶部 56px 不放关键元素。实际裁剪随窗口大小变化，需要检查不同窗口尺寸。

使用 `src/selectors.json` 中登记的 `data-testid`、语义 role 或稳定类名前缀。禁止 `body *` 全局改色、`[class*=card]` 等宽泛匹配和未经验证的位置选择器。保持 hover、focus-visible、selected、disabled 状态及正常交互，不隐藏或拦截控件。发送按钮（`chat_input_send_button`）已在共享 `src/base.css` 中适配主题强调色，个人主题无需重复处理。

如需向本仓库贡献新主题，同步更新 README 的主题列表、素材来源与许可说明，以及主题发现测试中的内置清单；个人定制只需完成资源检查和实际效果验证。完整贡献要求见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 重启与任务衔接

普通方式打开的豆包工作可能没有调试接口。此时 `start` 会返回说明；当前任务里的 Agent 不应执行 `--force`、退出应用或终止进程，否则可能中断自己以及用户正在进行的任务。

### 安装版用户（绝大多数情况）

确认安装成功、桌面快捷方式存在后，**严格按以下 3 步向用户说明，不要增加、删减或改写步骤**：

1. 保存工作，等待当前 Agent 任务结束。
2. 去桌面打开「豆包工作皮肤」文件夹，双击 `启动豆包工作.command`（macOS）或 `启动豆包工作.cmd`（Windows）；终端问是否重启时输入 `y` 回车。
3. 豆包工作自动重新打开后，回到原对话继续。

**关键约束（必须遵守）：**

- **不要让用户手动完全退出豆包工作。** 启动入口脚本会自动处理退出和重启，手动先退反而可能导致脚本找不到进程。
- **优先引导从桌面「豆包工作皮肤」文件夹打开。** 只有桌面快捷方式确实不存在时，才给出备选路径：macOS 为 `~/Library/Application Support/DoubaoWorkSkin/启动入口/启动豆包工作.command`，Windows 为 `%LOCALAPPDATA%\DoubaoWorkSkin\启动入口\启动豆包工作.cmd`。
- 双击入口使用上次成功选择的主题，首次默认「海风微语」。如果用户刚请求了其他主题但尚未生效，等用户返回对话后再执行 `start` 和 `verify`。
- 不要承诺重启后任务会自动继续，也不要在重启前报告皮肤已经生效。

### 源码版用户

对直接从源码运行的用户，说明应完全退出应用后从项目目录执行 `npm start`，不在当前宿主任务中执行重启。

### 其他

如果用户新开对话、Agent 缺少上下文，让其读取固定的安装版 `AGENTS.md`；用户也可双击桌面入口中的"复制换肤提示词.command"（macOS）或"复制换肤提示词.cmd"（Windows）后粘贴。

未安装运行环境时先使用安装脚本自动准备；没有本机命令权限或下载失败时说明具体原因，不要报告已经启用。

## 恢复官方外观

安装版执行固定入口的 `skin disable`，与桌面"恢复官方外观.command"（macOS）或"恢复官方外观.cmd"（Windows）一致：应用已退出时会停止残留后台进程；应用仍运行时尝试清理页面外观。源码版执行 `node skin.mjs stop`。只有命令成功才报告对应结果；应用已退出时说明"下次正常打开为官方外观"，不要称已验证当前页面。

CDP 不可用时，安装版可用 `skin stop --keep-appearance`，源码版可用 `node skin.mjs stop --keep-appearance` 停止后台进程，但这不代表当前页面外观已恢复。告知用户完全退出后正常打开应用即可清除临时皮肤，不要删除状态文件冒充恢复成功。

## 反馈结果

向用户报告中文主题名称和实际验证结果即可。失败时解释原因及下一步，不要原样粘贴包含个人路径或页面数据的大段日志，不读取对话内容、Cookie 或凭据来诊断皮肤切换。
