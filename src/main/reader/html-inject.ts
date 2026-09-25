/**
 * 章节 HTML 的净化与注入。
 *
 * 信任模型（想清楚再改）：
 * - iframe 的 origin 是 `arale://<id>`，外壳是 `file://`，两者跨域 → 书里的脚本**碰不到**
 *   父窗口的 DOM，也碰不到 Node/Electron（`nodeIntegration:false`、`contextIsolation:true`、
 *   `sandbox:true`）。
 * - 但 `sandbox="allow-scripts allow-same-origin"` 意味着书里的脚本能在**自己那个 origin
 *   里**跑，能发 `postMessage`、能读自己 origin 下的文件。父窗口按 `FUSHI_BRIDGE_TAG` +
 *   `event.source === iframe.contentWindow` 双重校验，所以伪造的消息进不来。
 * - 净化本身是**纵深防御**，不是唯一防线。这也是为什么它可以用正则而不是一个完整 HTML
 *   parser：正则漏掉的东西打不到外壳。
 *
 * 用正则而不是 parse5 的另一个理由：章节可能 100KB+，而我们要在每个章节首次打开时跑一次；
 * 正则一遍扫完比建 DOM 快一个数量级，且不会改变原文的空白/实体（改动了就可能让 EPUB 的
 * CSS 选择器失配，这是 Fushi 在 WebView 里踩过的坑）。
 */

/** 阅读器注入的样式。刻意用 CSS 变量，让桥接脚本能热改而不重载文档。 */
export const READER_CSS = `
:root {
  --arale-font-scale: 1;
  --arale-font-family: "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif CJK JP", serif;
  --arale-line-height: 1.9;
  --arale-margin: 40px;
  --arale-bg: #fbfbf9;
  --arale-fg: #1c1c1c;
}
html { background: var(--arale-bg); }
body {
  background: var(--arale-bg);
  color: var(--arale-fg);
  font-family: var(--arale-font-family);
  font-size: calc(16px * var(--arale-font-scale));
  line-height: var(--arale-line-height);
  margin: 0 auto;
  padding: 24px var(--arale-margin) 96px;
  max-width: 46em;
  overflow-wrap: break-word;
  -webkit-font-smoothing: antialiased;
}
.arale-vertical {
  writing-mode: vertical-rl;
  max-width: none;
  max-height: calc(100vh - 160px);
  margin: 0 auto;
  padding: 24px var(--arale-margin);
}
img, svg, video { max-width: 100%; height: auto; }
img { break-inside: avoid; }
a { color: #1a5fb4; text-decoration: none; }
a:hover { text-decoration: underline; }
ruby > rt { font-size: 0.5em; }
.arale-highlight {
  position: absolute;
  background: rgba(255, 205, 60, 0.5);
  box-shadow: 0 0 0 1px rgba(190, 140, 0, 0.55);
  border-radius: 2px;
  pointer-events: none;
  z-index: 2147483647;
}
/* 隐藏 EPUB 自带的、在桌面端只会碍事的固定尺寸容器 */
body > div[style*="height: 100%"] { height: auto !important; }
`;

/** 需要整段删掉的元素（连同内容）。 */
const DROP_ELEMENTS = ['script', 'iframe', 'object', 'embed', 'applet', 'base'];

/** 从 XHTML 里抽出 `<body>` 内容；没有 body 就返回原串。 */
function bodyInner(html: string): string {
  const match = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return match?.[1] ?? html;
}

/**
 * 净化：删脚本/嵌入对象、删 `on*` 事件属性、废掉 `javascript:` URL。
 *
 * 注意 `base` 也要删——书里放一个 `<base href="http://evil">` 会把所有相对资源
 * 重定向到外网（这是真实的 EPUB 攻击面，不是臆想）。我们的相对资源解析必须落在
 * 章节自身 URL 上。
 */
export function sanitizeChapterHtml(html: string): string {
  let out = html;
  for (const tag of DROP_ELEMENTS) {
    // 带内容的一对标签（`<script>` 必须优先于自闭合形式处理）。
    const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
    out = out.replace(paired, '');
    // 自闭合 / 未闭合形式。
    const selfClosing = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi');
    out = out.replace(selfClosing, '');
  }
  // on* 事件属性（引号成对、单引号、无引号三种写法都要覆盖）。
  out = out.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // javascript: / vbscript: 协议。
  out = out.replace(/\b(href|src|xlink:href)\s*=\s*(?:"|')?\s*(?:javascript|vbscript)\s*:/gi, '$1="about:blank#blocked"');
  return out;
}

export interface InjectOptions {
  /** 是否注入阅读样式。 */
  css?: boolean;
  /** 是否注入桥接脚本。 */
  bridge?: boolean;
  /** 注入的桥接脚本源码（见 shared/reader-bridge.ts）。 */
  bridgeSource: string;
  /** 只想抽正文时设为 true：不注入任何东西，返回 body 内容。 */
  bodyOnly?: boolean;
}

/**
 * 合成最终发给 iframe 的 HTML 文档。
 *
 * **不能重造文档骨架**（这是改之前犯过的错）：EPUB 的排版几乎全靠 `<head>` 里的
 * `<link rel="stylesheet">` / `<style>`——竖排、ruby、图片尺寸、分栏全在里面。把
 * `<body>` 内容抠出来重新包一层，书会立刻「能读但全乱」。所以这里走**原地注入**：
 * 保留原文档，只做三件事——
 * 1. 剥掉脚本/嵌入对象/`on*`/`javascript:`（sanitize）；
 * 2. 把 charset 统一成 UTF-8（原文档常声明成旧编码，我们按 UTF-8 读的字节，
 *    留着旧声明只会乱码）；
 * 3. 把阅读样式与桥接脚本插到 `<head>` 末尾 / `</body>` 前。
 *
 * 插在 `<head>` **末尾**是刻意的：同优先级下后出现的规则胜出，这样阅读器的字号变量
 * 能盖住书的默认值，但又不需要 `!important` 去和书的排版规则打架。
 */
export function buildChapterDocument(rawHtml: string, options: InjectOptions): string {
  if (options.bodyOnly) return bodyInner(rawHtml);

  let html = sanitizeChapterHtml(rawHtml);

  // 统一编码声明：先删掉原有的一切 charset 声明，再在最前面补一个。
  html = html.replace(/<meta\b[^>]*charset[^>]*>/gi, '');
  // 桌面端不需要 EPUB 的 viewport（有的还会锁死缩放），删掉。
  html = html.replace(/<meta\b[^>]*name\s*=\s*["']viewport["'][^>]*>/gi, '');

  const charsetMeta = '<meta charset="utf-8">';
  const css = options.css === false ? '' : `<style>${READER_CSS}</style>`;
  const headExtra = `${charsetMeta}${css}`;

  if (/<head\b[^>]*>/i.test(html)) {
    // charset 必须在文档前 1024 字节内才被采纳，所以它紧跟在 `<head>` 之后。
    html = html.replace(/<head\b[^>]*>/i, (match) => `${match}\n${charsetMeta}`);
    // 阅读样式放 head 末尾，保证在同优先级下后手胜出。
    html = /<\/head\s*>/i.test(html)
      ? html.replace(/<\/head\s*>/i, `${css}\n</head>`)
      : html.replace(/<head\b[^>]*>/i, (match) => `${match}${css}`);
  } else if (/<html\b[^>]*>/i.test(html)) {
    html = html.replace(/<html\b[^>]*>/i, (match) => `${match}\n<head>${headExtra}</head>`);
  } else {
    html = `<!DOCTYPE html>\n<html lang="ja">\n<head>${headExtra}</head>\n<body>${html}</body>\n</html>`;
  }

  if (options.bridge !== false && options.bridgeSource) {
    const script = `<script>${options.bridgeSource}<\/script>`;
    html = /<\/body\s*>/i.test(html)
      ? html.replace(/<\/body\s*>/i, `${script}\n</body>`)
      : `${html}\n${script}`;
  }

  return html;
}

/**
 * CSP 头。`'unsafe-inline'` 是必须的——桥接脚本与阅读样式都是内联注入的。
 * `connect-src 'none'` 断掉书页往外发请求的能力（追踪像素/信标）。
 * `frame-src 'none'` 阻止书里再嵌 frame。
 */
export const CHAPTER_CSP = [
  "default-src 'self' arale: data:",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' arale: data:",
  "img-src arale: data:",
  "font-src arale: data:",
  "media-src arale: data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

/** 扩展名 → MIME。刻意不覆盖 `.js`：书里的脚本已被剥掉，真请求到也不该给可执行类型。 */
const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.xhtml': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.opf': 'application/xml; charset=utf-8',
  '.ncx': 'application/xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
};

export function mimeFor(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME_BY_EXT[filePath.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

export function isMarkup(mime: string): boolean {
  return mime.startsWith('text/html');
}
