// 截图脚本：切换皮肤并截取聊天页。临时隐藏侧栏和输入内容，不删除应用节点。
// 应用水印可能包含个人信息，发布截图前需人工检查。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listPageTargets, CdpSession } from '../src/cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHOT_DIR = path.join(ROOT, 'screenshots');
const PORT = 9342;

const SKINS = [
  { id: 'seaside-breeze', name: '海风微语' },
  { id: 'sunlit-atelier', name: '晴窗猫咪' },
  { id: 'windborne-terrace', name: '风起云庭' },
];

async function findChatTarget() {
  const targets = await listPageTargets(PORT);
  return targets.find(t => t.type === 'page' && t.url.includes('chat'));
}

async function ensureNewChat(session) {
  const url = await session.evaluate("location.href");
  if (!url.endsWith("/chat") && !url.endsWith("/chat/")) {
    await session.evaluate(`(() => {
      const all = [...document.querySelectorAll("button, [role=button], a")];
      const btn = all.find(e => /新对话|new.?chat/i.test(e.getAttribute("aria-label") || e.title || e.innerText || ""));
      if (btn) btn.click();
    })()`);
    await new Promise(r => setTimeout(r, 2000));
  }
}

// 只在截图期间添加静态 CSS；不轮询、不遍历全 DOM、不触发水印删除/重建循环。
export function screenshotAppearance(enabled) {
  if (window.__wmInterval != null) clearInterval(window.__wmInterval);
  delete window.__wmInterval;
  delete window.__removeWatermark;
  const id = 'doubao-work-screenshot-style';
  document.getElementById(id)?.remove();
  if (!enabled) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `
    [data-testid="chat_route_layout_leftside_nav"] { display: none !important; }
    [data-testid="chat_input"] [contenteditable],
    [data-testid="chat_input"] textarea { visibility: hidden !important; }
  `;
  document.head.appendChild(style);
}

export async function withScreenshotAppearance(session, capture) {
  try {
    await session.evaluate(`(${screenshotAppearance.toString()})(true)`);
    return await capture();
  } finally {
    await session.evaluate(`(${screenshotAppearance.toString()})(false)`);
  }
}

async function screenshot(skinId) {
  const target = await findChatTarget();
  if (!target) throw new Error('未找到聊天页 target');
  const session = await new CdpSession(target, PORT).open();
  try {
    await ensureNewChat(session);
    const result = await withScreenshotAppearance(session, async () => {
      await new Promise(r => setTimeout(r, 1500));
      return session.send('Page.captureScreenshot', { format: 'png' });
    });
    const buf = Buffer.from(result.data, 'base64');
    const outPath = path.join(SHOT_DIR, `${skinId}.png`);
    fs.writeFileSync(outPath, buf);
    console.log(`✓ ${skinId}: ${(buf.length / 1024 / 1024).toFixed(1)}MB -> ${outPath}`);
  } finally {
    session.close();
  }
}

async function switchSkin(skinId) {
  const { execSync } = await import('node:child_process');
  execSync(`node skin.mjs switch ${skinId}`, { cwd: ROOT, stdio: 'inherit' });
  await new Promise(r => setTimeout(r, 4000));
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  for (const skin of SKINS) {
    console.log(`\n=== ${skin.name} (${skin.id}) ===`);
    await switchSkin(skin.id);
    await screenshot(skin.id);
  }
  console.log('\n全部截图完成；发布前请检查水印及个人信息。');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`截图失败: ${error.message}`); process.exitCode = 1; });
}
