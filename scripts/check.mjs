#!/usr/bin/env node
// 离线检查：不启动豆包工作，不连接 CDP，不改写主题。
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { discoverThemes, loadTheme } from "../src/theme.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function checkSyntax(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await checkSyntax(file);
    else if (entry.name.endsWith(".mjs")) execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    else if (entry.name.endsWith(".json")) JSON.parse(await fs.readFile(file, "utf8"));
  }
}

try {
  execFileSync(process.execPath, ["--check", path.join(root, "skin.mjs")], { stdio: "pipe" });
  for (const dir of ["src", "scripts", "test", "skins"]) await checkSyntax(path.join(root, dir));
  const names = await discoverThemes();
  if (!names.length) throw new Error("未找到主题");
  for (const name of names) {
    const { theme, backgroundDataUrl } = await loadTheme({ name });
    if (theme.background?.image !== "background.png") throw new Error(`${name}: 内置背景统一命名为 background.png`);
    if (!backgroundDataUrl?.startsWith("data:image/png;base64,iVBORw0KGgo")) throw new Error(`${name}: 背景不是 PNG`);
    console.log(`✓ ${name} (${theme.name})`);
  }
  console.log(`检查通过：源码语法、JSON、${names.length} 套主题及背景资源`);
} catch (error) {
  console.error(`检查失败: ${error.stderr?.toString().trim() || error.message}`);
  process.exitCode = 1;
}
