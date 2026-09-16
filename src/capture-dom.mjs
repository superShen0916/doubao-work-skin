#!/usr/bin/env node
/**
 * 豆包工作 DOM 结构探查工具
 * ============================
 * 连接豆包工作的 CDP 端口，导出脱敏的 DOM 结构快照，用于：
 *   1. 分析三栏布局的 DOM 结构和 class 命名规律
 *   2. 建立选择器契约（selectors.json）
 *   3. 版本升级后对比 DOM 变化
 *
 * 用法:
 *   node src/capture-dom.mjs --port 9342              # 单次快照
 *   node src/capture-dom.mjs --port 9342 --watch      # 巡游模式（操作应用，自动抓取每个新状态）
 *   node src/capture-dom.mjs --port 9342 --out out.json
 *
 * 隐私保护：
 *   - 不采集任何文本内容（仅记录节点是否含直接文本）
 *   - 属性值只保留结构类白名单（role/type、明确列举的 data-* 和 aria 状态，且值 <= 80 字符）
 *   - 不保存 URL、路由、target 标题或页面签名原文
 *   - 不采集窗口标题
 *
 * 需要 Node.js 22+
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const TOOL_VERSION = "0.1.0";
const DEFAULT_WAIT_SECONDS = 30;
import { CdpSession, fetchCdpJson, isSupportedPageTarget, listPageTargets } from "./cdp.mjs";

// ============================================================
// 页面侧采集函数（完全自包含，注入页面执行）
// ============================================================
export function pageCapture() {
  if (typeof document === "undefined" || !document?.documentElement || document.readyState === "loading") {
    return { notReady: true, readyState: (typeof document === "undefined" ? "no-document" : document.readyState) };
  }
  const stats = { nodes: 0, truncatedDepth: 0, truncatedChildren: 0, truncatedMax: 0 };
  const classSet = new Set();
  const testidSet = new Set();
  const roleSet = new Set();

  const VALUE_OK = /^(?:role|type|dir|hidden|disabled|contenteditable|tabindex|data-(?:testid|state|theme|appearance|color-mode)|aria-(?:expanded|selected|checked|current|hidden|haspopup|modal|orientation|live|disabled|pressed))$/i;
  const MAX_NODES = 30000;
  const MAX_DEPTH = 40;
  const MAX_CHILDREN = 200;

  function serialize(el, depth) {
    if (!el || !el.tagName) return null;
    if (stats.nodes >= MAX_NODES) { stats.truncatedMax++; return null; }
    stats.nodes++;
    const node = { t: el.tagName.toLowerCase() };
    if (el.id && el.id.length <= 64) node.i = el.id;
    const classes = [];
    for (let ci = 0; ci < el.classList.length; ci++) {
      const cls = el.classList[ci];
      classes.push(cls);
      classSet.add(cls);
    }
    if (classes.length) node.c = classes.slice(0, 48);
    let attrs = null;
    for (let ai = 0; ai < el.attributes.length; ai++) {
      const attr = el.attributes[ai];
      if (attr.name === "class" || attr.name === "id") continue;
      if (VALUE_OK.test(attr.name) && attr.value.length <= 80) {
        (attrs = attrs || {})[attr.name] = attr.value;
        if (attr.name === "data-testid") testidSet.add(attr.value);
        if (attr.name === "role") roleSet.add(attr.value);
      }
    }
    if (attrs) node.a = attrs;
    // 是否含直接文本
    let child = el.firstChild;
    while (child) {
      if (child.nodeType === 3 && child.nodeValue && child.nodeValue.trim()) { node.x = 1; break; }
      child = child.nextSibling;
    }
    if (el.shadowRoot) node.sr = el.shadowRoot.childElementCount;
    const kids = el.children;
    if (kids.length) {
      if (depth >= MAX_DEPTH) { stats.truncatedDepth++; node.d = kids.length; }
      else {
        if (kids.length > MAX_CHILDREN) { stats.truncatedChildren++; node.n = kids.length; }
        const out = [];
        const limit = Math.min(kids.length, MAX_CHILDREN);
        for (let ki = 0; ki < limit; ki++) {
          const s = serialize(kids[ki], depth + 1);
          if (s) out.push(s);
          if (stats.nodes >= MAX_NODES) break;
        }
        if (out.length) node.k = out;
      }
    }
    return node;
  }

  const tree = serialize(document.documentElement, 0);

  // CSS Modules 分析
  const modules = {};
  classSet.forEach(cls => {
    const m = /^_([A-Za-z][A-Za-z0-9-]*?)_([a-z0-9]{3,12})(?:_\d+)?$/.exec(cls);
    if (m) (modules[m[1]] = modules[m[1]] || []).push(m[2]);
  });
  Object.keys(modules).forEach(k => { modules[k] = Array.from(new Set(modules[k])).sort(); });

  // 外观信号
  const root = document.documentElement;
  const appearance = {
    rootClasses: Array.from(root.classList).sort(),
    bodyClasses: document.body ? Array.from(document.body.classList).sort() : [],
    computedColorScheme: (() => { try { return getComputedStyle(root).colorScheme || ""; } catch { return ""; } })(),
    dataTheme: root.getAttribute("data-theme") || null,
    dataAppearance: root.getAttribute("data-appearance") || null,
    dataColorMode: root.getAttribute("data-color-mode") || null,
  };

  return {
    meta: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    },
    appearance,
    features: {
      hasSelector: (() => { try { return CSS.supports("selector(:has(*))"); } catch { return false; } })(),
      adoptedStyleSheets: "adoptedStyleSheets" in document,
      navigationApi: typeof navigation !== "undefined" && Boolean(navigation),
    },
    summaries: {
      uniqueClassCount: classSet.size,
      classes: Array.from(classSet).sort().slice(0, 2000),
      modules,
      testids: Array.from(testidSet).sort().slice(0, 500),
      roles: Array.from(roleSet).sort(),
    },
    stats,
    tree,
  };
}

// 页面签名（用于巡游模式检测状态变化）
function pageSignature() {
  if (typeof document === "undefined" || !document?.documentElement) return { notReady: true };
  const rootClasses = Array.from(document.documentElement.classList).sort().join(".");
  const bodyClasses = document.body ? Array.from(document.body.classList).sort().join(".") : "";
  const route = location.hash ? location.hash.split("?")[0].slice(0, 64) : location.pathname.slice(0, 64);
  // 统计主要容器数量
  const asideCount = document.querySelectorAll("aside").length;
  const mainCount = document.querySelectorAll("main").length;
  const navCount = document.querySelectorAll("nav").length;
  return { s: `${route}|${rootClasses}|${bodyClasses}|${asideCount}|${mainCount}|${navCount}` };
}

// ============================================================
// 参数解析
// ============================================================
function parseArgs(argv) {
  const opts = { port: null, out: null, waitSeconds: DEFAULT_WAIT_SECONDS, watch: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--wait") opts.waitSeconds = Number(argv[++i]);
    else if (a === "--watch") opts.watch = true;
    else throw new Error(`未知参数: ${a}`);
  }
  if (!opts.port) throw new Error("必须指定 --port");
  return opts;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function discover(port, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const version = await fetchCdpJson(port, "/json/version", { timeoutMs: 2000 });
      return { port, version };
    } catch {}
    await sleep(1500);
  }
  return null;
}

function timestamp() {
  const d = new Date();
  const p = v => String(v).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function printSummary(entry) {
  const d = entry.data;
  console.log(`\n── 页面 ${entry.index} ──`);
  if (d.error) { console.log(`  采集失败: ${d.error}`); return; }
  console.log(`  节点 ${d.stats.nodes} · 唯一类名 ${d.summaries.uniqueClassCount} · testid ${d.summaries.testids.length} · role ${d.summaries.roles.length}`);
  console.log(`  外观: colorScheme=${d.appearance.computedColorScheme || "?"} dataTheme=${d.appearance.dataTheme || "-"} dataColorMode=${d.appearance.dataColorMode || "-"}`);
  console.log(`  root classes: ${d.appearance.rootClasses.join(" ") || "(none)"}`);
  console.log(`  body classes: ${d.appearance.bodyClasses.join(" ") || "(none)"}`);
  if (d.summaries.testids.length) {
    console.log(`  data-testid (${d.summaries.testids.length}): ${d.summaries.testids.slice(0, 20).join(", ")}${d.summaries.testids.length > 20 ? " ..." : ""}`);
  }
  if (d.summaries.roles.length) {
    console.log(`  roles: ${d.summaries.roles.join(", ")}`);
  }
  const moduleNames = Object.keys(d.summaries.modules);
  if (moduleNames.length) {
    console.log(`  CSS Modules (${moduleNames.length}): ${moduleNames.slice(0, 15).join(", ")}${moduleNames.length > 15 ? " ..." : ""}`);
  }
}

// ============================================================
// 巡游模式
// ============================================================
async function watchMode(opts, found) {
  const captureExpr = `(${pageCapture.toString()})()`;
  const sigExpr = `(${pageSignature.toString()})()`;
  const states = [];
  const seen = new Set();
  let stopped = false;
  let interrupts = 0;

  process.on("SIGINT", () => {
    interrupts++;
    if (interrupts >= 2) process.exit(130);
    stopped = true;
    console.log("\n收到 Ctrl+C，正在写盘...（再按一次强制退出）");
  });

  console.log("\n========================================");
  console.log("巡游模式已启动：请在豆包工作里依次操作，每个新状态会自动抓取");
  console.log("========================================");
  console.log("建议操作顺序:");
  console.log("  1. 首页（任务列表那屏）");
  console.log("  2. 打开一个任务（查看执行过程）");
  console.log("  3. 打开成果预览区（右侧栏）");
  console.log("  4. 收起/展开左侧栏");
  console.log("  5. 打开设置/偏好菜单");
  console.log("  6. 切换亮色/暗色主题（如果有）");
  console.log("  7. 新建任务对话框");
  console.log("全部点完后回到终端按 Ctrl+C 结束。\n");

  let connection = null;
  let pendingSig = null;
  let stableTicks = 0;
  const deadline = Date.now() + 30 * 60 * 1000; // 30分钟上限

  while (!stopped && Date.now() < deadline && states.length < 20) {
    if (!connection || connection.closed) {
      connection?.close();
      try {
        const targets = await listPageTargets(found.port, { filter: t => t.type === "page" && isSupportedPageTarget(t) });
        if (targets.length) {
          connection = await new CdpSession(targets[0], found.port).open();
        }
      } catch { connection = null; }
      if (!connection) { await sleep(1500); continue; }
    }
    let sig = null;
    try { sig = await connection.evaluate(sigExpr); } catch { await sleep(900); continue; }
    if (!sig || sig.notReady) { await sleep(900); continue; }
    if (sig.s !== pendingSig) { pendingSig = sig.s; stableTicks = 0; }
    else { stableTicks++; }
    if (stableTicks === 1 && !seen.has(sig.s)) {
      try {
        const data = await connection.evaluate(captureExpr);
        if (data && !data.error && !data.notReady) {
          seen.add(sig.s);
          states.push({ index: states.length + 1, signature: createHash("sha256").update(sig.s).digest("hex"), data });
          console.log(`  ✔ 状态 #${states.length}: 节点 ${data.stats.nodes} · 类名 ${data.summaries.uniqueClassCount}`);
        }
      } catch (e) {
        console.log(`  ⚠ 本状态抓取失败: ${String(e.message || e).slice(0, 80)}`);
      }
    }
    await sleep(700);
  }
  connection?.close();

  if (!states.length) { console.error("没有捕获到任何状态。"); process.exit(4); }

  const fixture = {
    schema: "doubao-work-dom-fixture/1",
    tool: { name: "capture-dom", version: TOOL_VERSION, mode: "watch" },
    capturedAt: new Date().toISOString(),
    host: { platform: os.platform(), release: os.release(), arch: os.arch(), node: process.version },
    cdp: { port: found.port, version: { Browser: found.version?.Browser, "Protocol-Version": found.version?.["Protocol-Version"] } },
    targets: states,
  };
  const outFile = opts.out || path.resolve(`doubao-work-dom-fixture-${timestamp()}.json`);
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  const body = JSON.stringify(fixture, null, 1);
  await fs.writeFile(outFile, body, { mode: 0o600 });
  await fs.chmod(outFile, 0o600);
  console.log(`\n共捕获 ${states.length} 个状态:`);
  for (const s of states) console.log(`  #${s.index} ${s.signature}`);
  console.log(`\n→ 已写入 ${outFile} (${(body.length/1024/1024).toFixed(2)} MB)`);
  console.log("下一步: 分析该 JSON，提取三栏布局的稳定选择器，写入 src/selectors.json");
  process.exitCode = 0;
}

// ============================================================
// 主入口
// ============================================================
async function main() {
  const opts = parseArgs(process.argv);
  const found = await discover(opts.port, opts.waitSeconds);
  if (!found) {
    console.error(`未发现 CDP 端口 ${opts.port}。请先用启动脚本启动豆包工作（带 --remote-debugging-port）。`);
    process.exit(2);
  }
  console.log(`✔ CDP 端口 ${opts.port} · ${found.version?.Browser || "unknown"}`);

  if (opts.watch) { await watchMode(opts, found); return; }

  // 单次模式
  const targets = await listPageTargets(opts.port, { filter: t => t.type === "page" && isSupportedPageTarget(t) });
  if (!targets.length) { console.error("该端口上没有可用的页面 target。"); process.exit(3); }

  const captureExpr = `(${pageCapture.toString()})()`;
  const captured = [];
  for (const [index, target] of targets.slice(0, 4).entries()) {
    let session = null;
    try {
      session = await new CdpSession(target, opts.port).open();
      let data = await session.evaluate(captureExpr);
      const readyDeadline = Date.now() + 25000;
      while (data?.notReady && Date.now() < readyDeadline) { await sleep(1200); data = await session.evaluate(captureExpr); }
      if (data?.notReady) data = { error: `页面始终未就绪 (${data.readyState})` };
      captured.push({ index: index + 1, data });
    } catch (e) {
      captured.push({ index: index + 1, data: { error: String(e.message || e) } });
    } finally { session?.close(); }
  }

  for (const entry of captured) printSummary(entry);

  const fixture = {
    schema: "doubao-work-dom-fixture/1",
    tool: { name: "capture-dom", version: TOOL_VERSION },
    capturedAt: new Date().toISOString(),
    host: { platform: os.platform(), release: os.release(), arch: os.arch(), node: process.version },
    cdp: { port: found.port, version: { Browser: found.version?.Browser, "Protocol-Version": found.version?.["Protocol-Version"] } },
    targets: captured,
  };
  const outFile = opts.out || path.resolve(`doubao-work-dom-fixture-${timestamp()}.json`);
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  const body = JSON.stringify(fixture, null, 1);
  await fs.writeFile(outFile, body, { mode: 0o600 });
  await fs.chmod(outFile, 0o600);
  console.log(`\n→ 已写入 ${outFile} (${(body.length/1024/1024).toFixed(2)} MB)`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(e => { console.error(`失败: ${e.message}`); process.exitCode = 1; });
}
