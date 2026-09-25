/**
 * 阅读器内容服务：把书磁盘上的文件转成渲染进程要的东西。
 *
 * EPUB 章节走 `arale://` URL（协议处理器注入样式与桥接脚本）——这里只负责算出 URL
 * 和纯文本快照。
 *
 * 漫画文字层走 `content/manga.json`（导入时写好的 mokuro 兼容格式）。**按书缓存**
 * 并带 mtime 失效：一本 200 页的卷 manga.json 可能是几 MB，每次翻页都重读会把翻页
 * 拖到几百毫秒（Fushi 在 analysis 01 §6 里记过同类问题）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { BookRecord, ChapterContent, PageText } from '../../shared/types';
import { extractText } from '../../core/epub/parser';
import { parseMangaJson } from '../../core/comic/mokuro';
import { bookContentDir } from '../paths';
import { bookUrl } from './protocol';

export class ContentError extends Error {}

export function getChapterContent(book: BookRecord, spineIndex: number): ChapterContent {
  if (book.format !== 'epub') throw new ContentError('这不是一本 EPUB。');
  const spine = book.spine;
  if (!spine || spine.length === 0) throw new ContentError('这本书没有可读章节。');
  const index = clampIndex(spineIndex, spine.length);
  const item = spine[index];
  if (!item) throw new ContentError(`章节序号越界：${spineIndex}`);

  const filePath = path.join(bookContentDir(book.id), ...item.href.split('/'));
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    // 单章缺文件不该让整本书打不开：给一个可诊断的空章节。
    raw = `<p>（找不到章节文件：${item.href}）</p>`;
  }

  return {
    spineIndex: index,
    url: bookUrl(book.id, item.href),
    plainText: extractText(raw),
  };
}

interface CachedPageText {
  mtimeMs: number;
  pages: PageText[];
}

const pageTextCache = new Map<string, CachedPageText>();

export function getPageText(book: BookRecord, pageIndex: number): PageText {
  // **不要**在这里判 `book.format === 'comic'`：图片型小说是 `format: 'epub'` +
  // `readerMode: 'comic'`，它同样有 pages、同样需要文字层。判据是「有没有页图」。
  const pages = book.pages ?? [];
  if (pages.length === 0) throw new ContentError('这本书没有页图，读不了文字层。');
  const index = clampIndex(pageIndex, pages.length);
  const page = pages[index];
  if (!page) throw new ContentError(`页序号越界：${pageIndex}`);

  // 缓存上限：桌面端同时打开的书很少，8 本足够，超出后整体清空（比 LRU 简单且够用）。
  // 必须在 loadPageTexts **之前**判断——loadPageTexts 会把当前这本写进缓存，
  // 写完之后再 clear 就把刚读到的东西也清掉了（曾经就是这么写的）。
  if (pageTextCache.size > 8 && !pageTextCache.has(book.id)) pageTextCache.clear();

  const cached = loadPageTexts(book);
  const found = cached.find((p) => p.url === page.url);
  return found ?? { url: page.url, blocks: [] };
}

function loadPageTexts(book: BookRecord): PageText[] {
  const jsonPath = path.join(bookContentDir(book.id), 'manga.json');
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(jsonPath).mtimeMs;
  } catch {
    pageTextCache.set(book.id, { mtimeMs: 0, pages: [] });
    return [];
  }
  const cached = pageTextCache.get(book.id);
  if (cached && cached.mtimeMs === mtimeMs) return cached.pages;

  let pages: PageText[] = [];
  try {
    pages = parseMangaJson(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    pages = [];
  }
  pageTextCache.set(book.id, { mtimeMs, pages });
  return pages;
}

/** 书被删/重导入后要清缓存，否则会拿到上一本的文字层。 */
export function invalidateContentCache(bookId: string): void {
  pageTextCache.delete(bookId);
}

function clampIndex(value: number, length: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value >= length) return Math.max(0, length - 1);
  return Math.floor(value);
}
