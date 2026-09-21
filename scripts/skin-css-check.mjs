import fs from "node:fs/promises";
import path from "node:path";

function splitSelectors(source) {
  const selectors = [];
  let start = 0, depth = 0, quote = null;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") { i++; continue; }
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (char === "," && depth === 0) {
      selectors.push(source.slice(start, i));
      start = i + 1;
    }
  }
  selectors.push(source.slice(start));
  return selectors;
}

export async function checkSkinNoWildcardColor(skinsDir) {
  const errors = [];
  for (const entry of await fs.readdir(skinsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cssPath = path.join(skinsDir, entry.name, "skin.css");
    let css;
    try {
      css = await fs.readFile(cssPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    // 检查叶子规则，也覆盖 @media 内的普通规则。
    const ruleRegex = /([^{}]+)\{([^{}]*)\}/g;
    css = css.replace(/\/\*[\s\S]*?\*\//g, "");
    let match;
    while ((match = ruleRegex.exec(css)) !== null) {
      const selector = match[1].trim();
      const body = match[2];
      // 每个选择器独立检查；:where(...) 内的逗号不拆分。
      const hasChatWildcard = splitSelectors(selector).some(part =>
        /receive_message|send_message|chat_input/.test(part)
        && /(^|[\s>])\*(?=[\s,{]|$)/.test(part));
      const setsTextColor = /(^|[\s;{])color\s*:/i.test(body);
      if (hasChatWildcard && setsTextColor) {
        // 裸通配符不能因同组其他选择器带有 :not(:where(...)) 而被放行。
        errors.push(
          `${entry.name}: 检测到聊天内容区通配改色规则 "${selector.slice(0, 80)}..."，请用 :not(:where(...)) 排除交互元素（链接、chips、文档卡片），详见 CONTRIBUTING.md`
        );
      }
    }
  }
  return errors;
}
