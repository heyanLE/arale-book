/**
 * EPUB 结构解析 —— OPF / spine / metadata / 封面 / 目录。
 *
 * 对应 Fushi `packages/fushi_engine/lib/epub/epub_parser.dart`，但有两个**有意**的
 * 差异，都在下面的注释里标了「与 Fushi 不同」：
 *   1. spine 里非 XHTML 的 item 直接丢弃（Fushi 保留占位，TODO-807 是为了不移动
 *      已入库的章节索引；我们还没有存量索引，丢弃更简单且下游不可能拿到渲染不了
 *      的条目）。
 *   2. TOC 的 href 一律剥掉 `#fragment`（阅读器直接按 href 定位章首）。
 *
 * `ParsedEpub.spine[].href` / `.toc[].href` / `.coverRel` / `.opfRel` 全部是
 * **相对 ZIP 根**的正斜杠路径，不是相对 OPF 目录。这个口径是 `readSpineXhtml`
 * 能在不知道 OPF 目录的情况下直接查成员的前提，也是解压落盘后阅读器按书目录
 * 取文件的口径（`BookRecord.opfRel` / `SpineItem.href` 的注释与此冲突时以本文件
 * 为准，见交付说明）。
 */
import { XMLParser } from 'fast-xml-parser';
import type { SpineItem, TocEntry } from '../../shared/types';
import { naturalCompare } from '../util/natural-sort';
import { findEntry, type ZipEntry } from './zip-reader';

export interface ParsedEpub {
  title: string | null;
  author: string;
  language: string | null;
  publisher: string | null;
  description: string | null;
  /** 相对 ZIP 根（书目录），正斜杠；没有封面为 null。 */
  coverRel: string | null;
  /** OPF 相对 ZIP 根。 */
  opfRel: string;
  /** spine，href 已解析为相对 ZIP 根。 */
  spine: SpineItem[];
  /** 目录，href 已解析为相对 ZIP 根且剥掉 fragment。 */
  toc: TocEntry[];
  direction: 'ltr' | 'rtl';
}

/** EPUB 结构不可解析（缺 OPF / XML 坏到无法取根节点）时抛这个。 */
export class EpubParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpubParseError';
  }
}

const CONTAINER_PATH = 'META-INF/container.xml';

/**
 * `removeNSPrefix: true` 是本文件最关键的开关：Calibre 4.x 写的是
 * `<opf:package><opf:manifest><opf:item/>`，按 qualified name 匹配会得到空
 * manifest、每个 itemref 都被跳过，整本书报「EPUB spine contains no readable
 * chapters」（Fushi analysis 02 §2.3、epub_parser.dart:399-409）。剥掉前缀后
 * `<opf:item>` 与 `<item>` 同键。
 *
 * `parseTagValue: false` / `parseAttributeValue: false`：全部保持字符串。默认的
 * 数值化会把 `<dc:title>1984</dc:title>` 变成 number、把 `0001` 变成 `1`，标题
 * 会在解析阶段就被悄悄改写（我们的口径是「标题原样返回，消毒是调用方的事」）。
 */
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string;
}

// ---------------------------------------------------------------------------
// XML 小工具
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 单元素 vs 数组统一化。fast-xml-parser 对**只有一个** `<item>` 的 manifest
 * 返回对象而不是一元数组；不统一就会出现「单章 EPUB 解析不出 spine」这类只在
 * 极端输入下复现的 bug（Fushi analysis 02 §2.4 记录过同型问题）。
 */
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

/** 取元素文本：文本节点可能是裸串，也可能因为带属性而被包成 `{#text: ...}`。 */
function textOf(node: unknown): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (isRecord(node)) {
    const inner = node['#text'];
    if (Array.isArray(inner)) return inner.length > 0 ? textOf(inner[0]) : '';
    return textOf(inner);
  }
  return '';
}

function attrOf(node: unknown, name: string): string | null {
  if (!isRecord(node)) return null;
  const value = node[`@_${name}`];
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : String(value);
}

function tryParseXml(xml: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = xmlParser.parse(xml);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

/** percent-解码一次；非法转义（裸 `%`）原样返回而不是抛错（HBK-AUDIT-010 的容错口径）。 */
function decodePercent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 取父目录（正斜杠相对路径），根目录返回 `''`。 */
function dirOf(rel: string): string {
  const index = rel.lastIndexOf('/');
  return index < 0 ? '' : rel.slice(0, index);
}

/**
 * 把 `baseDir` 下的 href 解析成相对 **ZIP 根** 的正斜杠路径。
 *
 * 这是全文件最重要的一条规则（analysis 02 §2.4）：manifest / spine / nav / cover
 * 的 href 都是**相对 OPF 所在目录**的，不是相对压缩包根。OPF 在 `OEBPS/` 时
 * `href="text/ch1.xhtml"` 指的是 `OEBPS/text/ch1.xhtml`。直接拿 href 当根相对
 * 路径会在「OPF 不在根目录」的所有书上失配——而 Calibre / Sigil 导出的书几乎
 * 都不在根目录。
 *
 * 内部顺序：去 fragment/query → percent-解码 → 逐段折叠 `.` / `..`。`..` 逃出
 * ZIP 根时返回 null（zip-slip 防线）；纯 `#fragment` 的 href 返回 null，因为它
 * 指向不了任何文档。
 */
function resolveZipRel(baseDir: string, href: string): string | null {
  const cleaned = href.trim().replace(/\\/g, '/');
  const noFragment = cleaned.split('#')[0] ?? '';
  const pathPart = noFragment.split('?')[0] ?? '';
  if (pathPart === '') return null;

  const segments = baseDir.split('/').filter((segment) => segment !== '' && segment !== '.');
  for (const segment of decodePercent(pathPart).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/**
 * 优先返回**压缩包里真实成员**的拼写，找不到才用解析出来的路径。
 *
 * 保留真实大小写是 BUG-1218 的教训：把路径规范化成小写后，大小写敏感平台
 * （Linux / Android）上 `existsSync` 全 false，spine 被逐条静默跳过，用户看到
 * 的书只剩「路径恰好全小写」的一两章。我们这里更进一步：既然包就在内存里，
 * 直接回真实成员名，连大小写回落都省给 `findEntry` 处理。
 */
function canonicalEntryName(entries: ZipEntry[], rel: string): string {
  const entry = findEntry(entries, rel);
  return entry ? entry.name : rel;
}

function hasProperty(properties: string, word: string): boolean {
  if (properties === '') return false;
  return properties.split(/\s+/).some((token) => token === word);
}

/** XHTML-ish 才可能渲染；`; charset=` 参数要剥掉再比（BUG-1203 的判据同口径）。 */
function isXhtmlMediaType(mediaType: string): boolean {
  const base = (mediaType.split(';')[0] ?? '').trim().toLowerCase();
  return base === 'application/xhtml+xml' || base === 'text/html';
}

function firstText(container: Record<string, unknown>, key: string): string | null {
  for (const node of asArray(container[key])) {
    const text = textOf(node).trim();
    if (text !== '') return text;
  }
  return null;
}

function allTexts(container: Record<string, unknown>, key: string): string[] {
  const out: string[] = [];
  for (const node of asArray(container[key])) {
    const text = textOf(node).trim();
    if (text !== '') out.push(text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// container.xml → OPF
// ---------------------------------------------------------------------------

function findRootfileFullPath(node: unknown): string | null {
  if (!isRecord(node)) return null;
  for (const rootfile of asArray(node['rootfile'])) {
    const fullPath = attrOf(rootfile, 'full-path');
    if (fullPath !== null && fullPath.trim() !== '') return fullPath.trim();
  }
  for (const value of Object.values(node)) {
    const found = findRootfileFullPath(value);
    if (found !== null) return found;
  }
  return null;
}

/**
 * 定位 OPF：`META-INF/container.xml` 的 `rootfile/@full-path` 优先；缺 container、
 * rootfile 为空、或 full-path 指向的成员不存在时，回落成「扫描第一个 `*.opf`」；
 * 两者都没有才抛（analysis 02 §2.5 的失败表）。
 */
function findOpfRel(entries: ZipEntry[]): string {
  const container = findEntry(entries, CONTAINER_PATH);
  if (container) {
    const tree = tryParseXml(container.text());
    const fullPath = tree === null ? null : findRootfileFullPath(tree);
    if (fullPath !== null) {
      // container.xml 里的 full-path 是 URL 编码的（HBK-AUDIT-010），成员名在
      // zip 边界已解码一次，所以这里也必须解码一次，两边才对得上。
      const rel = decodePercent(fullPath.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, ''));
      if (rel !== '' && findEntry(entries, rel) !== null) return rel;
    }
  }
  const opfs = entries
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().endsWith('.opf'))
    .sort(naturalCompare);
  const first = opfs[0];
  if (first !== undefined) return first;
  throw new EpubParseError('EPUB 无效：既没有 META-INF/container.xml，也找不到任何 .opf');
}

// ---------------------------------------------------------------------------
// 元数据
// ---------------------------------------------------------------------------

/**
 * `dc:title` 可能重复（EPUB3 用 `refines` + `title-type` 标注主标题）。优先取被
 * `<meta property="title-type">main</meta>` 指向的那条，其次取没有 `refines` 的
 * 第一条，最后取第一条。标题原样返回，不做任何消毒。
 */
function pickTitle(metadata: Record<string, unknown>, metaNodes: unknown[]): string | null {
  const candidates: { text: string; id: string | null; refines: string | null }[] = [];
  for (const node of asArray(metadata['title'])) {
    const text = textOf(node).trim();
    if (text !== '') candidates.push({ text, id: attrOf(node, 'id'), refines: attrOf(node, 'refines') });
  }
  if (candidates.length === 0) return null;

  const mainIds = new Set<string>();
  for (const meta of metaNodes) {
    if (!isRecord(meta)) continue;
    if (!(attrOf(meta, 'property') ?? '').toLowerCase().includes('title-type')) continue;
    if (textOf(meta).trim().toLowerCase() !== 'main') continue;
    const refines = attrOf(meta, 'refines');
    if (refines !== null && refines.startsWith('#')) mainIds.add(refines.slice(1));
  }
  const main = candidates.find((candidate) => candidate.id !== null && mainIds.has(candidate.id));
  if (main !== undefined) return main.text;
  const unrefined = candidates.find((candidate) => candidate.refines === null);
  return (unrefined ?? candidates[0])?.text ?? null;
}

/** 剥掉 HTML 标签（description 常见 `<p>` / `<b>`）。先剥标签再解实体，理由见 extractText。 */
function stripMarkup(html: string): string {
  const noBlocks = html.replace(/<(?:script|style)\b[\s\S]*?<\/(?:script|style)\s*>/gi, ' ');
  return decodeEntities(noBlocks.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function commonDirPrefixScore(a: string, b: string): number {
  const sa = a === '' ? [] : a.split('/');
  const sb = b === '' ? [] : b.split('/');
  let count = 0;
  while (count < sa.length && count < sb.length && sa[count] === sb[count]) count += 1;
  return count;
}

/**
 * 封面三级回落（analysis 02 §2.4，Fushi `_parseCoverHref`）：
 *   1. manifest `properties` 含 `cover-image`（EPUB3）；
 *   2. `<meta name="cover" content="ID"/>` → manifest id（EPUB2）；
 *   3. 成员名匹配 `cover.<ext>`，优先与 spine 首页同目录的（tier 3 是我们在
 *      内存成员表上的实现；Fushi 的 tier 3 是「第一个 image/* manifest item」，
 *      在「manifest 里有几十张插图」的书上会选错，用文件名启发式更稳）。
 */
function resolveCoverRel(
  entries: ZipEntry[],
  opfDir: string,
  manifest: Map<string, ManifestItem>,
  metaNodes: unknown[],
  spine: SpineItem[],
): string | null {
  for (const item of manifest.values()) {
    if (!hasProperty(item.properties, 'cover-image')) continue;
    const rel = resolveZipRel(opfDir, item.href);
    if (rel !== null && rel !== '') return canonicalEntryName(entries, rel);
  }
  for (const meta of metaNodes) {
    if (!isRecord(meta)) continue;
    if ((attrOf(meta, 'name') ?? '').toLowerCase() !== 'cover') continue;
    const coverId = attrOf(meta, 'content');
    const item = coverId === null ? undefined : manifest.get(coverId);
    if (item === undefined) continue;
    const rel = resolveZipRel(opfDir, item.href);
    if (rel !== null && rel !== '') return canonicalEntryName(entries, rel);
  }
  const firstSpineDir = dirOf(spine[0]?.href ?? '');
  const best = entries
    .filter((entry) => /cover\.(?:jpe?g|png|gif|webp)$/i.test(entry.name))
    .map((entry) => ({ name: entry.name, score: commonDirPrefixScore(firstSpineDir, dirOf(entry.name)) }))
    .sort((a, b) => b.score - a.score || naturalCompare(a.name, b.name))[0];
  return best === undefined ? null : best.name;
}

// ---------------------------------------------------------------------------
// 目录
// ---------------------------------------------------------------------------

/**
 * EPUB3 `nav`（manifest `properties` 含 `nav`）优先，其次 EPUB2 NCX
 * （`<spine toc="..">` → manifest → `navMap/navPoint`）。两处都没有返回 `[]`——
 * 没有目录不是解析失败，不该让整本书打不开。
 */
function parseToc(
  entries: ZipEntry[],
  opfDir: string,
  manifest: Map<string, ManifestItem>,
  spineNode: Record<string, unknown>,
): TocEntry[] {
  for (const item of manifest.values()) {
    if (!hasProperty(item.properties, 'nav')) continue;
    const navRel = resolveZipRel(opfDir, item.href);
    if (navRel === null || navRel === '') continue;
    const entry = findEntry(entries, navRel);
    if (entry === null) continue;
    const items = parseNavDoc(entry.text(), dirOf(entry.name));
    if (items.length > 0) return items;
  }
  const tocId = attrOf(spineNode, 'toc');
  const ncxItem = tocId === null ? undefined : manifest.get(tocId);
  if (ncxItem !== undefined) {
    const ncxRel = resolveZipRel(opfDir, ncxItem.href);
    if (ncxRel !== null && ncxRel !== '') {
      const entry = findEntry(entries, ncxRel);
      if (entry !== null) return parseNcx(entry.text(), dirOf(entry.name));
    }
  }
  return [];
}

/** 找到 `<nav epub:type="toc">` 的正文；没有就返回整篇（容错无 epub:type 的 nav）。 */
function findTocNav(html: string): string {
  const navRe = /<nav\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = navRe.exec(html)) !== null) {
    const attrs = match[1] ?? '';
    const typeMatch = /(?:epub:)?type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const value = (typeMatch?.[1] ?? typeMatch?.[2] ?? typeMatch?.[3] ?? '').toLowerCase();
    if (!value.split(/\s+/).includes('toc')) continue;
    const start = match.index + match[0].length;
    const depthRe = /<nav\b|<\/nav\s*>/gi;
    depthRe.lastIndex = start;
    let depth = 1;
    let inner: RegExpExecArray | null;
    while ((inner = depthRe.exec(html)) !== null) {
      if (inner[0].toLowerCase().startsWith('</')) {
        depth -= 1;
        if (depth === 0) return html.slice(start, inner.index);
      } else {
        depth += 1;
      }
    }
    return html.slice(start);
  }
  return html;
}

/**
 * DOM-free 的 nav 遍历：`<ol>` 嵌套给深度，`<a href>` 给条目，`<span>` 给无链接的
 * 分组标签。不用真 DOM 是硬要求——同一条 XHTML 在不同解析器上的容错行为不同，
 * 而这里产出的深度/顺序会进入 UI，必须完全确定。
 */
function scanNavTokens(html: string, baseDir: string): TocEntry[] {
  const raw: { label: string; href: string | null; depth: number }[] = [];
  let depth = 0;
  const tokenRe = /<ol\b[^>]*>|<\/ol\s*>|<a\b([^>]*)>([\s\S]*?)<\/a\s*>|<span\b[^>]*>([\s\S]*?)<\/span\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(html)) !== null) {
    const token = match[0].toLowerCase();
    if (token.startsWith('<ol')) {
      depth += 1;
      continue;
    }
    if (token.startsWith('</ol')) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const isAnchor = token.startsWith('<a');
    const attrs = (isAnchor ? match[1] : '') ?? '';
    const inner = (isAnchor ? match[2] : match[3]) ?? '';
    let label = navLabel(inner);
    if (label === '' && isAnchor) label = navImageLabel(inner);
    const hrefAttr = isAnchor ? attrValue(attrs, 'href') : null;
    const resolved = hrefAttr === null ? null : resolveZipRel(baseDir, hrefAttr);
    raw.push({ label, href: resolved === null || resolved === '' ? null : resolved, depth: Math.max(0, depth - 1) });
  }
  const out: TocEntry[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (entry === undefined || entry.label === '') continue;
    let href = entry.href;
    if (href === null) {
      // 无链接的分组节点借「紧随其后、更深一层」的第一个条目的 href，这样分组
      // 标签不会凭空消失；借不到就丢掉自己（子节点早已各自成条）。
      for (let j = i + 1; j < raw.length; j += 1) {
        const candidate = raw[j];
        if (candidate === undefined || candidate.depth <= entry.depth) break;
        if (candidate.href !== null) {
          href = candidate.href;
          break;
        }
      }
    }
    if (href !== null) out.push({ label: entry.label, href, depth: entry.depth });
  }
  return out;
}

function parseNavDoc(html: string, baseDir: string): TocEntry[] {
  const cleaned = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '');
  const tocNav = findTocNav(cleaned);
  const items = scanNavTokens(tocNav, baseDir);
  // 有 toc 型 nav 但一条都没解析出来时，退回扫全篇：真实 nav.xhtml 里有目录写在
  // 普通 `<ol>`（漏了 epub:type）的写法，不该因此得到空目录。
  if (items.length === 0 && tocNav !== cleaned) return scanNavTokens(cleaned, baseDir);
  return items;
}

interface NcxFrame {
  label: string | null;
  href: string | null;
  depth: number;
  children: TocEntry[];
}

/** EPUB2 NCX：`navMap/navPoint` 嵌套即深度。无名或无 href 的节点只丢自己，子节点上提。 */
function parseNcx(ncx: string, baseDir: string): TocEntry[] {
  const navMapMatch = /<navMap\b[^>]*>/i.exec(ncx);
  const body = navMapMatch === null ? ncx : ncx.slice(navMapMatch.index + navMapMatch[0].length);
  const root: TocEntry[] = [];
  const stack: NcxFrame[] = [];
  const tokenRe = /<navPoint\b[^>]*>|<\/navPoint\s*>|<text\b[^>]*>([\s\S]*?)<\/text\s*>|<content\b([^>]*?)\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(body)) !== null) {
    const token = match[0].toLowerCase();
    if (token.startsWith('<navpoint')) {
      stack.push({ label: null, href: null, depth: stack.length, children: [] });
      continue;
    }
    if (token.startsWith('</navpoint')) {
      const frame = stack.pop();
      if (frame === undefined) continue;
      const built: TocEntry[] = [];
      let href = frame.href;
      if (href === null) href = frame.children[0]?.href ?? null;
      if (frame.label !== null && frame.label !== '' && href !== null) {
        built.push({ label: frame.label, href, depth: frame.depth });
      }
      built.push(...frame.children);
      const parent = stack[stack.length - 1];
      if (parent === undefined) root.push(...built);
      else parent.children.push(...built);
      continue;
    }
    const frame = stack[stack.length - 1];
    if (frame === undefined) continue;
    if (token.startsWith('<text')) {
      frame.label = navLabel(match[1] ?? '');
      continue;
    }
    const src = attrValue(match[2] ?? '', 'src');
    const resolved = src === null ? null : resolveZipRel(baseDir, src);
    frame.href = resolved === null || resolved === '' ? null : resolved;
  }
  return root;
}

// ---------------------------------------------------------------------------
// 正文
// ---------------------------------------------------------------------------

/** 取一个 spine 条目的原始 XHTML。条目缺失返回 `''`（不抛）。 */
export function readSpineXhtml(entries: ZipEntry[], item: SpineItem): string {
  const entry = findEntry(entries, item.href);
  return entry === null ? '' : entry.text();
}

/**
 * XHTML → 纯文本。返回串的 **UTF-16 偏移**就是阅读器恢复阅读位置用的坐标系。
 *
 * 因此三件事是硬约束：
 *   - 转换必须完全确定（不依赖真 DOM：不同解析器对畸形 XHTML 的容错不同，偏移
 *     会漂移）；
 *   - 块边界插入 `\n`，块内空白压成单空格，绝不把相邻段落粘成一个词；
 *   - **先剥标签再解实体**。反过来的话，正文里的 `&lt;p&gt;`（作者想显示字面量
 *     `<p>`）会先变成标签再被剥掉，凭空少掉 3 个字符。
 */
export function extractText(xhtml: string): string {
  if (xhtml === '') return '';
  let text = xhtml;
  text = text.replace(/<head\b[\s\S]*?<\/head\s*>/gi, '\n');
  text = text.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '\n');
  text = text.replace(/<style\b[\s\S]*?<\/style\s*>/gi, '\n');
  text = text.replace(/<br\b[^>]*\/?>/gi, '\n');
  text = text.replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote|section|article|pre|figcaption)\s*>/gi, '\n');
  text = text.replace(/<[^>]*>/g, '');
  text = decodeEntities(text);
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    const collapsed = line.replace(/\s+/g, ' ').trim();
    if (collapsed !== '') lines.push(collapsed);
  }
  return lines.join('\n');
}

function codePointToString(codePoint: number, fallback: string): string {
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return fallback;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return fallback;
  return String.fromCodePoint(codePoint);
}

/** 解五个 XML 实体 + 数字实体（外加 `&nbsp;`，它是 XHTML 里最常见的空白实体）。 */
function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (whole, hex: string) => codePointToString(parseInt(hex, 16), whole))
    .replace(/&#(\d+);/g, (whole, dec: string) => codePointToString(parseInt(dec, 10), whole))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // `&amp;` 必须最后解，否则 `&amp;lt;` 会被先解成 `&lt;` 再解成 `<`（双重解码）。
    .replace(/&amp;/g, '&');
}

/** 从标签串里取属性值，容忍单/双引号与无引号。 */
function attrValue(attrs: string, name: string): string | null {
  const re = new RegExp(`(?:^|[\\s"'/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const match = re.exec(attrs);
  if (match === null) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/** nav 条目标签：剥内部标签、解实体、压空白。 */
function navLabel(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** 图片目录项（`<a><img/></a>`）没有文本，拿图片 alt/title 当标签。 */
function navImageLabel(inner: string): string {
  const imgRe = /<img\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = imgRe.exec(inner)) !== null) {
    const attrs = match[1] ?? '';
    const alt = attrValue(attrs, 'alt');
    if (alt !== null && alt.trim() !== '') return decodeEntities(alt).trim();
    const title = attrValue(attrs, 'title');
    if (title !== null && title.trim() !== '') return decodeEntities(title).trim();
  }
  return '';
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function parseEpub(entries: ZipEntry[]): ParsedEpub {
  if (entries.length === 0) throw new EpubParseError('EPUB 无效：压缩包内没有任何成员');
  const opfRel = findOpfRel(entries);
  const opfEntry = findEntry(entries, opfRel);
  if (opfEntry === null) throw new EpubParseError(`OPF 不在压缩包内：${opfRel}`);
  const root = tryParseXml(opfEntry.text());
  if (root === null) throw new EpubParseError(`OPF 不是合法 XML：${opfRel}`);

  const pkg = isRecord(root['package']) ? root['package'] : root;
  const opfDir = dirOf(opfRel);
  const metadata: Record<string, unknown> = isRecord(pkg['metadata']) ? pkg['metadata'] : {};
  const metaNodes = asArray(metadata['meta']);

  const manifest = new Map<string, ManifestItem>();
  const manifestNode = pkg['manifest'];
  const rawItems = isRecord(manifestNode) ? manifestNode['item'] : undefined;
  for (const raw of asArray(rawItems)) {
    if (!isRecord(raw)) continue;
    const id = attrOf(raw, 'id');
    const href = attrOf(raw, 'href');
    const mediaType = attrOf(raw, 'media-type');
    if (id === null || href === null || mediaType === null || href === '') continue;
    manifest.set(id, { id, href, mediaType, properties: attrOf(raw, 'properties') ?? '' });
  }

  const spineNode: Record<string, unknown> = isRecord(pkg['spine']) ? pkg['spine'] : {};
  const direction: 'ltr' | 'rtl' =
    (attrOf(spineNode, 'page-progression-direction') ?? '').toLowerCase() === 'rtl' ? 'rtl' : 'ltr';

  const spine: SpineItem[] = [];
  for (const raw of asArray(spineNode['itemref'])) {
    if (!isRecord(raw)) continue;
    const idref = attrOf(raw, 'idref');
    if (idref === null) continue;
    const item = manifest.get(idref);
    if (item === undefined) continue;
    // 与 Fushi 不同：非 XHTML 条目（PDF/图片/音频）直接不进 spine。Fushi 保留是
    // 为了不移动已入库的章节索引（TODO-807），我们没有存量索引，而阅读器根本
    // 渲染不了它们，留在数组里只会让章节数对不上 UI 的页数。
    if (!isXhtmlMediaType(item.mediaType)) continue;
    const resolved = resolveZipRel(opfDir, item.href);
    if (resolved === null || resolved === '') continue;
    spine.push({
      id: item.id,
      href: canonicalEntryName(entries, resolved),
      mediaType: item.mediaType,
      linear: (attrOf(raw, 'linear') ?? 'yes').toLowerCase() !== 'no',
    });
  }

  const descriptionRaw = firstText(metadata, 'description');
  return {
    title: pickTitle(metadata, metaNodes),
    author: allTexts(metadata, 'creator').join(', '),
    language: firstText(metadata, 'language'),
    publisher: firstText(metadata, 'publisher'),
    description: descriptionRaw === null ? null : stripMarkup(descriptionRaw),
    coverRel: resolveCoverRel(entries, opfDir, manifest, metaNodes, spine),
    opfRel,
    spine,
    toc: parseToc(entries, opfDir, manifest, spineNode),
    direction,
  };
}
