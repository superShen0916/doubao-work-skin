import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { withScreenshotAppearance } from "../scripts/capture-screenshots.mjs";

test("截图成功或失败都清理临时样式和旧定时器，不扫描或删除业务 DOM", async () => {
  for (const fail of [false, true]) {
    const nodes = new Map();
    const cleared = [];
    const window = { __wmInterval: 42, __removeWatermark: () => {} };
    const document = {
      getElementById: id => nodes.get(id),
      createElement: () => {
        const node = { remove: () => nodes.delete(node.id) };
        return node;
      },
      head: { appendChild: node => nodes.set(node.id, node) },
      querySelectorAll: () => { throw new Error("禁止扫描业务 DOM"); },
    };
    const context = vm.createContext({ window, document, clearInterval: id => cleared.push(id) });
    const session = { evaluate: source => vm.runInContext(source, context) };
    const capture = async () => {
      assert.equal(nodes.size, 1);
      assert.equal(window.__wmInterval, undefined);
      if (fail) throw new Error("capture failed");
      return "png";
    };
    if (fail) await assert.rejects(withScreenshotAppearance(session, capture), /capture failed/);
    else assert.equal(await withScreenshotAppearance(session, capture), "png");
    assert.equal(nodes.size, 0);
    assert.deepEqual(cleared, [42]);
    assert.equal(window.__removeWatermark, undefined);
  }
});
