import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_CSS_PATH,
  buildThemeCss,
  discoverThemes,
  loadTheme,
  validateTheme,
} from "../src/theme.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 共享 base.css 字节级摘要回归夹具。
const BASELINE_PATH = path.join(ROOT, "test/fixtures/final-css-sha256.json");

async function withTempDir(fn) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "doubao-work-skin-theme-"));
  try {
    return await fn(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function fixtureTheme(overrides = {}) {
  return {
    id: "sample",
    name: "Sample",
    version: "1.0.0",
    appearance: "dark",
    colors: {
      "bg-primary": "#000",
      "bg-secondary": "#111",
      "bg-tertiary": "#222",
      "text-primary": "#fff",
      "text-secondary": "#ddd",
      "text-tertiary": "#aaa",
      accent: "#09f",
      "accent-alt": "#0cf",
      border: "#333",
      "sidebar-bg": "#111",
      "card-bg": "#222",
      "input-bg": "#181818",
      "selection-color": "#fff",
    },
    ...overrides,
  };
}

test("发现主题时按目录名排序", async () => {
  assert.deepEqual(await discoverThemes(), [
    "citrus-garden",
    "cloud-botanist",
    "cloud-whale",
    "cyberpunk-neon",
    "daybreak-protocol",
    "golden-hour",
    "lucy-lunar-morning",
    "opaline-observatory",
    "porcelain-cat-moon",
    "seaside-breeze",
    "sunlit-atelier",
    "washi-crane-mist",
    "windborne-terrace",
  ]);
});

test("非别名主题的目录名必须等于 theme.id", () => {
  assert.throws(
    () => validateTheme(fixtureTheme({ id: "different" }), { directoryName: "sample" }),
    /不匹配/,
  );
});

test("拒绝缺失颜色和非法 appearance", () => {
  const invalidColors = fixtureTheme();
  delete invalidColors.colors.accent;
  assert.throws(() => validateTheme(invalidColors, { directoryName: "sample" }), /colors\.accent/);
  assert.throws(
    () => validateTheme(fixtureTheme({ appearance: "auto" }), { directoryName: "sample" }),
    /dark\/light/,
  );
});

test("拒绝背景和主题 CSS 路径穿越", async () => {
  await withTempDir(async (root) => {
    const skinDir = path.join(root, "sample");
    await fs.mkdir(skinDir);
    await fs.writeFile(path.join(root, "base.css"), "BASE");
    await fs.writeFile(path.join(skinDir, "theme.json"), JSON.stringify(fixtureTheme({
      background: { image: "../secret.png" },
    })));
    await assert.rejects(
      loadTheme({ skinDir, baseCssPath: path.join(root, "base.css") }),
      /不能越过主题目录/,
    );
  });
});

test("声明的背景资源缺失时明确失败", async () => {
  await withTempDir(async (root) => {
    const skinDir = path.join(root, "sample");
    await fs.mkdir(skinDir);
    await fs.writeFile(path.join(root, "base.css"), "BASE");
    await fs.writeFile(path.join(skinDir, "theme.json"), JSON.stringify(fixtureTheme({
      background: { image: "missing.png" },
    })));
    await assert.rejects(
      loadTheme({ skinDir, baseCssPath: path.join(root, "base.css") }),
      /背景资源不存在/,
    );
  });
});

test("主题配置、背景和 CSS 不能通过符号链接读取目录外文件", async () => {
  for (const resource of ["theme.json", "background.png", "skin.css"]) {
    await withTempDir(async (root) => {
      const skinDir = path.join(root, "sample");
      await fs.mkdir(skinDir);
      await fs.writeFile(path.join(root, "base.css"), "BASE");
      await fs.writeFile(path.join(root, "outside"), "PRIVATE DATA");
      await fs.writeFile(path.join(skinDir, "theme.json"), JSON.stringify(fixtureTheme({
        background: resource === "background.png" ? { image: resource } : undefined,
      })));
      if (resource === "theme.json") await fs.unlink(path.join(skinDir, resource));
      await fs.symlink(path.join(root, "outside"), path.join(skinDir, resource));
      await assert.rejects(loadTheme({ skinDir, baseCssPath: path.join(root, "base.css") }), /符号链接/);
    });
  }
});

test("显式 CSS 路径不能越过主题目录", async () => {
  await withTempDir(async (root) => {
    const skinDir = path.join(root, "sample");
    await fs.mkdir(skinDir);
    await fs.writeFile(path.join(root, "base.css"), "BASE");
    await fs.writeFile(path.join(skinDir, "theme.json"), JSON.stringify(fixtureTheme({ css: "../outside.css" })));
    await assert.rejects(loadTheme({ skinDir, baseCssPath: path.join(root, "base.css") }), /不能越过主题目录/);
  });
});

test("CSS 组装顺序为变量、公共 CSS、可选主题 CSS", () => {
  const themePackage = {
    theme: fixtureTheme(),
    backgroundDataUrl: null,
    baseCss: "BASE-CSS",
    skinCss: "SKIN-CSS",
  };
  const css = buildThemeCss(themePackage);
  assert.ok(css.indexOf(":root") < css.indexOf("BASE-CSS"));
  assert.ok(css.indexOf("BASE-CSS") < css.indexOf("SKIN-CSS"));
});

test("base.css 与字节级摘要一致", async () => {
  const { createHash } = await import("node:crypto");
  const baseline = JSON.parse(await fs.readFile(BASELINE_PATH, "utf8"));
  const baseCss = await fs.readFile(BASE_CSS_PATH, "utf8");
  assert.ok(baseCss.length > 20_000);
  const sha256 = createHash("sha256").update(baseCss).digest("hex");
  assert.equal(baseCss.length, baseline.baseCss.chars, "base.css 长度变化");
  assert.equal(sha256, baseline.baseCss.sha256, "base.css 摘要变化");
});
