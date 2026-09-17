import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { buildThemeCss, discoverThemes, loadTheme } from "../src/theme.mjs";

const browser = process.env.DWS_TEST_BROWSER || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function runBrowser(args, screenshot) {
  return new Promise((resolve, reject) => {
    let output = "";
    let screenshotReady = !screenshot;
    let completed = false;
    const child = execFile(browser, args, {
      timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error && !completed) reject(new Error(`样式测试浏览器失败: ${error.code || error.signal}\n${stderr.slice(-2000)}`));
      else resolve(stdout);
    });
    const finish = () => {
      if (!completed && screenshotReady && output.includes("</html>")) {
        completed = true;
        // 某些受管理的 Chrome 在 dump 完成后仍驻留；只退出本测试创建的进程。
        child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", chunk => { output += chunk; finish(); });
    child.stderr.on("data", () => {
      if (screenshot) fs.access(screenshot).then(() => { screenshotReady = true; finish(); }, () => {});
    });
  });
}

// 仅在临时 profile 中打开合成页面；不连接豆包工作或用户的浏览器会话。
function checkStyles(themes) {
  const failures = [];
  const style = document.createElement("style");
  document.head.append(style);
  const byId = id => document.getElementById(id);
  const check = (condition, message) => { if (!condition) failures.push(message); };
  for (const { id, css } of themes) {
    style.textContent = css;
    const label = message => `${id}: ${message}`;
    for (const decoration of document.querySelectorAll(".decoration")) {
      const computed = getComputedStyle(decoration);
      check(computed.backgroundColor === "rgba(0, 0, 0, 0)", label("装饰层背景应保持透明"));
      check(computed.borderTopWidth === "0px", label("装饰层不应出现边框"));
      check(computed.boxShadow === "none", label("装饰层不应出现卡片阴影"));
      check(getComputedStyle(decoration.firstElementChild).color === "rgb(1, 2, 3)", label("装饰层后代不应被运行状态条改色"));
    }
    const status = getComputedStyle(byId("status"));
    check(status.backgroundColor !== "rgba(0, 0, 0, 0)", label("真实运行状态条应保留背景"));
    check(status.borderTopWidth === "1px", label("真实运行状态条应保留边框"));
    check(getComputedStyle(byId("status-button")).borderRadius === "8px", label("状态条按钮应保留样式"));
    for (const id of ["menu", "submenu", "wrapped-menu"]) {
      check(getComputedStyle(byId(id)).backdropFilter === "none", label(`${id} 不应建立 backdrop-filter 包含块`));
    }
    const submenu = byId("submenu");
    const rect = submenu.getBoundingClientRect();
    check(rect.left === 250 && rect.top === 80, label("固定子菜单应相对视口定位"));
    const hit = document.elementFromPoint(rect.left + 20, rect.top + 20);
    check(hit === submenu || submenu.contains(hit), label("超出父菜单的子菜单应可见且可点击"));
    byId("submenu-button").focus();
    check(document.activeElement === byId("submenu-button"), label("子菜单应可获得键盘焦点"));
    byId("submenu-button").click();
    check(byId("submenu-button").dataset.clicked === "yes", label("子菜单按钮应可交互"));
    delete byId("submenu-button").dataset.clicked;
  }
  byId("result").textContent = JSON.stringify({ themes: themes.length, failures });
}

test("浏览器验证全部主题：装饰层隔离、运行状态条与嵌套菜单", async t => {
  try { await fs.access(browser, fs.constants.X_OK); }
  catch (error) {
    if (process.env.DWS_TEST_BROWSER || process.env.CI) throw error;
    t.skip("未安装 Chrome；可通过 DWS_TEST_BROWSER 指定 Chromium 可执行文件");
    return;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dws-css-browser-"));
  try {
    const themes = [];
    for (const name of await discoverThemes()) {
      const theme = await loadTheme({ name });
      themes.push({ id: name, css: buildThemeCss({ ...theme, backgroundDataUrl: null }) });
    }
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body { margin: 0; }
      #menu { position: absolute; left: 20px; top: 60px; width: 180px; height: 160px; overflow-x: hidden; }
      #submenu { position: fixed; left: 250px; top: 80px; width: 180px; height: 120px; }
      #wrapped-menu { position: absolute; left: 500px; top: 80px; }
      #inputs { position: absolute; left: 20px; top: 300px; width: 600px; }
      .decoration { height: 2px; color: rgb(1, 2, 3); }
      #status { padding: 12px; }
    </style></head><body>
      <div id="menu" role="menu">父菜单
        <div id="submenu" role="menu"><button id="submenu-button" role="menuitem" onclick="this.dataset.clicked='yes'">推理强度：高</button></div>
      </div>
      <div data-radix-popper-content-wrapper><div id="wrapped-menu" role="menu">浮层菜单</div></div>
      <div id="inputs"><div class="flex-col-reverse input-guidance">
        <div class="decoration z-[-1]"><span>装饰</span></div>
        <div data-testid="chat_input"><div class="guidance-input-surface">输入框</div></div>
        <div class="decoration z-[-1]"><span>装饰</span></div>
        <div id="status">正在生成 <button id="status-button">停止</button></div>
      </div></div>
      <pre id="result"></pre>
      <script>(${checkStyles.toString()})(${JSON.stringify(themes).replaceAll("<", "\\u003c")})</script>
    </body></html>`;
    const file = path.join(directory, "fixture.html");
    await fs.writeFile(file, html);
    const screenshot = path.join(directory, "fixture.png");
    const stdout = await runBrowser([
      "--headless", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
      "--disable-component-update", "--disable-sync", "--disable-extensions", "--timeout=10000",
      `--user-data-dir=${path.join(directory, "profile")}`, "--window-size=1100,800",
      ...(process.env.DWS_TEST_ARTIFACTS ? [`--screenshot=${screenshot}`] : []),
      "--dump-dom", pathToFileURL(file).href,
    ], process.env.DWS_TEST_ARTIFACTS ? screenshot : null);
    if (process.env.DWS_TEST_ARTIFACTS) {
      await fs.mkdir(process.env.DWS_TEST_ARTIFACTS, { recursive: true });
      await fs.copyFile(file, path.join(process.env.DWS_TEST_ARTIFACTS, "fixture.html"));
      await fs.copyFile(screenshot, path.join(process.env.DWS_TEST_ARTIFACTS, "fixture.png"));
    }
    const result = stdout.match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
    assert.ok(result, "浏览器未返回样式检查结果");
    const report = JSON.parse(result.replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&"));
    assert.equal(report.themes, themes.length);
    assert.deepEqual(report.failures, []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});
