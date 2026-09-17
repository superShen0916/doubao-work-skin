import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import pkg from "../package.json" with { type: "json" };
import { injectToSession, restoreSession, runOnce, runVerify, verifySession } from "../src/injector.mjs";

const skin = { theme: { id: "sample", name: "Sample", appearance: "light", colors: { accent: "#123456" } }, baseCss: "", skinCss: "" };

function page({ protocol = "chrome:", hostname = "doubaowork-chat", layout = true, main = true } = {}) {
  const nodes = new Map();
  const attributes = new Map([["data-theme", "dark"]]);
  const context = {
    window: {}, location: { protocol, hostname },
    document: {
      body: { style: { background: "black" } },
      documentElement: {
        getAttribute: key => attributes.get(key) ?? null,
        setAttribute: (key, value) => attributes.set(key, value),
        removeAttribute: key => attributes.delete(key),
      },
      head: { appendChild: node => nodes.set(node.id, node) },
      querySelector: selector => (selector === '#chat-route-main' ? main : layout) ? {} : null,
      getElementById: id => nodes.get(id),
      createElement: () => {
        const node = { remove: () => nodes.delete(node.id) };
        return node;
      },
    },
  };
  const sandbox = vm.createContext(context);
  let closed = false;
  return {
    context, nodes, attributes,
    get closed() { return closed; },
    session: { evaluate: source => vm.runInContext(source, sandbox), close: () => { closed = true; } },
  };
}

test("有效豆包工作聊天页正常注入、校验并恢复", async () => {
  const p = page();
  assert.equal(await injectToSession(p.session, skin), true);
  assert.equal(p.nodes.size, 1);
  assert.equal(p.attributes.get("data-theme"), "light");
  const result = await verifySession(p.session);
  assert.equal(result.isAppPage, true);
  assert.equal(result.markerTheme, "sample");
  assert.equal(result.markerVersion, pkg.version);
  await restoreSession(p.session);
  assert.equal(p.nodes.size, 0);
  assert.equal(p.attributes.get("data-theme"), "dark");
  assert.deepEqual(Object.keys(p.context.window), []);
});

test("重新注入时同步旧标记版本并保留原生外观用于恢复", async () => {
  const p = page();
  await injectToSession(p.session, skin);
  p.context.window.__DOUBAO_WORK_SKIN_ACTIVE__.version = "old-version";
  await injectToSession(p.session, skin);
  assert.equal((await verifySession(p.session)).markerVersion, pkg.version);
  await restoreSession(p.session);
  assert.equal(p.attributes.get("data-theme"), "dark");
  assert.equal(p.context.document.body.style.background, "black");
});

test("普通网页、内嵌 iframe 和缺少布局的页面不写入样式或全局变量", async () => {
  for (const options of [{ protocol: "https:" }, { hostname: "newtab" }, { layout: false }, { main: false }]) {
    const p = page(options);
    assert.equal(await injectToSession(p.session, skin), false);
    assert.equal(p.nodes.size, 0);
    assert.equal(p.attributes.get("data-theme"), "dark");
    assert.deepEqual(Object.keys(p.context.window), []);
  }
});

test("校验后页面发生导航，注入时仍重新判断当前页面", async () => {
  const p = page();
  assert.equal((await verifySession(p.session)).isAppPage, true);
  p.context.location.protocol = "https:";
  assert.equal(await injectToSession(p.session, skin), false);
  assert.deepEqual(Object.keys(p.context.window), []);
});

test("只有不匹配的页面时不能报告验证成功", async () => {
  const p = page({ layout: false });
  await assert.rejects(runVerify({ port: 9342 }, {
    connect: async () => [p.session], load: async () => skin,
  }), /未找到可验证/);
  assert.equal(p.closed, true);
});

test("恢复仍能清理旧版向普通 iframe 注入的痕迹", async () => {
  const p = page();
  await injectToSession(p.session, skin);
  // 模拟旧版在 HTTPS iframe 内留下相同注入对象。
  p.context.location.protocol = "https:";
  await restoreSession(p.session);
  assert.equal(p.nodes.size, 0);
  assert.deepEqual(Object.keys(p.context.window), []);
});

test("CDP 已可用但聊天布局延迟加载时，等待新 target 后完成注入", async () => {
  let time = 0;
  let attempts = 0;
  const loading = page({ layout: false });
  const ready = page();
  await runOnce({ port: 9342, timeoutMs: 2_000 }, {
    now: () => time,
    sleep: async ms => { time += ms; },
    load: async () => skin,
    log: () => {},
    connect: async () => {
      attempts++;
      if (attempts === 1) return [];
      return attempts === 2 ? [loading.session] : [ready.session];
    },
  });
  assert.equal(attempts, 3);
  assert.equal(loading.nodes.size, 0);
  assert.equal(ready.nodes.size, 1);
  assert.equal(loading.closed, true);
  assert.equal(ready.closed, true);
});

test("重启中执行上下文被销毁时重新发现页面，而非立即失败", async () => {
  let time = 0;
  let attempts = 0;
  let staleClosed = false;
  const ready = page();
  await runOnce({ port: 9342, timeoutMs: 2_000 }, {
    now: () => time,
    sleep: async ms => { time += ms; },
    load: async () => skin,
    log: () => {},
    connect: async () => ++attempts === 1 ? [{
      evaluate: async () => { throw new Error("Execution context was destroyed"); },
      close: () => { staleClosed = true; },
    }] : [ready.session],
  });
  assert.equal(attempts, 2);
  assert.equal(staleClosed, true);
  assert.equal(ready.nodes.size, 1);
});

test("页面一直未就绪时按期限退出，不将跳过的页面报告为注入失败", async () => {
  let time = 0;
  let attempts = 0;
  const loading = page({ layout: false });
  await assert.rejects(runOnce({ port: 9342, timeoutMs: 750 }, {
    now: () => time,
    sleep: async ms => { time += ms; },
    load: async () => skin,
    log: () => {},
    connect: async () => { attempts++; return [loading.session]; },
  }), /聊天页就绪超时/);
  assert.equal(time, 750);
  assert.equal(attempts, 3);
  assert.equal(loading.nodes.size, 0);
  assert.equal(loading.closed, true);
});

test("等待期间发现端口不属于豆包工作时立即拒绝，不执行注入", async () => {
  await assert.rejects(runOnce({ port: 9342, timeoutMs: 1_000 }, {
    load: async () => skin,
    log: () => {},
    connect: async () => { throw new Error("已拒绝连接"); },
    inject: async () => assert.fail("禁止注入"),
    sleep: async () => assert.fail("不应重试不可信端口"),
  }), /已拒绝连接/);
});
