import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { compatibleThemeCss } from "../src/theme-compat.mjs";

const selector = 'div[class*="flex-col-reverse"][class*="input-guidance"] > *:not([data-testid="chat_input"])';

test("旧状态条规则兼容可重复执行，保留自定义声明", async () => {
  const source = await fs.readFile(new URL("fixtures/legacy-theme.css", import.meta.url), "utf8");
  const fixed = compatibleThemeCss(source);
  assert.ok(fixed.includes(`${selector}:not([class~="z-[-1]"])`));
  assert.ok(fixed.includes("#personal-card { color: rgb(123, 45, 67); border-radius: 23px; }"));
  assert.equal(compatibleThemeCss(fixed), fixed);
  const alreadyFixed = `${selector}:not([class*="z-[-1]"]) { color: red; }`;
  assert.equal(compatibleThemeCss(alreadyFixed), alreadyFixed);
});

test("兼容处理不改动注释、字符串、转义引号及无关选择器", () => {
  const untouched = `/* ${selector} */\n.example::after { content: '${selector}'; }\n.other { content: 'escaped\\' ${selector}'; }\n[data-note='${selector}'] { color: pink; }`;
  assert.equal(compatibleThemeCss(untouched), untouched);
  assert.equal(compatibleThemeCss(`/* unfinished ${selector}`), `/* unfinished ${selector}`);
});
