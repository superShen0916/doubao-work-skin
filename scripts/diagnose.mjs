#!/usr/bin/env node
// 仅输出布局与注入状态，不输出页面标题、链接、按钮文字或输入内容。
// 用法：node scripts/diagnose.mjs --target <target-id> --port 9342
import path from "node:path";
import { pathToFileURL } from "node:url";
import { connectTarget } from "../src/cdp.mjs";

export function pageDiagnostics() {
  const out = {};
  for (const testid of ["chat-route-layout", "message-list", "flow_chat_guidance_page", "chat_input"]) {
    const node = document.querySelector(`[data-testid="${testid}"]`);
    out[testid] = node ? {
      present: true,
      backgroundColor: getComputedStyle(node).backgroundColor,
      color: getComputedStyle(node).color,
      childCount: node.children.length,
    } : { present: false };
  }
  out.hasSkinStyle = !!document.getElementById("doubao-work-skin-style");
  out.hasSkinBg = !!document.getElementById("doubao-work-skin-bg");
  out.hasSkinMarker = !!window.__DOUBAO_WORK_SKIN_ACTIVE__;
  return out;
}

async function main(args = process.argv.slice(2)) {
  let targetId;
  let port = 9342;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--target") targetId = args.shift();
    else if (arg === "--port") port = Number(args.shift());
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!targetId || !/^[a-zA-Z0-9-]+$/.test(targetId)) throw new Error("必须指定有效 --target <target-id>");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("无效 --port");
  const session = await connectTarget({
    id: targetId,
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${targetId}`,
  }, port);
  try {
    console.log(JSON.stringify(await session.evaluate(`(${pageDiagnostics.toString()})()`), null, 2));
  } finally {
    session.close();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`失败: ${error.message}`); process.exitCode = 1; });
}
