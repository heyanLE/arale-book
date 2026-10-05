/** Browser-safe glossary HTML rendering and sanitizing. */
import type { GlossaryContent } from '../../shared/types';
import { toGlossaryContent } from './model';
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
// ---------------------------------------------------------------------------
// 释义 HTML 渲染 + 白名单清洗
// ---------------------------------------------------------------------------

/**
 * 允许出现在释义里的标签。Yomitan 的词条 HTML 是**可信度有限**的富文本：
 * 正常用 `<a>/<span>/<div>/<ruby>/<rt>/<ul>/<table>` 这些，但不保证没有脚本。
 * `img` 不在表里（图片走结构化内容/媒体 URL，<img src=x onerror=...> 是最常见的 XSS 载荷）。
 */
const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup',
  'dd', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'kbd', 'li', 'mark', 'ol', 'p', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span',
  'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'pre', 'del',
  'ul', 'var', 'wbr',
]);

/** 允许保留的属性。`style` 一律丢弃（样式只由结构化内容的 style 字段生成）。 */
const ALLOWED_ATTRS = new Set(['href', 'title', 'class', 'lang', 'dir', 'colspan', 'rowspan', 'alt']);

const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const SCRIPT_BLOCK_RE = /<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;

/**
 * 转义文本，但保留本来就是实体的写法（`&nbsp;` 不会被二次转义成 `&amp;nbsp;`）。
 * Yomitan 的释义串里实体很常见，全量转义会把 `&nbsp;` 直接显示出来。
 */
function escapeFragment(text: string): string {
  return text
    .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeFragment(value).replace(/"/g, '&quot;');
}

/**
 * 解数字字符引用（`&#115;` / `&#x73;` → `s`），命名实体直接丢弃。
 * 必须先解码再判协议：`java&#115;cript:` 在浏览器里就是 `javascript:`。
 */
function decodeEntities(value: string): string {
  const toChar = (code: number): string =>
    Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_all, hex: string) => toChar(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, dec: string) => toChar(Number(dec)))
    .replace(/&[a-zA-Z][a-zA-Z0-9]*;/g, '');
}

/** 协议白名单：`javascript:` / `vbscript:` / `data:`（非图片）一律拒绝，含实体混淆与控制字符。 */
function isSafeUrl(url: string): boolean {
  const decoded = decodeEntities(url)
    .replace(/[\u0000-\u0020\u007f]/g, '')
    .toLowerCase();
  if (decoded.startsWith('javascript:') || decoded.startsWith('vbscript:')) return false;
  if (decoded.startsWith('data:') && !decoded.startsWith('data:image/')) return false;
  return true;
}

function parseAttributes(raw: string): string {
  let out = '';
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(raw)) !== null) {
    const name = match[1]!.toLowerCase();
    if (name.startsWith('on')) continue; // 事件处理器一律丢
    const isAllowed = ALLOWED_ATTRS.has(name) || name.startsWith('data-');
    if (!isAllowed) continue;
    const value = match[2] ?? match[3] ?? match[4];
    if (value === undefined) {
      out += ` ${name}`;
      continue;
    }
    if ((name === 'href') && !isSafeUrl(value)) continue;
    out += ` ${name}="${escapeAttribute(value)}"`;
  }
  return out;
}

/**
 * 释义 HTML 清洗：允许表内标签，剥掉 `on*` 事件属性与 `javascript:` 链接，
 * 其余一切（含表外标签）转义成文本。
 *
 * 注意：`<script>`/`<style>` 连同内容整体删除，而不是转义 —— 否则用户会看到
 * 一坨脚本源码。
 */
export function sanitizeGlossaryHtml(html: string): string {
  const work = html.replace(COMMENT_RE, '').replace(SCRIPT_BLOCK_RE, '');
  const out: string[] = [];
  let last = 0;
  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(work)) !== null) {
    out.push(escapeFragment(work.slice(last, match.index)));
    last = match.index + match[0].length;
    const raw = match[0];
    const name = match[1]!.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) {
      out.push(escapeFragment(raw));
      continue;
    }
    if (raw.startsWith('</')) {
      out.push(`</${name}>`);
      continue;
    }
    out.push(`<${name}${parseAttributes(match[2] ?? '')}>`);
  }
  out.push(escapeFragment(work.slice(last)));
  return out.join('');
}

/** camelCase / snake_case 的 style 键 → kebab-case（对齐 Fushi `getStyle` 的 ReCase.paramCase）。 */
function styleKeyToCss(key: string): string {
  return key.replace(/_/g, '-').replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

/** 结构化内容的 style → ` style="..."`；值里带 url()/expression()/javascript: 的直接丢。 */
function renderStyleAttribute(style: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, rawValue] of Object.entries(style)) {
    if (typeof rawValue !== 'string') continue;
    const cssKey = styleKeyToCss(key);
    if (!/^[a-zA-Z-]+$/.test(cssKey)) continue;
    const clean = rawValue.replace(/[\u0000-\u001f\u007f]/g, '');
    if (/url\s*\(|expression\s*\(|javascript:/i.test(clean)) continue;
    parts.push(`${cssKey}: ${clean}`);
  }
  if (parts.length === 0) return '';
  return ` style="${escapeAttribute(parts.join('; '))}"`;
}

/**
 * 把 `GlossaryContent` 渲染成安全 HTML：
 * - 字符串 → 走 `sanitizeGlossaryHtml`（保留词典自带的富文本）；
 * - 数组 → 依次渲染并连接；
 * - `{tag, style, content}` → `<tag style="...">inner</tag>`；tag 不在白名单里就只渲染子内容。
 */
export function renderGlossaryHtml(content: GlossaryContent): string {
  if (typeof content === 'string') return sanitizeGlossaryHtml(content);
  if (Array.isArray(content)) return content.map((item) => renderGlossaryHtml(item)).join('');

  const node = content as unknown as Record<string, unknown>;
  if (typeof node['text'] === 'string' && node['content'] === undefined) return sanitizeGlossaryHtml(node['text']);
  if (typeof node['path'] === 'string' && node['content'] === undefined) return '';

  const inner = renderGlossaryHtml(toGlossaryContent(node['content']));
  const tag = typeof node['tag'] === 'string' ? node['tag'].toLowerCase() : '';
  if (tag.length === 0 || !ALLOWED_TAGS.has(tag)) return inner;
  const style = isRecord(node['style']) ? renderStyleAttribute(node['style']) : '';
  return `<${tag}${style}>${inner}</${tag}>`;
}
