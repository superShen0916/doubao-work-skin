// v2.2.1 及更早的内置主题、从它们复制的个人主题仍可能包含此选择器。
// 只在组装注入 CSS 时修正已知旧规则，绝不改写个人主题文件。
const LEGACY_STATUS_SELECTOR = 'div[class*="flex-col-reverse"][class*="input-guidance"] > *:not([data-testid="chat_input"])';
const DECORATION_EXCLUSION = ':not([class~="z-[-1]"])';
const OLD_DECORATION_EXCLUSION = ':not([class*="z-[-1]"])';

export function compatibleThemeCss(source) {
  let result = "";
  for (let i = 0; i < source.length;) {
    // 跳过注释与字符串，避免改动 content、URL 或用户的示例文字。
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      const next = end < 0 ? source.length : end + 2;
      result += source.slice(i, next);
      i = next;
    } else if (source.startsWith(LEGACY_STATUS_SELECTOR, i)) {
      const next = i + LEGACY_STATUS_SELECTOR.length;
      result += LEGACY_STATUS_SELECTOR;
      if (!source.startsWith(DECORATION_EXCLUSION, next) && !source.startsWith(OLD_DECORATION_EXCLUSION, next)) {
        result += DECORATION_EXCLUSION;
      }
      i = next;
    } else if (source[i] === '"' || source[i] === "'") {
      const quote = source[i];
      let next = i + 1;
      while (next < source.length) {
        if (source[next] === "\\") next += 2;
        else if (source[next++] === quote) break;
      }
      result += source.slice(i, next);
      i = next;
    } else {
      result += source[i++];
    }
  }
  return result;
}

// 放在主题 CSS 之后，覆盖旧版主题中同等优先级的菜单毛玻璃声明。
// 不改变弹窗、输入框等其他表面的毛玻璃，也不依赖具体主题 ID。
export const MENU_COMPAT_CSS = `
/* 旧版个人主题兼容：固定定位子菜单不能受父菜单毛玻璃裁剪。 */
[role="menu"] {
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}
`;
