import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { pageCapture } from "../src/capture-dom.mjs";
import { pageDiagnostics } from "../scripts/diagnose.mjs";
import { restoreSession, runRestore, verifySession } from "../src/injector.mjs";

function fakePage() {
  const attrs = new Map([
    ["data-theme", "light"], ["data-testid", "chat-route-layout"],
    ["data-user-id", "PRIVATE_USER"], ["data-message", "PRIVATE_MESSAGE"],
    ["aria-label", "PRIVATE_LABEL"], ["value", "PRIVATE_INPUT"],
  ]);
  const root = {
    tagName: "HTML", id: "", classList: [], children: [],
    get attributes() { return [...attrs].map(([name, value]) => ({ name, value })); },
    getAttribute: key => attrs.get(key) ?? null,
    setAttribute: (key, value) => attrs.set(key, value),
    removeAttribute: key => attrs.delete(key),
    firstChild: { nodeType: 3, nodeValue: "PRIVATE_TEXT", nextSibling: null },
  };
  const body = { classList: [], style: { background: "pink" } };
  const document = {
    documentElement: root, body, readyState: "complete",
    get title() { throw new Error("不能读取窗口标题"); },
    getElementById: () => null,
    querySelector: () => null,
  };
  const context = {
    document, window: { innerWidth: 1200, innerHeight: 800 },
    navigator: { userAgent: "test", platform: "test", language: "zh" },
    getComputedStyle: () => ({ colorScheme: "light" }),
    CSS: { supports: () => true },
    location: { protocol: "doubaowork:", hostname: "doubaowork-chat", get href() { throw new Error("不能读取页面 URL"); } },
  };
  return { context, root, body };
}

test("DOM 快照排除正文、输入值、任意 data 属性、URL 和标题", () => {
  const { context } = fakePage();
  const data = vm.runInNewContext(`(${pageCapture.toString()})()`, context);
  assert.equal(data.tree.a["data-testid"], "chat-route-layout");
  assert.equal(data.tree.x, 1);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_/);
  assert.equal(data.meta.route, undefined);
  assert.equal(data.meta.urlFile, undefined);
});

test("诊断和注入校验不读取页面标题与 URL", async () => {
  const { context } = fakePage();
  const result = vm.runInNewContext(`(${pageDiagnostics.toString()})()`, context);
  assert.equal(result.hasSkinStyle, false);
  const verified = await verifySession({ evaluate: source => vm.runInNewContext(source, context) });
  assert.equal(verified.error, undefined);
  assert.equal(verified.hasMarker, false);
});

test("未注入的页面与重复恢复必须保留应用自身外观", async () => {
  const { context, root, body } = fakePage();
  const session = { evaluate: source => vm.runInNewContext(source, context) };
  const result = await restoreSession(session);
  assert.equal(result.error, undefined);
  assert.equal(root.getAttribute("data-theme"), "light");
  assert.equal(body.style.background, "pink");

  context.window.__DOUBAO_WORK_SKIN_ACTIVE__ = { originalTheme: "dark", originalBodyBackground: "blue" };
  await restoreSession(session);
  assert.equal(root.getAttribute("data-theme"), "dark");
  assert.equal(body.style.background, "blue");
  await restoreSession(session);
  assert.equal(root.getAttribute("data-theme"), "dark");
  assert.equal(body.style.background, "blue");
});

test("恢复时全部或部分页面连接失败都必须返回失败", async () => {
  for (const partial of [false, true]) {
    const { context } = fakePage();
    let closed = false;
    const session = {
      evaluate: source => vm.runInNewContext(source, context),
      close: () => { closed = true; },
    };
    await assert.rejects(runRestore({ port: 9342 }, {
      connect: async (_port, options) => {
        options.onConnectionError({}, new Error("connection failed"));
        return partial ? [session] : [];
      },
    }), /页面连接失败|部分页面恢复未通过/);
    assert.equal(closed, partial);
  }
});
