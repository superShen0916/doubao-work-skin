import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkSkinNoWildcardColor } from "../scripts/skin-css-check.mjs";

async function check(css) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dws-css-check-"));
  try {
    await fs.mkdir(path.join(root, "sample"));
    await fs.writeFile(path.join(root, "sample", "skin.css"), css);
    return await checkSkinNoWildcardColor(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("文字颜色检查不误报背景、边框、变量或注释", async () => {
  assert.deepEqual(await check(`
    /* [data-testid="chat_input"] * { color: red; } */
    [data-testid="chat_input"] * {
      background-color: transparent;
      border-color: transparent;
      --custom-color: red;
      /* color: red; */
    }
  `), []);
});

test("拒绝普通和媒体查询中的聊天通配文字颜色", async () => {
  for (const css of [
    '[data-testid="chat_input"] * { color: red; }',
    '@media (min-width: 800px) { [data-testid="receive_message"] * { COLOR: red; } }',
    '[data-testid="chat_input"] *, [data-testid="send_message"] :not(:where(a, button)) { color: red; }',
  ]) assert.equal((await check(css)).length, 1, css);
});

test("允许正文排除交互元素的规则和非聊天区域规则", async () => {
  assert.deepEqual(await check(`
    [data-testid="send_message"] :not(:where(a, button, svg, [class*="chip"], [class*="resource-label"])) { color: white; }
    [data-testid="chat_input"] a { color: blue; }
    .sidebar * { color: gray; }
    .sidebar *, [data-testid="chat_input"] :not(:where(a, button)) { color: gray; }
  `), []);
});
