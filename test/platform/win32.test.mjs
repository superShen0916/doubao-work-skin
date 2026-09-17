/**
 * Windows 平台层纯函数单元测试
 *
 * 只测试不依赖 PowerShell/COM 的纯输出函数：
 * shellQuote、generateCliEntry、launcherScripts、paths。
 * 需要真实 Windows 环境的函数（discoverAppInstall、launchStoreApp 等）
 * 由 CI 的 windows-latest 矩阵端到端覆盖。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

// 直接导入 win32 实现，绕过 platform/index.mjs 的 process.platform 选择
import * as win32 from "../../src/platform/win32.mjs";

test("shellQuote：纯 ASCII 标识符不加引号", () => {
  assert.equal(win32.shellQuote("node"), "node");
  assert.equal(win32.shellQuote("C:/node/node.exe"), "C:/node/node.exe");
  assert.equal(win32.shellQuote("skin.cmd"), "skin.cmd");
});

test("shellQuote：含空格路径加双引号", () => {
  assert.equal(win32.shellQuote("C:\\Program Files\\node\\node.exe"),
    '"C:\\Program Files\\node\\node.exe"');
});

test("shellQuote：内嵌双引号转义为 \\\"", () => {
  assert.equal(win32.shellQuote('say "hello"'), '"say \\"hello\\""');
});

test("shellQuote：含 & | ^ 等 cmd 特殊字符加引号", () => {
  assert.equal(win32.shellQuote("a&b"), '"a&b"');
  assert.equal(win32.shellQuote("a|b"), '"a|b"');
  assert.equal(win32.shellQuote("a^b"), '"a^b"');
});

test("generateCliEntry：生成合法 .cmd 入口，含 chcp 和安全 set", () => {
  const entry = win32.generateCliEntry(
    "C:\\Users\\Test User\\AppData\\Local\\DoubaoWorkSkin",
    "C:\\Users\\Test User\\AppData\\Local\\DoubaoWorkSkin\\engine\\runtime\\node.exe",
    "C:\\Users\\Test User\\AppData\\Local\\DoubaoWorkSkin\\engine\\scripts\\installed-cli.mjs",
  );
  // CRLF 行尾
  assert.ok(entry.includes("\r\n"), "应使用 CRLF 行尾");
  // chcp 65001
  assert.ok(entry.includes("chcp 65001"), "应设置 UTF-8 代码页");
  // 安全 set 写法（带引号）
  assert.ok(entry.includes('set "DWS_STATE_ROOT='), "set 应使用安全引号形式");
  // node 和 bridge 路径被双引号包裹
  assert.ok(entry.includes('"C:\\Users\\Test User\\AppData\\Local\\DoubaoWorkSkin\\engine\\runtime\\node.exe"'));
  assert.ok(entry.includes('"C:\\Users\\Test User\\AppData\\Local\\DoubaoWorkSkin\\engine\\scripts\\installed-cli.mjs"'));
  // %* 透传参数
  assert.ok(entry.includes("%*"), "应透传命令行参数");
  // 清理 NODE_OPTIONS / NODE_PATH
  assert.ok(entry.includes("set NODE_OPTIONS="));
  assert.ok(entry.includes("set NODE_PATH="));
});

test("launcherScripts：生成三个启动脚本，文件名和内容正确", () => {
  const command = "C:\\Users\\Test\\skin.cmd";
  const scripts = win32.launcherScripts(command);
  const names = Object.keys(scripts);
  assert.deepEqual(names, ["启动豆包工作.cmd", "恢复官方外观.cmd", "复制换肤提示词.cmd"]);

  // 所有脚本都有 chcp 和 setlocal
  for (const text of Object.values(scripts)) {
    assert.ok(text.includes("chcp 65001"), `${text} 应含 chcp`);
    assert.ok(text.includes("setlocal"), `${text} 应含 setlocal`);
    assert.ok(text.includes(`call "${command}"`), `${text} 应调用 command`);
  }

  // 启动脚本：start 失败时 exit 2，提示用户确认后 --force
  const launcher = scripts["启动豆包工作.cmd"];
  assert.ok(launcher.includes("start"));
  assert.ok(launcher.includes("--force"));
  assert.ok(launcher.includes("exit /b 2"));

  // 恢复脚本：调用 disable
  assert.ok(scripts["恢复官方外观.cmd"].includes("disable"));

  // 复制提示词脚本：调用 prompt 并管道到 clip
  const copy = scripts["复制换肤提示词.cmd"];
  assert.ok(copy.includes("prompt"));
  assert.ok(copy.includes("clip"));
});

test("paths：返回 dataRoot、defaultSkinsDir、desktopDir", () => {
  const p = win32.paths();
  assert.ok(p.dataRoot);
  assert.equal(typeof p.defaultSkinsDir, "string");
  assert.ok(p.desktopDir);
  // dataRoot 应是绝对路径
  assert.ok(path.isAbsolute(p.dataRoot), "dataRoot 应为绝对路径");
});

test("paths：DWS_STATE_ROOT 环境变量覆盖 dataRoot", () => {
  const original = process.env.DWS_STATE_ROOT;
  try {
    process.env.DWS_STATE_ROOT = "D:\\custom\\root";
    const p = win32.paths();
    assert.equal(p.dataRoot, path.resolve("D:\\custom\\root"));
  } finally {
    if (original === undefined) delete process.env.DWS_STATE_ROOT;
    else process.env.DWS_STATE_ROOT = original;
  }
});
