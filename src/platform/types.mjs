/**
 * 平台抽象层类型定义
 *
 * 所有平台差异通过本文件定义的接口收敛。
 * 核心换肤逻辑（CDP 注入、主题加载、状态管理）不直接调用平台特定 API。
 */

/**
 * @typedef {Object} PlatformPaths
 * @property {string} dataRoot        - 用户数据目录
 * @property {string} defaultSkinsDir - 默认皮肤目录
 * @property {string} desktopDir      - 桌面目录
 */

/**
 * 应用安装信息——统一描述 Store 版和桌面版
 * @typedef {Object} AppInstall
 * @property {'store'|'desktop'} type       - 安装类型
 * @property {string} mainBinary            - 主程序可执行文件绝对路径
 * @property {string} helperBinary          - Helper 可执行文件名（用于进程识别）
 * @property {string} [packageFamilyName]   - Store 包家族名（仅 store 类型）
 * @property {string} [applicationId]       - Store 应用 ID（仅 store 类型）
 * @property {string} [appUserModelId]      - Store 启动标识符 = PackageFamilyName!ApplicationId（仅 store 类型）
 * @property {string} [version]             - 应用版本
 */

/**
 * @typedef {Object} PlatformApi
 * @property {() => PlatformPaths} paths
 * @property {() => Promise<AppInstall|null>} discoverAppInstall
 * @property {(install: AppInstall, port: number) => Promise<number>} launchApp
 * @property {(port: number) => Promise<number[]>} findListeningPids
 * @property {(pid: number) => Promise<string|null>} getProcessExecutable
 * @property {(pid: number) => Promise<{command: string, cwd: string|null}>} inspectProcess
 * @property {(exeNames: string[]) => Promise<{pid: number, command: string}[]>} listProcessesByName
 * @property {(pid: number) => Promise<boolean>} isProcessAlive
 * @property {(pid: number) => Promise<void>} terminateProcess
 * @property {(pid: number) => Promise<void>} killProcessTree
 * @property {(command: string) => string} shellQuote
 * @property {(dataRoot: string, nodePath: string, bridgePath: string) => string} generateCliEntry
 * @property {(command: string) => Object<string,string>} launcherScripts
 * @property {(targetPath: string, linkName: string) => Promise<void>} createDesktopShortcut
 * @property {(dirPath: string) => Promise<void>} ensurePrivateDir
 * @property {(filePath: string) => Promise<void>} ensurePrivateFile
 */

export {};
