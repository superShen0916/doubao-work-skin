import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKIN_VERSION = pkg.version;
export const PROJECT_ROOT = path.resolve(HERE, "..");
export const DEFAULT_SKINS_DIR = process.env.DWS_SKINS_DIR || path.join(PROJECT_ROOT, "skins");
export const BASE_CSS_PATH = path.join(HERE, "base.css");
export const THEME_DIRECTORY_ALIASES = Object.freeze({});

const REQUIRED_THEME_FIELDS = ["id", "name", "version", "appearance", "colors"];
const REQUIRED_COLOR_KEYS = [
  "bg-primary",
  "bg-secondary",
  "bg-tertiary",
  "text-primary",
  "text-secondary",
  "text-tertiary",
  "accent",
  "accent-alt",
  "border",
  "sidebar-bg",
  "card-bg",
  "input-bg",
  "selection-color",
];

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} 必须是非空字符串`);
  }
}

function resolveInside(directoryPath, relativePath, label) {
  assertNonEmptyString(relativePath, label);
  if (path.isAbsolute(relativePath)) throw new Error(`${label} 必须是主题目录内的相对路径`);
  const resolved = path.resolve(directoryPath, relativePath);
  const relative = path.relative(directoryPath, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} 不能越过主题目录: ${relativePath}`);
  }
  return resolved;
}

async function readExistingFile(filePath, label, { optional = false, directoryPath } = {}) {
  try {
    if (directoryPath) {
      const [root, realFile] = await Promise.all([fs.realpath(directoryPath), fs.realpath(filePath)]);
      const relative = path.relative(root, realFile);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`${label} 不能通过符号链接越过主题目录`);
      }
    }
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error(`${label} 不是文件: ${filePath}`);
    return await fs.readFile(filePath);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    if (error?.code === "ENOENT") throw new Error(`${label}不存在: ${filePath}`);
    throw error;
  }
}

function mimeFor(filePath) {
  switch (path.extname(filePath).slice(1).toLowerCase()) {
    case "webp": return "image/webp";
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    default: return "image/*";
  }
}

export function validateTheme(theme, { directoryName } = {}) {
  if (!theme || typeof theme !== "object" || Array.isArray(theme)) {
    throw new Error("theme.json 必须是 JSON 对象");
  }
  for (const field of REQUIRED_THEME_FIELDS) {
    if (!(field in theme)) throw new Error(`theme.json 缺少字段: ${field}`);
  }
  for (const field of ["id", "name", "version"]) {
    assertNonEmptyString(theme[field], `theme.${field}`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(theme.id)) {
    throw new Error(`theme.id 必须是小写 kebab-case: ${theme.id}`);
  }
  if (!new Set(["dark", "light"]).has(theme.appearance)) {
    throw new Error(`theme.appearance 仅支持 dark/light: ${theme.appearance}`);
  }
  if (!theme.colors || typeof theme.colors !== "object" || Array.isArray(theme.colors)) {
    throw new Error("theme.colors 必须是对象");
  }
  for (const key of REQUIRED_COLOR_KEYS) {
    assertNonEmptyString(theme.colors[key], `theme.colors.${key}`);
  }
  if (directoryName) {
    const expectedId = THEME_DIRECTORY_ALIASES[directoryName] || directoryName;
    if (theme.id !== expectedId) {
      throw new Error(`主题目录 ${directoryName} 与 theme.id ${theme.id} 不匹配`);
    }
  }
  const background = theme.background;
  if (background != null) {
    if (typeof background !== "object" || Array.isArray(background)) {
      throw new Error("theme.background 必须是对象");
    }
    if (background.image != null) assertNonEmptyString(background.image, "theme.background.image");
    for (const field of ["focusX", "focusY"]) {
      if (background[field] != null && (!Number.isFinite(Number(background[field])) || Number(background[field]) < 0 || Number(background[field]) > 1)) {
        throw new Error(`theme.background.${field} 必须是 0 到 1 的数字`);
      }
    }
  }
  if (theme.css != null) assertNonEmptyString(theme.css, "theme.css");
  return theme;
}

export async function discoverThemes({ skinsDir = DEFAULT_SKINS_DIR } = {}) {
  const entries = await fs.readdir(skinsDir, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const themePath = path.join(skinsDir, entry.name, "theme.json");
    try {
      await fs.access(themePath);
      result.push(entry.name);
    } catch {
      // Non-theme directories are ignored by discovery.
    }
  }
  return result;
}

export function buildVariableCss(theme, backgroundDataUrl, skinVersion = SKIN_VERSION) {
  const colors = theme.colors;
  const variables = {
    "--dws-bg": colors["bg-primary"],
    "--dws-panel": colors["bg-secondary"],
    "--dws-panel-alt": colors["bg-tertiary"],
    "--dws-text": colors["text-primary"],
    "--dws-text-muted": colors["text-secondary"],
    "--dws-text-subtle": colors["text-tertiary"],
    "--dws-accent": colors.accent,
    "--dws-accent-alt": colors["accent-alt"],
    "--dws-line": colors.border,
    "--dws-sidebar": colors["sidebar-bg"],
    "--dws-card": colors["card-bg"],
    "--dws-input": colors["input-bg"],
    "--dws-selection-color": colors["selection-color"] || "#fff",
  };
  const background = theme.background || {};
  if (background.focusX != null) variables["--dws-bg-focus-x"] = `${Math.round(Number(background.focusX) * 100)}%`;
  if (background.focusY != null) variables["--dws-bg-focus-y"] = `${Math.round(Number(background.focusY) * 100)}%`;
  if (backgroundDataUrl) variables["--dws-art"] = `url("${backgroundDataUrl}")`;

  const variableLines = Object.entries(variables)
    .filter(([, value]) => value)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");

  return `
/* === 豆包工作换肤 v${skinVersion} — 皮肤: ${theme.name || theme.id || "unknown"} === */
:root {
${variableLines}
}
/* 背景艺术由稳定的工作区锚点承载；不再铺满 body，也不再全局透明化。 */
#doubao-work-skin-bg { display: none !important; }
`;
}

export function buildThemeCss(themePackage, { skinVersion = SKIN_VERSION } = {}) {
  const prefix = buildVariableCss(themePackage.theme, themePackage.backgroundDataUrl, skinVersion);
  let css = `${prefix}\n/* === 皮肤精确选择器 CSS === */\n${themePackage.baseCss}\n`;
  if (themePackage.skinCss) css += `\n/* === 主题专属 CSS === */\n${themePackage.skinCss}\n`;
  return css;
}

export function fingerprintTheme(themePackage) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(themePackage.theme));
  hash.update("\0");
  hash.update(themePackage.baseCss);
  hash.update("\0");
  hash.update(themePackage.skinCss || "");
  hash.update("\0");
  hash.update(themePackage.backgroundDataUrl || "");
  return hash.digest("hex");
}

export async function loadTheme({ skinsDir = DEFAULT_SKINS_DIR, name, skinDir, baseCssPath = BASE_CSS_PATH } = {}) {
  const directoryPath = path.resolve(skinDir || path.join(skinsDir, name || ""));
  const directoryName = path.basename(directoryPath);
  const themePath = path.join(directoryPath, "theme.json");
  let theme;
  try {
    theme = JSON.parse((await readExistingFile(themePath, "皮肤配置", { directoryPath })).toString("utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`皮肤配置不存在: ${themePath}`);
    if (error instanceof SyntaxError) throw new Error(`皮肤配置不是有效 JSON: ${themePath}`);
    throw error;
  }
  validateTheme(theme, { directoryName });

  const baseCss = await fs.readFile(baseCssPath, "utf8");
  let backgroundDataUrl = null;
  if (theme.background?.image) {
    const backgroundPath = resolveInside(directoryPath, theme.background.image, "theme.background.image");
    const data = await readExistingFile(backgroundPath, "背景资源", { directoryPath });
    backgroundDataUrl = `data:${mimeFor(backgroundPath)};base64,${data.toString("base64")}`;
  }

  const cssRelativePath = theme.css || "skin.css";
  const skinCssPath = resolveInside(directoryPath, cssRelativePath, "theme.css");
  const skinCssBuffer = await readExistingFile(skinCssPath, "主题 CSS", { optional: theme.css == null, directoryPath });
  const skinCss = skinCssBuffer?.toString("utf8") || "";
  const themePackage = {
    directoryName,
    directoryPath,
    skinDir: directoryPath,
    theme,
    backgroundDataUrl,
    baseCss,
    skinCss,
    skinCssPath: skinCssBuffer ? skinCssPath : null,
  };
  themePackage.finalCss = buildThemeCss(themePackage);
  themePackage.fingerprint = fingerprintTheme(themePackage);
  return themePackage;
}
