// Windows desktop entry generation only; process discovery stays in win32.mjs.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const template = readFileSync(new URL("./windows-launcher.ps1", import.meta.url), "utf8");
const windowSource = readFileSync(new URL("./windows-window.cs", import.meta.url), "utf8");
const psLiteral = value => String(value).replaceAll("'", "''");

export function launcherMutexName(dataRoot) {
  // Case and slash aliases refer to the same Windows installation. Hashing also
  // avoids collisions between distinct Unicode paths and the kernel name limit.
  const root = path.win32.resolve(dataRoot).toLowerCase();
  return `Local\\DoubaoWorkSkin.Launcher.${createHash("sha256").update(root).digest("hex")}`;
}

export function silentLauncherScript(_command, dataRoot) {
  if (!dataRoot || /[\r\n\0]/.test(dataRoot)) throw new Error("无效的启动器数据目录");
  const values = {
    DATA_ROOT: psLiteral(dataRoot),
    MUTEX_NAME: psLiteral(launcherMutexName(dataRoot)),
    WINDOW_SOURCE: windowSource,
  };
  return template.replace(/@@(DATA_ROOT|MUTEX_NAME|WINDOW_SOURCE)@@/g, (_, key) => values[key])
    .replace(/\r?\n/g, "\r\n");
}

export function silentLauncherHostScript() {
  return `Option Explicit\r\nDim shell, ps1, powershell, command\r\nIf WScript.Arguments.Count <> 1 Then WScript.Quit 64\r\nSet shell = CreateObject("WScript.Shell")\r\nps1 = WScript.Arguments(0)\r\npowershell = shell.ExpandEnvironmentStrings("%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")\r\ncommand = Chr(34) & powershell & Chr(34) & " -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & Chr(34) & ps1 & Chr(34)\r\nshell.Run command, 0, False\r\n`;
}
