/**
 * IPC 处理器注册（主进程唯一的 IPC 入口）。
 *
 * 约定：
 * - 每个 handler 都必须把异常**转成拒绝的 promise 并带上可读消息**；渲染进程统一用
 *   `try/catch` + 顶部错误条呈现。主进程崩了是整个应用崩，代价完全不对等。
 * - 任何改动书库的 handler 结束后广播 `library:changed`，让 UI 自己重拉，而不是让
 *   渲染进程猜测本地状态。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron';

import type {
  BookRecord,
  ChapterContent,
  DictionaryStatus,
  BookSegments,
  OcrCapability,
  OcrJobResult,
  OcrProviderId,
  LlmAnalyzeRequest,
  OcrQueueState,
  WordCardDraft,
  SegmentJobResult,
  ImportOutcome,
  LibraryInfo,
  LibraryPage,
  LibraryQuery,
  LookupResult,
  OpenBookResult,
  PageText,
  ReadingPosition,
  SegmentToken,
} from '../shared/types';
import { IMPORTABLE_EXTENSIONS, IPC } from '../shared/ipc';

/**
 * Electron 的 `filters[].extensions` 要的是**不带点**的扩展名（`rar` 而不是 `.rar`），
 * 而我们的真相源统一带点（和 `path.extname` 的输出一致，少一次转换就少一处错）。
 */
function stripDots(extensions: readonly string[]): string[] {
  return extensions.map((ext) => ext.replace(/^\./, ''));
}
import { importPath } from './library/importer';
import { LibraryStore, PositionStore } from './library/store';
import { DictionaryService } from './dict/service';
import type { ExtensionService } from './extensions/service';
import { addCard, listCards, removeCard, updateCard } from './library/cards';
import { setImportDefaults } from './library/importer';
import { readAppDefaults, writeAppDefaults } from './settings';
import type { AppDefaults } from '../shared/defaults';
import type { LlmService } from './llm/service';
import type { OcrService } from './ocr/service';
import type { SegmentService } from './segment/service';
import { getChapterContent, getPageText, invalidateContentCache } from './reader/content';
import { emitEvent } from './events';
import { bookUrl } from './reader/protocol';
import { libraryRoot, settingsPath } from './paths';

export interface Services {
  store: LibraryStore;
  positions: PositionStore;
  dict: DictionaryService;
  ocr: OcrService;
  segment: SegmentService;
  extensions: ExtensionService;
  llm: LlmService;
}

export function registerIpc(services: Services): void {
  const { store, positions, dict, ocr, segment, extensions, llm } = services;

  const requireBook = (bookId: string): BookRecord => {
    const book = store.get(bookId);
    if (!book) throw new Error(`书不存在（可能已被删除）：${bookId}`);
    return book;
  };

  const handle = <T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...(args as never[]));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(message);
      }
    });
  };

  // --- 书库 ---

  handle(IPC.libraryInfo, (): LibraryInfo => store.info());

  handle(IPC.libraryList, (query: LibraryQuery): LibraryPage => store.query(query ?? {}));

  handle(IPC.libraryImport, async (paths: string[]): Promise<ImportOutcome[]> => {
    const outcomes = await runImport(paths ?? [], store);
    emitEvent('library:changed', { reason: 'import' });
    return outcomes;
  });

  handle(IPC.libraryImportDialog, async (): Promise<ImportOutcome[]> => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options: OpenDialogOptions = {
      title: '导入漫画 / 小说',
      // 目录也要能选：一堆页图的文件夹是最常见的漫画来源。
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      // 从 `IMPORTABLE_EXTENSIONS` 生成，**不要**在这里手写扩展名列表：
      // 这里漏一个，那个格式就在文件选择器里变灰、只能靠拖放导入。
      filters: [
        { name: '电子书与漫画', extensions: stripDots(IMPORTABLE_EXTENSIONS.all) },
        { name: 'EPUB', extensions: stripDots(IMPORTABLE_EXTENSIONS.epub) },
        { name: '漫画压缩包', extensions: stripDots(IMPORTABLE_EXTENSIONS.comics) },
        { name: 'mokuro 清单', extensions: stripDots(IMPORTABLE_EXTENSIONS.mokuro) },
        { name: '图片', extensions: stripDots(IMPORTABLE_EXTENSIONS.images) },
        { name: '全部文件', extensions: ['*'] },
      ],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return [];
    const outcomes = await runImport(result.filePaths, store);
    emitEvent('library:changed', { reason: 'import' });
    return outcomes;
  });

  handle(IPC.libraryRemove, (bookIds: string[]): void => {
    for (const bookId of bookIds ?? []) {
      invalidateContentCache(bookId);
      positions.remove(bookId);
      const removed = store.remove(bookId);
      const dir = removed?.dir ?? path.join(libraryRoot(), bookId);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 目录删不掉（占用/权限）不该让 UI 以为删除失败：索引已经移除，
        // 留下一份孤儿文件比留一个删不掉的书目好。
      }
    }
    emitEvent('library:changed', { reason: 'remove' });
  });

  handle(IPC.libraryOpen, (bookId: string): OpenBookResult => {
    const book = requireBook(bookId);
    const updated = store.update(bookId, { lastOpenedAt: Date.now() });
    return { book: updated, position: positions.get(bookId) };
  });

  handle(IPC.librarySavePosition, (position: ReadingPosition): void => {
    if (!position || typeof position.bookId !== 'string') return;
    positions.set({ ...position, updatedAt: Date.now() });
  });

  handle(IPC.libraryUpdateMeta, (bookId: string, patch: Partial<BookRecord>): BookRecord => {
    requireBook(bookId);
    // 白名单：绝不让渲染进程改 id/dir/spine/pages 这类结构性字段。
    const allowed: Partial<BookRecord> = {};
    if (typeof patch.title === 'string') allowed.title = patch.title;
    if (typeof patch.author === 'string') allowed.author = patch.author;
    if (patch.series === null || typeof patch.series === 'string') allowed.series = patch.series;
    if (patch.volume === null || typeof patch.volume === 'number') allowed.volume = patch.volume;
    if (Array.isArray(patch.tags)) allowed.tags = patch.tags.filter((t) => typeof t === 'string');
    if (patch.direction === 'ltr' || patch.direction === 'rtl') allowed.direction = patch.direction;
    // 阅读方式：图片型小说要能在「小说阅读器 / 漫画阅读器」之间手动切。
    // 只允许这两种值，且**必须**受页图约束（渲染进程乱传也不该出现「漫画模式读一本纯文字书」）。
    if (patch.readerMode === 'epub' || patch.readerMode === 'comic') {
      const target = store.get(bookId);
      if (target && (target.pages ?? []).length > 0) allowed.readerMode = patch.readerMode;
    }
    const updated = store.update(bookId, allowed);
    emitEvent('library:changed', { reason: 'update' });
    return updated;
  });

  handle(IPC.libraryReveal, (bookId: string): void => {
    const book = store.get(bookId);
    if (book) shell.showItemInFolder(book.dir);
  });

  // --- 阅读器 ---

  handle(IPC.chapterContent, (bookId: string, spineIndex: number): ChapterContent => {
    const book = requireBook(bookId);
    return getChapterContent(book, spineIndex);
  });

  handle(IPC.comicPageText, (bookId: string, pageIndex: number): PageText => {
    const book = requireBook(bookId);
    return getPageText(book, pageIndex);
  });

  // --- 词典 ---

  handle(IPC.dictStatus, (): DictionaryStatus => dict.status());

  handle(IPC.dictImport, async (zipPaths: string[]): Promise<DictionaryStatus> => {
    for (const zipPath of zipPaths ?? []) await dict.importZip(zipPath);
    const status = dict.status();
    emitEvent('dict:changed', status);
    return status;
  });

  handle(IPC.dictImportDialog, async (): Promise<DictionaryStatus | null> => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options: OpenDialogOptions = {
      title: '导入词典（Yomitan / Yomichan 格式 .zip）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Yomitan 词典包', extensions: ['zip'] }],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    for (const zipPath of result.filePaths) await dict.importZip(zipPath);
    const status = dict.status();
    emitEvent('dict:changed', status);
    return status;
  });

  handle(IPC.dictRemove, async (dictId: string): Promise<DictionaryStatus> => {
    const status = await dict.remove(dictId);
    emitEvent('dict:changed', status);
    return status;
  });

  handle(IPC.dictSetEnabled, async (dictId: string, enabled: boolean): Promise<DictionaryStatus> => {
    const status = await dict.setEnabled(dictId, enabled);
    emitEvent('dict:changed', status);
    return status;
  });

  handle(IPC.dictLookup, (text: string, charOffset?: number): LookupResult => dict.lookup(text, charOffset));

  handle(IPC.dictSegment, (text: string): SegmentToken[] => dict.segment(text));

  // --- 本地漫画 OCR ---

  handle(IPC.ocrCapability, (): Promise<OcrCapability> => ocr.capability());

  handle(IPC.ocrStatus, (bookId: string): OcrJobResult | null => ocr.status(bookId));

  handle(IPC.ocrStart, (bookId: string, options?: { force?: boolean }): OcrJobResult =>
    ocr.start(bookId, options ?? {}),
  );

  handle(IPC.ocrCancel, (bookId: string): void => {
    ocr.cancel(bookId);
  });

  handle(IPC.ocrQueue, (): OcrQueueState => ocr.queueState());

  handle(IPC.ocrSelectProvider, (provider: OcrProviderId): Promise<OcrCapability> =>
    ocr.selectProvider(provider),
  );

  // --- 主进程侧默认值 ---

  handle(IPC.defaultsRead, () => readAppDefaults(settingsPath()));

  handle(IPC.defaultsWrite, (patch: Partial<AppDefaults>) => {
    const next = writeAppDefaults(settingsPath(), patch);
    // 导入器是模块级函数，得显式通知它——否则改完默认方向要重启才生效。
    setImportDefaults(next);
    return next;
  });

  // --- 词卡（按书存）---

  handle(IPC.cardsList, (bookId: string) => {
    requireBook(bookId);
    return listCards(bookId);
  });

  handle(IPC.cardsAdd, (bookId: string, draft: WordCardDraft) => {
    requireBook(bookId);
    return addCard(bookId, draft);
  });

  handle(IPC.cardsUpdate, (bookId: string, id: string, patch: Parameters<typeof updateCard>[2]) =>
    updateCard(bookId, id, patch),
  );

  handle(IPC.cardsRemove, (bookId: string, id: string) => removeCard(bookId, id));

  // --- LLM（词卡分析）---

  handle(IPC.llmSettings, () => llm.settings());

  handle(IPC.llmUpdate, (patch: Parameters<LlmService['update']>[0]) => llm.update(patch));

  handle(IPC.llmSetApiKey, (profileId: string, apiKey: string | null) =>
    llm.setApiKey(profileId, apiKey),
  );

  handle(IPC.llmAnalyze, (request: LlmAnalyzeRequest) => llm.analyze(request));

  // --- 扩展（清单 + 下载器）---

  handle(IPC.extensionsList, () => extensions.list());

  handle(IPC.extensionsRefresh, () => extensions.refreshCatalog());

  handle(IPC.extensionsInstall, (id: string) => extensions.install(id));

  handle(IPC.extensionsCancel, (id: string): void => {
    extensions.cancel(id);
  });

  handle(IPC.extensionsRemove, (id: string) => extensions.remove(id));
  handle(IPC.extensionsRepositoryAdd, (name: string, url: string) => extensions.addRepository(name, url));
  handle(IPC.extensionsRepositoryRemove, (url: string) => extensions.removeRepository(url));

  // --- 分词 ---

  handle(IPC.segmentStatus, (bookId: string): SegmentJobResult | null => segment.status(bookId));

  handle(IPC.segmentRead, (bookId: string): BookSegments | null => segment.read(bookId));

  handle(IPC.segmentStart, (bookId: string, options?: { force?: boolean }): SegmentJobResult =>
    segment.start(bookId, options ?? {}),
  );

  handle(IPC.segmentCancel, (bookId: string): void => {
    segment.cancel(bookId);
  });

  handle(IPC.segmentClear, (bookId: string): void => {
    segment.clear(bookId);
  });

  // --- 单向通知 ---

  ipcMain.on('arale:notify', (_event, channel: string, payload: unknown) => {
    if (channel === 'renderer:ready') {
      // 窗口一就绪就在后台载词典，用户第一次点词时通常已经好了。
      void dict.ensureLoaded().then((status) => emitEvent('dict:changed', status));
    }
    void payload;
  });
}

async function runImport(paths: string[], store: LibraryStore): Promise<ImportOutcome[]> {
  const outcomes: ImportOutcome[] = [];
  // 串行导入：并发写 index.json 会互相覆盖（原子写只保证单次写不撕裂，不保证不丢更新）。
  for (const source of paths) {
    // eslint-disable-next-line no-await-in-loop -- 见上：必须串行
    // importPath 返回数组：套娃包（如「01-02 卷.rar」里装两个分卷）会一次产出多本书。
    outcomes.push(...(await importPath(source, store)));
  }
  return outcomes;
}
