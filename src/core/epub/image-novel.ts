/**
 * 「图片型小说」的判据：整本书的每一章都是插图/扫描页、没有可读文本。
 *
 * ## 为什么需要它
 *
 * 扫描版轻小说、漫画化的图文书、以及 kobo 那种固定版式日文 EPUB，本质上是
 * **一叠页图套了 EPUB 的壳**。用小说阅读器打开它们是一片空白——DOM 里没有文字，
 * 点不出词典，翻页也没有意义。但它们**又确实是小说**：书库里该归到小说、
 * 筛选器里该出现在 EPUB 里。
 *
 * 所以这类书不是「换成漫画」，而是**加一个阅读方式**：
 * `format: 'epub'`（显示为小说）+ `readerMode: 'comic'`（以漫画方式翻页）。
 * 判据在本文件，字段在 `shared/types.ts` 的 `ReaderMode`。
 *
 * ## 判据的两条来源（对齐 Fushi `epub_book.dart:182`）
 *
 * 「有图」不能只数 `<img>`。Fushi 的 TODO-1174 记录了两类被漏掉的真实插图页：
 *
 * 1. **日文固定版式电子书把 JPEG 包在 SVG `<image xlink:href>` 里** —— 根本没有
 *    `<img>` 标签；
 * 2. 带图注 / 页码 / 「挿絵」署名的插图页 —— 文本不是 0，但也远谈不上一段正文。
 *
 * 所以「有图」数三类来源（`<img>`、SVG `<image>`、CSS `background-image`），
 * 文本阈值给到 20 字而不是 0。
 *
 * ## 阈值为什么是 20，而不是「文本为空」
 *
 * 它是**护栏**：任何真正的正文段落都会远超 20 字，所以正文永远不会被误判成插图页。
 * 反过来放宽到 20 才能覆盖上面第 2 类。见 [IMAGE_CHAPTER_MAX_TEXT_CHARS]。
 */

import * as path from 'node:path';

import type { SpineItem } from '../../shared/types';

/**
 * 一章里还允许有多少「可读文本」却仍算插图页。
 *
 * 对齐 Fushi `epub_book.dart:157` 的 `_imageChapterMaxTextChars = 20`。
 * 刻意小：正文必然远超，所以这个阈值只用来容纳图注/页码/署名。
 */
export const IMAGE_CHAPTER_MAX_TEXT_CHARS = 20;

/** 一个章节的扫描结果。 */
export interface ChapterScan {
  /** spine 下标。 */
  index: number;
  /** 章节在书目录内的相对路径。 */
  href: string;
  /** 该章引用的图片（书目录相对路径，按 DOM 出现顺序，已去重）。 */
  images: string[];
  /** 可读文本长度（空白折叠后）。 */
  textLength: number;
}

/** 整本书的判定结果。 */
export interface ImageNovelVerdict {
  /** 是不是图片型小说。 */
  isImageNovel: boolean;
  /** 参与判定的章节（linear 且非 nav）。 */
  chapters: ChapterScan[];
  /** 命中时页图的先后顺序（书目录相对路径）。 */
  pages: string[];
  /** 没命中时的一句话原因（给人看，也写进导入日志）。 */
  reason: string;
}

// ---------------------------------------------------------------------------
// 图片引用抽取
// ---------------------------------------------------------------------------

/** `<img ... src="...">`。 */
const IMG_SRC_RE = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;
/** SVG `<image ... xlink:href="...">` / `<image ... href="...">`。 */
const SVG_IMAGE_RE = /<image\b[^>]*?\b(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
/** CSS `background-image: url(...)`（内联 style 或 <style> 块）。 */
const CSS_URL_RE = /background(?:-image)?\s*:[^;}"']*?url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;

function firstGroup(match: RegExpExecArray): string {
  return (match[1] ?? match[2] ?? match[3] ?? '').trim();
}

/** 收集一段 XHTML 里三类来源的图片引用（原始字符串，未解析）。 */
export function extractImageRefs(xhtml: string): string[] {
  const refs: string[] = [];
  for (const re of [IMG_SRC_RE, SVG_IMAGE_RE, CSS_URL_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(xhtml)) !== null) {
      const value = firstGroup(match);
      if (value !== '') refs.push(value);
    }
  }
  return refs;
}

/**
 * 把章节里的一个引用解析成**书目录相对路径**。
 *
 * 与 `epub/parser.ts` 的 href 解析同口径：只 percent-解码一次，去掉 `#fragment`
 * 与 `?query`，相对章节所在目录解析，再把结果归一化成书目录相对的路径。
 *
 * 非法引用（`data:`、外链、穿越出书目录）一律返回 `null` —— 调用方跳过，
 * 不让一个坏引用把整本书的判定带偏。
 */
export function resolveResourceHref(chapterHref: string, ref: string): string | null {
  let value = ref.trim();
  if (value === '') return null;
  // `data:` / `http(s):` / `mailto:` 之类不算书内资源。
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) && !value.startsWith('file:')) return null;

  // 去掉 query 与 fragment。
  const hash = value.indexOf('#');
  if (hash >= 0) value = value.slice(0, hash);
  const query = value.indexOf('?');
  if (query >= 0) value = value.slice(0, query);
  if (value === '') return null;

  try {
    value = decodeURIComponent(value);
  } catch {
    // 裸 `%` 之类：保持原样，别因此丢掉一个资源。
  }

  const baseDir = path.posix.dirname(chapterHref);
  // 以 `/` 开头的是书目录绝对路径。
  const joined = value.startsWith('/') ? value : path.posix.join(baseDir, value);
  const normalized = path.posix.normalize(joined).replace(/^\/+/, '');
  // `..` 逃出书目录 → 不是书内资源。
  if (normalized === '' || normalized.startsWith('..')) return null;
  return normalized;
}

/** 一页插图算不算「页图」：扩展名在漫画页图白名单里。 */
const PAGE_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];

export function isPageImage(href: string): boolean {
  const ext = path.posix.extname(href).toLowerCase();
  return PAGE_IMAGE_EXTENSIONS.includes(ext);
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

/**
 * 扫描一个章节：抽出图片引用 + 统计可读文本长度。
 *
 * [plainTextOf] 由调用方注入（生产用 `parser.ts` 的 `extractText`），
 * 这样本模块保持纯函数、可单测，也不必在 core 里重复一套剥标签逻辑。
 */
export function scanChapter(
  index: number,
  href: string,
  xhtml: string,
  plainTextOf: (xhtml: string) => string,
): ChapterScan {
  const images: string[] = [];
  const seen = new Set<string>();
  for (const raw of extractImageRefs(xhtml)) {
    const resolved = resolveResourceHref(href, raw);
    if (resolved === null || seen.has(resolved)) continue;
    seen.add(resolved);
    images.push(resolved);
  }
  const text = plainTextOf(xhtml).replace(/\s+/g, ' ').trim();
  return { index, href, images, textLength: text.length };
}

/**
 * 判定整本书是不是「图片型小说」。
 *
 * 条件（三条全满足）：
 * 1. 至少有一章参与判定；
 * 2. **每一章**都「有图 且 可读文本 ≤ [IMAGE_CHAPTER_MAX_TEXT_CHARS]」；
 * 3. 每张图都是页图扩展名（`kMangaImageExtensions` 同一张表）。
 *
 * 第 3 条是必要的：EPUB 里塞一张装饰性 SVG / GIF 图标很常见，那种书不该被当成
 * 图片小说丢进漫画阅读器。
 */
export function judgeImageNovel(
  chapters: readonly ChapterScan[],
  options: { maxTextChars?: number } = {},
): ImageNovelVerdict {
  const maxTextChars = options.maxTextChars ?? IMAGE_CHAPTER_MAX_TEXT_CHARS;

  if (chapters.length === 0) {
    return { isImageNovel: false, chapters: [...chapters], pages: [], reason: '没有可判定的章节' };
  }

  for (const chapter of chapters) {
    if (chapter.images.length === 0) {
      return {
        isImageNovel: false,
        chapters: [...chapters],
        pages: [],
        reason: `第 ${chapter.index + 1} 章没有图片`,
      };
    }
    if (chapter.textLength > maxTextChars) {
      return {
        isImageNovel: false,
        chapters: [...chapters],
        pages: [],
        reason: `第 ${chapter.index + 1} 章有 ${chapter.textLength} 字正文（阈值 ${maxTextChars}）`,
      };
    }
    for (const image of chapter.images) {
      if (!isPageImage(image)) {
        return {
          isImageNovel: false,
          chapters: [...chapters],
          pages: [],
          reason: `第 ${chapter.index + 1} 章引用了非页图资源：${image}`,
        };
      }
    }
  }

  // 页序 = spine 顺序 × 章内 DOM 顺序。这与「漫画页序」的语义一致：
  // 用户的翻页顺序就是书的阅读顺序，不做自然序重排（那是漫画文件夹导入才需要的）。
  const pages: string[] = [];
  const seen = new Set<string>();
  for (const chapter of chapters) {
    for (const image of chapter.images) {
      if (seen.has(image)) continue;
      seen.add(image);
      pages.push(image);
    }
  }

  if (pages.length === 0) {
    return { isImageNovel: false, chapters: [...chapters], pages: [], reason: '没有页图' };
  }
  return { isImageNovel: true, chapters: [...chapters], pages, reason: '' };
}

/** 挑出参与判定的 spine 项：linear 且非 nav。 */
export function contentSpineItems(spine: readonly SpineItem[]): SpineItem[] {
  return spine.filter((item) => item.linear && !item.href.toLowerCase().endsWith('nav.xhtml'));
}
