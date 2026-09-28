/**
 * 书库页图路径的 ASCII 化与存量迁移。
 *
 * Windows 版 OpenCV 的 `imread()` 不能可靠读取含 CJK 字符的路径。书架标题仍保留
 * 原文；这里只转换 `content/` 下实际页图的相对路径：日文（路径或书名含假名）转
 * Hepburn 罗马音，中文转无声调拼音。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { pinyin } from 'pinyin-pro';

import type { ComicPage } from '../../shared/types';
import { writeJsonAtomic } from '../../core/util/atomic-json';
import { normalizeRel } from '../../core/util/paths';
import { bookContentDir } from '../paths';
import type { LibraryStore } from './store';

type KuroshiroInstance = {
  init(analyzer: unknown): Promise<void>;
  convert(input: string, options: { to: 'romaji'; mode: 'spaced'; romajiSystem: 'hepburn' }): Promise<string>;
};
type KuroshiroConstructor = new () => KuroshiroInstance;
type AnalyzerConstructor = new () => unknown;

const HAS_KANA = /[\u3040-\u30ff\u31f0-\u31ff]/u;
const HAS_HAN = /\p{Script=Han}/u;
const ASCII_ONLY = /^[\x20-\x7e]*$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

let japanesePromise: Promise<KuroshiroInstance> | null = null;

function japaneseConverter(): Promise<KuroshiroInstance> {
  if (japanesePromise === null) {
    japanesePromise = (async () => {
      // 两个包没有 TypeScript 声明，边界在这里收窄成实际使用的最小接口。
      const Kuroshiro = (require('kuroshiro') as { default: KuroshiroConstructor }).default;
      const Analyzer = require('kuroshiro-analyzer-kuromoji') as AnalyzerConstructor;
      const converter = new Kuroshiro();
      await converter.init(new Analyzer());
      return converter;
    })();
  }
  return japanesePromise;
}

export type CjkPathLanguage = 'ja' | 'zh';

/** 含假名即判日文；纯汉字按中文处理，避免把中文读成日语音读。 */
export function detectCjkPathLanguage(context: string): CjkPathLanguage {
  return HAS_KANA.test(context) ? 'ja' : 'zh';
}

/** 把一个外来相对路径转换成只含 ASCII 的、安全且可读的相对路径。 */
export async function asciiRelativePath(
  rel: string,
  language: CjkPathLanguage = detectCjkPathLanguage(rel),
): Promise<string> {
  const parts = normalizeRel(rel).split('/').filter(Boolean);
  const converted: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const original = parts[index]!;
    const ext = index === parts.length - 1 ? path.posix.extname(original) : '';
    const stem = ext === '' ? original : original.slice(0, -ext.length);
    const asciiStem = await transliterateSegment(stem, language);
    const asciiExt = ext === '' ? '' : `.${safeAscii(ext.slice(1).toLowerCase(), 'bin')}`;
    converted.push(`${asciiStem}${asciiExt}`);
  }
  return converted.join('/');
}

async function transliterateSegment(input: string, language: CjkPathLanguage): Promise<string> {
  if (ASCII_ONLY.test(input)) return safeAscii(input, 'item');
  let converted = input;
  if (language === 'ja') {
    const kuroshiro = await japaneseConverter();
    converted = await kuroshiro.convert(input, {
      to: 'romaji', mode: 'spaced', romajiSystem: 'hepburn',
    });
  } else if (HAS_HAN.test(input)) {
    converted = pinyin(input, { toneType: 'none', type: 'array', nonZh: 'consecutive' }).join(' ');
  }
  return safeAscii(converted, codepointFallback(input));
}

function safeAscii(input: string, fallback: string): string {
  let value = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/[-_.]{2,}/g, '-')
    .replace(/^[-. ]+|[-. ]+$/g, '')
    .toLowerCase();
  if (value === '') value = fallback;
  if (WINDOWS_RESERVED.test(value)) value = `_${value}`;
  return value.slice(0, 100) || 'item';
}

function codepointFallback(input: string): string {
  const points = [...input].map((char) => char.codePointAt(0)?.toString(16) ?? '').filter(Boolean);
  return points.length > 0 ? `u-${points.join('-')}` : 'item';
}

/** 漫画移动文件；图片型 EPUB 复制 ASCII 页图，避免破坏 XHTML 内的旧引用。 */
export async function migrateBookPagePathsToAscii(store: LibraryStore, bookId: string): Promise<boolean> {
  const book = store.get(bookId);
  const pages = book?.pages ?? [];
  if (!book || pages.length === 0) return false;

  const context = `${book.title}\n${pages.map((page) => page.url).join('\n')}`;
  const language = detectCjkPathLanguage(context);
  const used = new Set<string>();
  const mapping = new Map<string, string>();
  for (const page of pages) {
    const oldRel = normalizeRel(page.url);
    mapping.set(oldRel, uniqueAsciiRel(await asciiRelativePath(oldRel, language), used));
  }
  if ([...mapping].every(([from, to]) => from === to)) return false;

  const contentDir = bookContentDir(book.id);
  const keepOriginal = book.format === 'epub';
  for (const [oldRel, newRel] of mapping) {
    if (oldRel === newRel) continue;
    const source = inside(contentDir, oldRel);
    const target = inside(contentDir, newRel);
    if (source === null || target === null) throw new Error(`页图路径越界：${oldRel}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(source)) {
      if (!fs.existsSync(target)) {
        if (keepOriginal) fs.copyFileSync(source, target);
        else fs.renameSync(source, target);
      }
    } else if (!fs.existsSync(target)) {
      throw new Error(`迁移页图时找不到文件：${oldRel}`);
    }
  }

  rewriteMangaJson(contentDir, mapping);
  const migratedPages: ComicPage[] = pages.map((page) => ({
    ...page,
    url: mapping.get(normalizeRel(page.url)) ?? page.url,
  }));
  const oldCover = book.coverRel === null ? null : normalizeRel(book.coverRel);
  const coverRel = oldCover === null ? null : (mapping.get(oldCover) ?? book.coverRel);
  store.update(book.id, { pages: migratedPages, coverRel });
  if (!keepOriginal) removeEmptyDirectories(contentDir);
  return true;
}

/** 启动时迁移旧书；单本失败不阻止整个书库打开。 */
export async function migrateLibraryPagePathsToAscii(store: LibraryStore): Promise<void> {
  for (const book of store.all()) {
    try {
      await migrateBookPagePathsToAscii(store, book.id);
    } catch (error) {
      console.warn(`[library] 无法迁移《${book.title}》的页图路径：`, error);
    }
  }
}

function rewriteMangaJson(contentDir: string, mapping: ReadonlyMap<string, string>): void {
  const file = path.join(contentDir, 'manga.json');
  if (!fs.existsSync(file)) return;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return;
  }
  if (typeof raw !== 'object' || raw === null) return;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record['pages'])) return;
  for (const item of record['pages']) {
    if (typeof item !== 'object' || item === null) continue;
    const page = item as Record<string, unknown>;
    if (typeof page['url'] !== 'string') continue;
    page['url'] = mapping.get(normalizeRel(page['url'])) ?? page['url'];
  }
  writeJsonAtomic(file, raw);
}

function inside(root: string, rel: string): string | null {
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(root, ...normalizeRel(rel).split('/'));
  return resolved.startsWith(`${rootResolved}${path.sep}`) ? resolved : null;
}

/** 唯一化后的名字仍保持规范 ASCII，确保下一次启动不会再改名。 */
function uniqueAsciiRel(rel: string, used: Set<string>): string {
  if (!used.has(rel)) {
    used.add(rel);
    return rel;
  }
  const dir = path.posix.dirname(rel);
  const ext = path.posix.extname(rel);
  const stem = path.posix.basename(rel, ext);
  const prefix = dir === '.' ? '' : `${dir}/`;
  for (let index = 2; ; index += 1) {
    const candidate = `${prefix}${stem}-${index}${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function removeEmptyDirectories(root: string): void {
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(path.join(dir, entry.name));
    }
    if (dir !== root && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  };
  visit(root);
}
