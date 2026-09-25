/**
 * 书库索引 + 阅读进度（内存缓存 + 原子落盘）。
 *
 * 为什么用「一个 index.json + 每本书一份 book.json」而不是上来就 SQLite：
 * - 书库规模在桌面端是几百到几万本，`index.json` 全量读进内存完全够（Fushi 用了
 *   86 张表的 Drift，那是为视频/番剧/同步/统计付的复杂度，我们不要，见 analysis 04 §K）；
 * - 每本书另存一份 `book.json` 是为了**单本可恢复**：index.json 万一写坏（例如用户
 *   手动编辑），扫描 `<bookId>/book.json` 就能重建索引，而不是整个书架蒸发；
 * - 迁移到 SQLite 的接口面就是这一个类，换实现不影响上层。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  BookFormat,
  BookRecord,
  LibraryInfo,
  LibraryPage,
  LibraryQuery,
  LibrarySort,
  ReadingDirection,
  ReadingPosition,
} from '../../shared/types';
import { readJson, writeJsonAtomic } from '../../core/util/atomic-json';
import { bookDir, libraryRoot, libraryIndexPath, positionsPath } from '../paths';
import { makeSortKey } from '../../core/util/sort-key';

interface IndexFile {
  version: 1;
  books: BookRecord[];
}

const EMPTY_INDEX: IndexFile = { version: 1, books: [] };

export class LibraryStore {
  private books = new Map<string, BookRecord>();
  private loaded = false;

  /** 从磁盘载入（幂等）。索引缺失/损坏时回落到扫描每本书的 book.json。 */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const index = readJson<IndexFile>(libraryIndexPath(), EMPTY_INDEX);
    for (const book of index.books) {
      if (book && typeof book.id === 'string') this.books.set(book.id, book);
    }
    if (this.books.size === 0) this.rebuildFromBookDirs();
  }

  /**
   * 兜底重建：遍历 `library/` 下的目录读 `book.json`。
   * 只在 index 为空/损坏时跑，代价是 O(书数) 次小文件读，可以接受。
   */
  private rebuildFromBookDirs(): void {
    const root = libraryRoot();
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const record = readJson<BookRecord | null>(path.join(root, name, 'book.json'), null);
      if (record && typeof record.id === 'string') this.books.set(record.id, record);
    }
    if (this.books.size > 0) this.persist();
  }

  persist(): void {
    const payload: IndexFile = { version: 1, books: [...this.books.values()] };
    writeJsonAtomic(libraryIndexPath(), payload);
  }

  persistBook(record: BookRecord): void {
    writeJsonAtomic(path.join(bookDir(record.id), 'book.json'), record);
  }

  all(): BookRecord[] {
    this.load();
    return [...this.books.values()];
  }

  get(bookId: string): BookRecord | null {
    this.load();
    return this.books.get(bookId) ?? null;
  }

  add(record: BookRecord): BookRecord {
    this.load();
    this.books.set(record.id, record);
    this.persistBook(record);
    this.persist();
    return record;
  }

  update(bookId: string, patch: Partial<BookRecord>): BookRecord {
    this.load();
    const current = this.books.get(bookId);
    if (!current) throw new Error(`Book not found: ${bookId}`);
    const next: BookRecord = { ...current, ...patch, id: current.id, updatedAt: Date.now() };
    if (patch.title !== undefined && patch.title !== current.title) {
      next.titleSort = makeSortKey(patch.title);
    }
    this.books.set(bookId, next);
    this.persistBook(next);
    this.persist();
    return next;
  }

  remove(bookId: string): { dir: string } | null {
    this.load();
    const record = this.books.get(bookId);
    this.books.delete(bookId);
    this.persist();
    return record ? { dir: bookDir(bookId) } : null;
  }

  info(): LibraryInfo {
    this.load();
    const books = [...this.books.values()];
    return {
      dir: libraryRoot(),
      bookCount: books.length,
      comicCount: books.filter((b) => b.format === 'comic').length,
      epubCount: books.filter((b) => b.format === 'epub').length,
    };
  }

  query(query: LibraryQuery): LibraryPage {
    this.load();
    const all = [...this.books.values()];
    const allTags = [...new Set(all.flatMap((b) => b.tags))].sort((a, b) => a.localeCompare(b, 'ja'));
    const allSeries = [...new Set(all.map((b) => b.series).filter((s): s is string => !!s))].sort((a, b) =>
      a.localeCompare(b, 'ja'),
    );
    const allAuthors = [...new Set(all.map((b) => b.author).filter((a) => a.trim() !== ''))].sort((a, b) =>
      a.localeCompare(b, 'ja'),
    );

    let filtered = all;
    if (query.format) {
      const format: BookFormat = query.format;
      filtered = filtered.filter((b) => b.format === format);
    }
    if (query.tags && query.tags.length > 0) {
      const wanted = new Set(query.tags);
      filtered = filtered.filter((b) => b.tags.some((t) => wanted.has(t)));
    }
    if (query.search && query.search.trim().length > 0) {
      const needle = query.search.trim().toLowerCase();
      filtered = filtered.filter((b) => bookMatches(b, needle));
    }

    const sorted = sortBooks(filtered, query.sort ?? 'title');
    const offset = Math.max(0, query.offset ?? 0);
    const limit = query.limit && query.limit > 0 ? query.limit : sorted.length;
    return {
      books: sorted.slice(offset, offset + limit),
      total: sorted.length,
      allTags,
      allSeries,
      allAuthors,
    };
  }
}

function bookMatches(book: BookRecord, needle: string): boolean {
  const haystack = [book.title, book.author, book.series ?? '', book.publisher ?? '', ...book.tags]
    .join('\u0000')
    .toLowerCase();
  return haystack.includes(needle);
}

function sortBooks(books: BookRecord[], sort: LibrarySort): BookRecord[] {
  const compare = (a: BookRecord, b: BookRecord): number => {
    switch (sort) {
      case 'title':
        return compareText(a.titleSort, b.titleSort);
      case 'titleDesc':
        return compareText(b.titleSort, a.titleSort);
      case 'author':
        return compareText(a.author, b.author) || compareText(a.titleSort, b.titleSort);
      case 'series':
        return (
          compareText(a.series ?? '\uffff', b.series ?? '\uffff') ||
          (a.volume ?? 0) - (b.volume ?? 0) ||
          compareText(a.titleSort, b.titleSort)
        );
      case 'added':
        return a.addedAt - b.addedAt;
      case 'addedDesc':
        return b.addedAt - a.addedAt;
      case 'lastOpened':
        return (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0);
      default:
        return compareText(a.titleSort, b.titleSort);
    }
  };
  return books.slice().sort(compare);
}

/** 用 `localeCompare` 走 ICU，中日文按假名/拼音序，比 code-unit 比更符合直觉。 */
function compareText(a: string, b: string): number {
  return a.localeCompare(b, 'ja');
}

// ---------------------------------------------------------------------------
// 阅读进度
// ---------------------------------------------------------------------------

export class PositionStore {
  private positions = new Map<string, ReadingPosition>();
  private loaded = false;
  private writeTimer: NodeJS.Timeout | null = null;

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const raw = readJson<Record<string, ReadingPosition>>(positionsPath(), {});
    for (const [bookId, position] of Object.entries(raw)) {
      if (position && typeof position === 'object') this.positions.set(bookId, position);
    }
  }

  get(bookId: string): ReadingPosition | null {
    this.load();
    return this.positions.get(bookId) ?? null;
  }

  /**
   * 写入并**延迟**落盘：阅读时每次滚动都会调它，同步写盘会让滚动掉帧。
   * 250ms 合并窗口，进程退出前由 `flush()` 兜底。
   */
  set(position: ReadingPosition): void {
    this.load();
    this.positions.set(position.bookId, position);
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, 250);
  }

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const payload: Record<string, ReadingPosition> = {};
    for (const [bookId, position] of this.positions) payload[bookId] = position;
    writeJsonAtomic(positionsPath(), payload);
  }

  remove(bookId: string): void {
    this.load();
    this.positions.delete(bookId);
    this.flush();
  }
}

/** 新建书时统一走它，保证 direction/sort/timestamps 口径一致。 */
export function makeBaseRecord(input: {
  id: string;
  format: BookFormat;
  title: string;
  author?: string;
  series?: string | null;
  volume?: number | null;
  language?: string | null;
  publisher?: string | null;
  description?: string | null;
  direction?: ReadingDirection;
  dir: string;
}): BookRecord {
  const now = Date.now();
  return {
    id: input.id,
    format: input.format,
    title: input.title,
    titleSort: makeSortKey(input.title),
    author: input.author ?? '',
    series: input.series ?? null,
    volume: input.volume ?? null,
    language: input.language ?? null,
    publisher: input.publisher ?? null,
    description: input.description ?? null,
    tags: [],
    coverRel: null,
    dir: input.dir,
    addedAt: now,
    updatedAt: now,
    lastOpenedAt: null,
    direction: input.direction ?? (input.format === 'comic' ? 'rtl' : 'ltr'),
    spine: null,
    toc: null,
    opfRel: null,
    pages: null,
    pageCount: 0,
  };
}
