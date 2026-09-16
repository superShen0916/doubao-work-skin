import test from "node:test";
import assert from "node:assert/strict";
import { CdpSession, fetchCdpJson, isSupportedPageTarget, listPageTargets } from "../src/cdp.mjs";

const assertPortOwner = async () => {};

function target(overrides = {}) {
  return {
    type: "page",
    url: "doubaowork://doubaowork-chat/example",
    webSocketDebuggerUrl: "ws://127.0.0.1:9342/example",
    ...overrides,
  };
}

test("默认 target 过滤覆盖 page/iframe 并排除高风险页面", () => {
  assert.equal(isSupportedPageTarget(target()), true);
  assert.equal(isSupportedPageTarget(target({ type: "iframe" })), true);
  assert.equal(isSupportedPageTarget(target({ type: "worker" })), false);
  assert.equal(isSupportedPageTarget(target({ url: "about:blank" })), false);
  assert.equal(isSupportedPageTarget(target({ url: "devtools://devtools/bundled" })), false);
  assert.equal(isSupportedPageTarget(target({ url: "chrome-extension://example" })), false);
  assert.equal(isSupportedPageTarget(target({ url: "https://x/cross-site-support" })), false);
  assert.equal(isSupportedPageTarget(target({ webSocketDebuggerUrl: "" })), false);
  for (const url of ["https://example.org/chat", "https://www.doubao.com/", "chrome://newtab", "file:///tmp/chat.html", "doubaowork://unrelated/chat", "invalid"]) {
    assert.equal(isSupportedPageTarget(target({ url })), false);
  }
});

test("HTTP 与 WebSocket 均在任何网络连接之前检查端口归属", async () => {
  const rejectOwner = async () => { throw new Error("wrong application"); };
  await assert.rejects(fetchCdpJson(9342, "/json/list", {
    assertPortOwner: rejectOwner,
    fetchImpl: () => assert.fail("不能发起 HTTP 请求"),
  }), /wrong application/);
  const session = new CdpSession(target(), 9342, {
    assertPortOwner: rejectOwner,
    WebSocketImpl: class { constructor() { assert.fail("不能建立 WebSocket"); } },
  });
  await assert.rejects(session.open(), /wrong application/);
});

test("端口被另一个应用接管后，下一次请求会重新检查归属", async () => {
  let owned = true;
  let fetched = 0;
  const options = {
    assertPortOwner: async () => { if (!owned) throw new Error("owner changed"); },
    fetchImpl: async () => { fetched++; return { ok: true, json: async () => [] }; },
  };
  await listPageTargets(9342, options);
  owned = false;
  await assert.rejects(listPageTargets(9342, options), /owner changed/);
  assert.equal(fetched, 1);
});

test("listPageTargets 支持调用方传入更窄过滤器", async () => {
  const list = [target({ type: "page", id: "page" }), target({ type: "iframe", id: "iframe" })];
  const fetchImpl = async () => ({ ok: true, json: async () => list });
  const pages = await listPageTargets(9342, {
    fetchImpl,
    assertPortOwner,
    filter: (entry) => entry.type === "page",
  });
  assert.deepEqual(pages.map((entry) => entry.id), ["page"]);
});

test("fetchCdpJson 固定使用 127.0.0.1 并检查 HTTP 状态", async () => {
  let requestedUrl;
  const value = await fetchCdpJson(9342, "/json/version", {
    assertPortOwner,
    fetchImpl: async (url, options) => {
      assert.equal(options.redirect, "error");
      requestedUrl = url;
      return { ok: true, json: async () => ({ Browser: "test" }) };
    },
  });
  assert.equal(requestedUrl, "http://127.0.0.1:9342/json/version");
  assert.deepEqual(value, { Browser: "test" });
  await assert.rejects(
    fetchCdpJson(9342, "/json/list", {
      assertPortOwner,
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    /HTTP 503/,
  );
});

test("fetchCdpJson 拒绝非法端口和路径", async () => {
  await assert.rejects(fetchCdpJson(0, "/json/list"), /无效 CDP 端口/);
  await assert.rejects(fetchCdpJson(9342, "json/list"), /无效 CDP 路径/);
});

test("连接失败包含 CDP 地址和底层错误码", async () => {
  await assert.rejects(fetchCdpJson(9342, "/json/version", {
    assertPortOwner,
    fetchImpl: async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); },
  }), /127\.0\.0\.1:9342\/json\/version: ECONNREFUSED/);
});

class FakeWebSocket {
  constructor() {
    this.listeners = new Map();
    this.sent = [];
    queueMicrotask(() => this.emit("open", {}));
  }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  send(payload) {
    this.sent.push(payload);
  }
  close() {
    this.emit("close", {});
  }
  emit(name, event) {
    for (const listener of this.listeners.get(name) || []) listener(event);
  }
}

test("CDP 拒绝远端、跨端口或携带凭据的 WebSocket", () => {
  for (const url of [
    "ws://example.com:9342/page", "ws://127.0.0.1:9343/page",
    "ws://user:pass@127.0.0.1:9342/page", "wss://127.0.0.1:9342/page",
  ]) {
    assert.throws(() => new CdpSession(target({ webSocketDebuggerUrl: url }), 9342), /本机回环地址/);
  }
});

test("CDP 会话关闭时拒绝全部 pending 命令", async () => {
  const sockets = [];
  class WebSocketImpl extends FakeWebSocket {
    constructor() {
      super();
      sockets.push(this);
    }
  }
  const session = await new CdpSession(target(), 9342, { WebSocketImpl, assertPortOwner }).open();
  const pending = session.send("Runtime.evaluate", {}, 2_000);
  sockets[0].close();
  await assert.rejects(pending, /会话已关闭/);
  await assert.rejects(session.send("Runtime.evaluate"), /会话已关闭/);
});
