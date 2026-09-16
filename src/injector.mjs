#!/usr/bin/env node
/**
 * 豆包工作换肤 — 核心注入器
 * ============================
 * 通过本地 CDP（Chrome DevTools Protocol）连接豆包工作的渲染进程，
 * 注入 CSS 覆盖和背景层，实现换肤。不改安装包，不破坏签名，可一键恢复。
 *
 * 用法:
 *   node src/injector.mjs --once    --port 9342 --skin skins/seaside-breeze
 *   node src/injector.mjs --watch   --port 9342 --skin skins/seaside-breeze
 *   node src/injector.mjs --verify  --port 9342 --skin skins/seaside-breeze
 *   node src/injector.mjs --restore --port 9342
 *
 * 需要 Node.js 22+（内置 WebSocket）
 */

import { watch as watchFs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildThemeCss, loadTheme } from "./theme.mjs";
import { CdpSession, connectAllPages, isDoubaoWorkPage, isInspectablePageTarget, listPageTargets } from "./cdp.mjs";
const SKIN_VERSION = "2.1.0";

// 注入的节点 ID（用于识别和清理）
const STYLE_NODE_ID = "doubao-work-skin-style";
const BG_NODE_ID = "doubao-work-skin-bg";
const CONFIG_GLOBAL = "__DOUBAO_WORK_SKIN_CONFIG__";
const MARKER_GLOBAL = "__DOUBAO_WORK_SKIN_ACTIVE__";

// ============================================================
// 参数解析
// ============================================================
function parseArgs(argv) {
  const opts = {
    mode: null,       // once / watch / verify / restore
    port: null,
    skinDir: null,
    timeoutMs: 20000,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--once") opts.mode = "once";
    else if (arg === "--watch") opts.mode = "watch";
    else if (arg === "--verify") opts.mode = "verify";
    else if (arg === "--restore") opts.mode = "restore";
    else if (arg === "--port") opts.port = Number(argv[++i]);
    else if (arg === "--skin") opts.skinDir = argv[++i];
    else if (arg === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!opts.mode) throw new Error("必须指定模式: --once / --watch / --verify / --restore");
  if (!opts.port) throw new Error("必须指定 --port");
  if ((opts.mode === "once" || opts.mode === "watch" || opts.mode === "verify") && !opts.skinDir) {
    throw new Error("必须指定 --skin 目录");
  }
  return opts;
}

// ============================================================
// 参数解析
// 必须完全自包含，不能引用外部变量
// ============================================================
function pageBootstrapScript() {
  return `
(function() {
  if (!window.${MARKER_GLOBAL}) {
    window.${MARKER_GLOBAL} = {
      version: "${SKIN_VERSION}",
      appliedAt: Date.now(),
      originalBodyBackground: document.body ? document.body.style.background : "",
      originalTheme: document.documentElement.getAttribute("data-theme")
    };
  }

  function applySkin(config) {
    if (!config) return;
    // 1. 创建/更新 style 节点（挂在 head）
    let style = document.getElementById("${STYLE_NODE_ID}");
    if (!style) {
      style = document.createElement("style");
      style.id = "${STYLE_NODE_ID}";
      document.head.appendChild(style);
    }
    style.textContent = config.css || "";

    // 2. 大尺寸背景图通过独立 img 节点承载，避免 Chromium 丢弃超长 CSS 声明。
    let bg = document.getElementById("${BG_NODE_ID}");
    if (config.backgroundDataUrl) {
      if (!bg) {
        bg = document.createElement("img");
        bg.id = "${BG_NODE_ID}";
        bg.alt = "";
        bg.setAttribute("aria-hidden", "true");
      }
      bg.src = config.backgroundDataUrl;
      bg.style.setProperty("display", "block", "important");
      bg.style.setProperty("position", "absolute", "important");
      bg.style.setProperty("inset", "0", "important");
      bg.style.setProperty("width", "100%", "important");
      bg.style.setProperty("height", "100%", "important");
      bg.style.setProperty("z-index", "0", "important");
      bg.style.setProperty("pointer-events", "none", "important");
      bg.style.setProperty("object-fit", "cover", "important");
      bg.style.setProperty("object-position", config.backgroundPosition || "50% 50%", "important");
      const host = document.querySelector('[data-testid="chat-route-layout"]');
      if (host && bg.parentElement !== host) host.prepend(bg);
      if (!host && bg) bg.remove();
    } else if (bg) {
      bg.remove();
    }

    // 3. 使用应用原生主题令牌，避免自行覆盖所有组件状态。
    if (config.appearance === "dark" || config.appearance === "light") {
      document.documentElement.setAttribute("data-theme", config.appearance);
    }

    // 4. 可见背景节点由上面的 img 承载；页面重建和节点丢失由 watch 轮询自愈，
    //    不在页面内注册不可逆的 MutationObserver。
    window.${MARKER_GLOBAL}.appliedAt = Date.now();
    window.${MARKER_GLOBAL}.themeId = config.themeId || null;
  }

  function removeSkin() {
    const state = window.${MARKER_GLOBAL};
    delete window.${CONFIG_GLOBAL};
    const style = document.getElementById("${STYLE_NODE_ID}");
    if (style) style.remove();
    // 兼容旧版注入：仍清理可能残留的占位 bg 节点与旧 observer 句柄。
    const bg = document.getElementById("${BG_NODE_ID}");
    if (bg) bg.remove();
    if (document.body) {
      document.body.style.background = state?.originalBodyBackground || "";
    }
    const originalTheme = state?.originalTheme;
    if (originalTheme == null) document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", originalTheme);
    delete window.${MARKER_GLOBAL};
    delete window.__doubaoWorkSkin;
  }

  // 暴露全局接口
  window.__doubaoWorkSkin = { apply: applySkin, remove: removeSkin };

  // 如果已有配置，立即应用
  if (window.${CONFIG_GLOBAL}) {
    applySkin(window.${CONFIG_GLOBAL});
  }
})();
`;
}

// ============================================================
// 核心操作
// ============================================================
export async function injectToSession(session, skin, { timeoutMs = 30_000 } = {}) {
  const css = buildThemeCss({ ...skin, backgroundDataUrl: null }, { skinVersion: SKIN_VERSION });
  const config = {
    css,
    backgroundDataUrl: skin.backgroundDataUrl || null,
    backgroundPosition: `${Math.round(Number(skin.theme.background?.focusX ?? 0.5) * 100)}% ${Math.round(Number(skin.theme.background?.focusY ?? 0.5) * 100)}%`,
    themeId: skin.theme.id || null,
    themeName: skin.theme.name || null,
    appearance: skin.theme.appearance || null,
    injectedAt: new Date().toISOString(),
  };

  // 身份检查与页面写入放在同一次执行中，避免两次调用之间导航到无关页面。
  return await session.evaluate(`
    (function() {
      if (!(${isDoubaoWorkPage.toString()})()) return false;
      window.${CONFIG_GLOBAL} = ${JSON.stringify(config)};
      ${pageBootstrapScript()}
      if (window.__doubaoWorkSkin && window.${CONFIG_GLOBAL}) {
        window.__doubaoWorkSkin.apply(window.${CONFIG_GLOBAL});
      }
      return window.${MARKER_GLOBAL} ? true : false;
    })();
  `, true, timeoutMs);
}

export async function verifySession(session, skin) {
  try {
    const result = await session.evaluate(`
      (function() {
        const marker = window.${MARKER_GLOBAL};
        const style = document.getElementById("${STYLE_NODE_ID}");
        const bg = document.getElementById("${BG_NODE_ID}");
        return {
          isAppPage: (${isDoubaoWorkPage.toString()})(),
          hasMarker: !!marker,
          markerVersion: marker?.version || null,
          markerTheme: marker?.themeId || null,
          hasStyle: !!style,
          hasBg: !!bg,
          hasChatLayout: Boolean(document.querySelector('[data-testid="chat-route-layout"]')),
          styleLength: style ? style.textContent.length : 0,
        };
      })();
    `);
    return result;
  } catch (e) {
    return { error: e.message };
  }
}

export async function restoreSession(session) {
  try {
    const cleanup = await session.evaluate(`
      (function() {
        // 兼容旧版曾注入的 iframe；没有本工具痕迹的页面不作任何写入。
        if (!window.${MARKER_GLOBAL} && !window.${CONFIG_GLOBAL} &&
            !document.getElementById("${STYLE_NODE_ID}") && !document.getElementById("${BG_NODE_ID}")) {
          return { skipped: true };
        }
        // 先删除配置，确保旧版 MutationObserver 即使仍存活也不会重新注入。
        delete window.${CONFIG_GLOBAL};
        const state = window.${MARKER_GLOBAL};
        if (state && state.observer) {
          try { state.observer.disconnect(); } catch {}
        }
        // 兼容调用页面中已存在的旧版/新版清理 API，但不信任它能彻底清理。
        if (window.__doubaoWorkSkin && typeof window.__doubaoWorkSkin.remove === "function") {
          try { window.__doubaoWorkSkin.remove(); } catch {}
        }
        // 无条件二次清理，覆盖旧版 API 删除后又被观察器回注的情况。
        const originalTheme = state?.originalTheme;
        const originalBodyBackground = state?.originalBodyBackground;
        delete window.${CONFIG_GLOBAL};
        document.getElementById("${STYLE_NODE_ID}")?.remove();
        document.getElementById("${BG_NODE_ID}")?.remove();
        if (state) {
          if (document.body) document.body.style.background = originalBodyBackground || "";
          if (originalTheme == null) document.documentElement.removeAttribute("data-theme");
          else document.documentElement.setAttribute("data-theme", originalTheme);
        }
        delete window.${MARKER_GLOBAL};
        delete window.__doubaoWorkSkin;
        return {
          style: Boolean(document.getElementById("${STYLE_NODE_ID}")),
          bg: Boolean(document.getElementById("${BG_NODE_ID}")),
          marker: Boolean(window.${MARKER_GLOBAL}),
          config: Boolean(window.${CONFIG_GLOBAL}),
          api: Boolean(window.__doubaoWorkSkin),
          dataTheme: document.documentElement.getAttribute("data-theme"),
          inlineBodyBackground: document.body ? document.body.style.background : null
        };
      })();
    `);
    if (cleanup?.style || cleanup?.bg || cleanup?.marker || cleanup?.config || cleanup?.api) {
      throw new Error(`页面残留未清除: ${JSON.stringify(cleanup)}`);
    }
    return cleanup;
  } catch (e) {
    return { error: e.message };
  }
}

// ============================================================
// 模式实现
// ============================================================
export async function runOnce(opts, {
  connect = connectAllPages,
  load = loadTheme,
  inject = injectToSession,
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = console.log,
} = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeout-ms 必须是正数");
  const skin = await load({ skinDir: opts.skinDir });
  log(`[once] 皮肤: ${skin.theme.name || skin.theme.id} (v${skin.theme.version || "?"})`);
  log(`[once] 连接 CDP ${opts.port}，等待聊天页就绪（最多 ${timeoutMs / 1000} 秒）...`);
  const deadline = now() + timeoutMs;
  let lastIssue = "尚未出现符合条件的聊天布局";

  do {
    // CDP 可用并不代表聊天页已加载；每轮重新发现，覆盖 launcher -> chat 和页面重建。
    const sessions = await connect(opts.port, {
      listTimeoutMs: Math.max(1, Math.min(2_000, deadline - now())),
      openTimeoutMs: Math.max(1, Math.min(2_000, deadline - now())),
      onConnectionError: (_target, error) => { lastIssue = error.message; },
    });
    let success = 0;
    try {
      for (const session of sessions) {
        if (now() >= deadline) break;
        try {
          if (await inject(session, skin, { timeoutMs: Math.max(1, Math.min(5_000, deadline - now())) })) success++;
        } catch (error) {
          // 启动期间 target 可能被替换或执行上下文销毁，下一轮连接新页面。
          lastIssue = error.message;
        }
      }
    } finally {
      for (const session of sessions) session.close();
    }
    if (success > 0) {
      log(`[once] 完成: ${success} 个聊天页注入成功`);
      return;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(300, remaining));
  } while (now() < deadline);

  throw new Error(`等待豆包工作聊天页就绪超时（${timeoutMs / 1000} 秒）：${lastIssue}。请确认应用已进入聊天界面后重试。`);
}

export async function runVerify(opts, { connect = connectAllPages, load = loadTheme } = {}) {
  console.log(`[verify] 验证皮肤注入 (端口 ${opts.port})...`);
  const skin = await load({ skinDir: opts.skinDir });
  let connectionFailed = false;
  const sessions = await connect(opts.port, {
    onConnectionError: (_target, error) => {
      connectionFailed = true;
      console.error(`  连接页面失败: ${error.message}`);
    },
  });
  if (sessions.length === 0) {
    throw new Error("未找到豆包工作页面 target");
  }

  let allPass = !connectionFailed;
  let appPages = 0;
  for (const session of sessions) {
    const result = await verifySession(session, skin);
    if (result.error) {
      console.log(`  ✘ 页面 target: ${result.error}`);
      allPass = false;
    } else if (result.isAppPage) {
      appPages++;
      const expectsBackground = Boolean(skin.backgroundDataUrl && result.hasChatLayout);
      const pass = result.hasMarker && result.hasStyle && result.markerTheme === skin.theme.id && (!expectsBackground || result.hasBg);
      const status = pass ? "✔" : "✘";
      console.log(`  ${status} 页面 target`);
      console.log(`      marker=${result.hasMarker} style=${result.hasStyle}(${result.styleLength}字节) bg=${result.hasBg} theme=${result.markerTheme}`);
      if (!pass) allPass = false;
    }
    session.close();
  }

  if (allPass && appPages > 0) {
    console.log("[verify] ✅ 全部验证通过");
    return;
  } else {
    throw new Error(appPages === 0 ? "未找到可验证的豆包工作聊天页" : "部分验证未通过");
  }
}

export async function runRestore(opts, { connect = connectAllPages } = {}) {
  console.log(`[restore] 恢复官方外观 (端口 ${opts.port})...`);
  let connectionFailed = false;
  const sessions = await connect(opts.port, {
    targetFilter: isInspectablePageTarget,
    onConnectionError: (_target, error) => {
      connectionFailed = true;
      console.error(`  连接页面失败: ${error.message}`);
    },
  });
  if (sessions.length === 0) {
    if (connectionFailed) throw new Error("页面连接失败，无法确认外观已恢复");
    console.log("[restore] 未找到页面 target（应用可能已退出）");
    return;
  }

  let allPass = !connectionFailed;
  for (const session of sessions) {
    const result = await restoreSession(session);
    if (result.error) {
      console.log(`  ✘ 恢复失败: ${result.error}`);
      allPass = false;
    } else {
      console.log(`  ✔ 已恢复: 页面 target`);
    }
    session.close();
  }
  if (!allPass) throw new Error("部分页面恢复未通过");
  console.log("[restore] 完成");
}

async function runWatch(opts) {
  console.log(`[watch] 守护模式启动 (端口 ${opts.port}, 皮肤 ${opts.skinDir})`);
  let skin = await loadTheme({ skinDir: opts.skinDir });
  const sessions = new Map();
  let syncing = false;

  async function synchronizeTargets(forceInject = false) {
    if (syncing) return;
    syncing = true;
    try {
      const targets = await listPageTargets(opts.port);
      const liveIds = new Set(targets.map(t => t.id));

      for (const [id, session] of sessions) {
        if (!liveIds.has(id) || session.closed) {
          session.close();
          sessions.delete(id);
        }
      }

      for (const target of targets) {
        let session = sessions.get(target.id);
        if (!session || session.closed) {
          try {
            session = await new CdpSession(target, opts.port).open();
            sessions.set(target.id, session);
            forceInject = true;
            console.log(`[watch] 发现页面: 页面 target`);
          } catch (e) {
            console.error(`[watch] 连接页面失败: ${e.message}`);
            continue;
          }
        }

        try {
          const state = await verifySession(session, skin);
          if (!state.error && !state.isAppPage) continue;
          const expectsBackground = Boolean(skin.backgroundDataUrl && state.hasChatLayout);
          const needsInject = forceInject || state.error || !state.hasMarker || !state.hasStyle || state.markerTheme !== skin.theme.id || (expectsBackground && !state.hasBg);
          if (needsInject) {
            if (await injectToSession(session, skin)) console.log(`[watch] 已注入: 页面 target`);
          }
        } catch (e) {
          console.error(`[watch] 页面检查/注入失败: ${e.message}`);
          session.close();
          sessions.delete(target.id);
        }
      }
    } catch (e) {
      if (sessions.size > 0) console.error(`[watch] CDP 暂不可用: ${e.message}`);
      for (const session of sessions.values()) session.close();
      sessions.clear();
    } finally {
      syncing = false;
    }
  }

  await synchronizeTargets(true);

  const watcher = watchFs(opts.skinDir, { recursive: true }, async (eventType, filename) => {
    if (!filename) return;
    console.log(`[watch] 皮肤文件变化: ${filename} (${eventType})，重新加载...`);
    try {
      skin = await loadTheme({ skinDir: opts.skinDir });
      await synchronizeTargets(true);
      console.log("[watch] 热更新完成");
    } catch (e) {
      console.error(`[watch] 重新加载皮肤失败: ${e.message}`);
    }
  });

  // 同时承担三件事：发现新 target、页面导航后重新注入、样式节点被移除后的自愈。
  const healthCheck = setInterval(() => synchronizeTargets(false), 3000);

  const shutdown = () => {
    console.log("\n[watch] 收到退出信号，正在停止...");
    clearInterval(healthCheck);
    watcher.close();
    for (const session of sessions.values()) session.close();
    sessions.clear();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("[watch] 守护进程运行中（Ctrl+C 停止）...");
  await new Promise(() => {});
}

// ============================================================
// 入口
// ============================================================
async function main() {
  try {
    const opts = parseArgs(process.argv);
    switch (opts.mode) {
      case "once": await runOnce(opts); break;
      case "watch": await runWatch(opts); break;
      case "verify": await runVerify(opts); break;
      case "restore": await runRestore(opts); break;
      default: throw new Error(`未知模式: ${opts.mode}`);
    }
  } catch (e) {
    console.error(`\n❌ 失败: ${e.message}`);
    if (e.stack && process.env.DEBUG) console.error(e.stack);
    process.exit(1);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
