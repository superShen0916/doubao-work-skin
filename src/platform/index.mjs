/**
 * 平台抽象层统一入口
 *
 * 根据 process.platform 动态选择实现。
 * 核心模块通过本文件导入平台能力，不直接调用平台特定 API。
 */

import * as darwin from "./darwin.mjs";
import * as win32 from "./win32.mjs";

const implementations = { darwin, win32 };
const platform = process.platform;

if (!implementations[platform]) {
  throw new Error(`不支持的操作系统: ${platform}；目前支持 macOS 和 Windows`);
}

export const {
  paths,
  discoverAppInstall,
  launchApp,
  findListeningPids,
  getProcessExecutable,
  inspectProcess,
  listProcessesByName,
  isProcessAlive,
  terminateProcess,
  killProcessTree,
  shellQuote,
  generateCliEntry,
  launcherScripts,
  createDesktopShortcut,
  ensurePrivateDir,
  ensurePrivateFile,
} = implementations[platform];
