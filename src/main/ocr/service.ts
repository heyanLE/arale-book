/**
 * 漫画 OCR 服务：**引擎无关的编排层**。
 *
 * 职责边界：
 * - 挑引擎（系统 OCR / 扩展引擎）并把它跑起来；
 * - **串行任务队列**：每次请求都是入队，同一时刻只有一本在跑（见 [OcrService.start]）；
 * - 逐页发进度、支持取消（正在跑的中断、排队中的直接移除）、按书去重；
 * - 把结果合并进 `content/manga.json`（与导入产出的格式完全一致，阅读器一行都不用改）；
 * - 记住用户选的引擎。
 *
 * OCR 在本应用里是**可选**的：不跑它，漫画就是纯图片，能看能翻，只是点不出词典。
 * 所以这里没有任何东西挂在启动路径上——引擎是构造出来的，模型是首次任务时才下载的。
 *
 * 为什么是**串行**而不是「谁点谁立刻跑」：两个引擎都是独占 CPU 的重活（内置引擎逐页
 * 推理 ONNX，扩展引擎还要拉起自带运行时）。并发只会让每一本都变慢、内存翻倍，
 * 而用户在意的只是「我要识别的那几本最后都识别完」。串行还能让右下角那个全局进度条
 * 有唯一含义。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  BookRecord,
  OcrCapability,
  OcrEngineStatus,
  OcrJobResult,
  OcrProgress,
  OcrProviderId,
  OcrQueueEntry,
  OcrQueueState,
  PageText,
} from '../../shared/types';
import { readJson, writeJsonAtomic } from '../../core/util/atomic-json';
import { parseMangaJson, serializeMangaJson } from '../../core/comic/mokuro';
import { bookContentDir } from '../paths';
import { invalidateContentCache } from '../reader/content';
import { emitEvent } from '../events';
import { blocksFromLines } from '../../core/ocr/blocks';
import type { OcrBookJob, OcrEngine, OcrPageInput, OcrPageOut, OcrSink } from './provider';

export interface OcrServiceOptions {
  getBook: (bookId: string) => BookRecord | null;
  /** 可用引擎。顺序无关，UI 按 `id` 选。 */
  engines: OcrEngine[];
  /** 扩展安装目录（`<userData>/extensions`），写进 capability 供 UI 显示。 */
  extensionsDir: string;
  /** 记住所选引擎的设置文件（`<userData>/settings.json`）。 */
  settingsFile: string;
  /** 任务结束后回调（清缓存 / 广播书库更新）。 */
  onFinished?: (bookId: string) => void;
}

/** 已经出队、正在跑的那一条。 */
interface RunningJob {
  cancelled: boolean;
  provider: OcrProviderId;
  entry: QueueItem;
  finished: Promise<OcrJobResult>;
}

/** 队列里的一条（内部形态：比契约多一个 `force`）。 */
interface QueueItem {
  bookId: string;
  title: string;
  provider: OcrProviderId;
  force: boolean;
  enqueuedAt: number;
  total: number;
}

/** 一个待完成任务的兑现器，给 `wait()` 与测试用。 */
interface Waiter {
  promise: Promise<OcrJobResult>;
  resolve: (result: OcrJobResult) => void;
}

interface SettingsShape {
  ocrProvider?: OcrProviderId;
}

const DEFAULT_PROVIDER: OcrProviderId = 'system';

export class OcrService {
  /** FIFO 等待队列。`active` 是唯一在跑的那条。 */
  private readonly queue: QueueItem[] = [];
  private active: RunningJob | null = null;
  /** 每本书最近一次的**结束**结果（含失败与取消）。 */
  private readonly results = new Map<string, OcrJobResult>();
  /** 每本书的结果兑现器：`wait()` 靠它，不必轮询。 */
  private readonly waiters = new Map<string, Waiter>();

  constructor(private readonly options: OcrServiceOptions) {}

  // -------------------------------------------------------------------------
  // 引擎选择
  // -------------------------------------------------------------------------

  private readSelected(): OcrProviderId {
    const settings = readJson<SettingsShape>(this.options.settingsFile, {});
    const saved = settings.ocrProvider;
    if (saved && this.options.engines.some((engine) => engine.id === saved)) return saved;
    return DEFAULT_PROVIDER;
  }

  private resolveEngine(provider?: OcrProviderId): OcrEngine {
    const wanted = provider ?? this.readSelected();
    return (
      this.options.engines.find((engine) => engine.id === wanted) ??
      this.options.engines.find((engine) => engine.id === DEFAULT_PROVIDER) ??
      // 兜底：万一内置引擎都没注册（理论上不会），拿第一个可用引擎。
      (this.options.engines[0] as OcrEngine)
    );
  }

  /** 记住用户选的引擎。下次开 OCR 默认用它。 */
  async selectProvider(provider: OcrProviderId): Promise<OcrCapability> {
    const settings = readJson<SettingsShape>(this.options.settingsFile, {});
    writeJsonAtomic(this.options.settingsFile, { ...settings, ocrProvider: provider });
    return this.capability();
  }

  /**
   * 各引擎的可用性与就绪状态。
   *
   * 每次都重新探测（不缓存）：用户完全可能在开着应用的时候去装好扩展，
   * 缓一份就会一直显示「不可用」。探测本身很轻（stat 几个文件、不加载模型）。
   */
  async capability(): Promise<OcrCapability> {
    const providers: OcrEngineStatus[] = [];
    for (const engine of this.options.engines) {
      try {
        providers.push(await engine.status());
      } catch (error) {
        providers.push({
          id: engine.id,
          label: engine.id,
          available: false,
          ready: false,
          reason: error instanceof Error ? error.message : String(error),
          requirement: '',
          downloadSizeMb: 0,
          extension: null,
        });
      }
    }

    const selected = this.readSelected();
    const current = providers.find((item) => item.id === selected) ?? providers[0];
    const anyAvailable = providers.some((item) => item.available);

    return {
      available: anyAvailable,
      // 一个可用的都没有时，把**默认引擎**的原因报出来：那是用户没有选择时
      // 会落到的地方，说别的引擎为什么不行只会让人困惑。
      reason: anyAvailable ? null : (providers.find((item) => item.id === DEFAULT_PROVIDER)?.reason ?? current?.reason ?? null),
      extensionsDir: this.options.extensionsDir,
      providers,
      selected,
    };
  }

  // -------------------------------------------------------------------------
  // 任务
  // -------------------------------------------------------------------------

  /** 这本书现在在哪：正在跑 / 排队第几位 / 没有。 */
  private slotOf(bookId: string): { active: true } | { position: number } | null {
    if (this.active?.entry.bookId === bookId) return { active: true };
    const index = this.queue.findIndex((item) => item.bookId === bookId);
    return index >= 0 ? { position: index + 1 } : null;
  }

  status(bookId: string): OcrJobResult | null {
    // 错误文案是**契约**：冒烟脚本靠 `error !== '正在识别中…'` 判断任务是否结束
    // （scripts/smoke.mjs 的轮询循环），改字会让那条检查永远等下去。
    if (this.active?.entry.bookId === bookId) {
      return {
        bookId,
        ok: false,
        provider: this.active.provider,
        pages: 0,
        blocks: 0,
        error: '正在识别中…',
      };
    }
    const index = this.queue.findIndex((item) => item.bookId === bookId);
    if (index >= 0) {
      const item = this.queue[index]!;
      return {
        bookId,
        ok: false,
        provider: item.provider,
        pages: 0,
        blocks: 0,
        error: '排队中…',
        queued: true,
        queuePosition: index + 1,
      };
    }
    return this.results.get(bookId) ?? null;
  }

  isRunning(bookId: string): boolean {
    return this.slotOf(bookId) !== null;
  }

  /** 队列快照。`total` 用入队时记下的页数，`title` 用入队时的书名快照。 */
  queueState(): OcrQueueState {
    const toEntry = (item: QueueItem): OcrQueueEntry => ({
      bookId: item.bookId,
      title: item.title,
      provider: item.provider,
      enqueuedAt: item.enqueuedAt,
      total: item.total,
    });
    return {
      active: this.active ? toEntry(this.active.entry) : null,
      pending: this.queue.map(toEntry),
    };
  }

  /**
   * 把一个任务**加入队列**（不是立刻跑）。
   *
   * 同一本书在跑或已排队时直接返回它当前的状态，不重复入队——用户连点两下
   * 「识别文字」不该得到两条一模一样的任务。
   *
   * **不等它跑完**——一次 200 页的识别要十几分钟，把 IPC 调用挂在那里，
   * UI 看起来就像卡死了。进度走事件。
   */
  start(bookId: string, options: { force?: boolean; provider?: OcrProviderId } = {}): OcrJobResult {
    // 引擎在**入队时**就定下来：任务真正开跑可能要等前面几本跑完，那时用户可能已经
    // 在设置里换了默认引擎；队列里显示的、跑的必须是同一个东西。
    const engine = this.resolveEngine(options.provider);

    const existing = this.slotOf(bookId);
    if (existing !== null) {
      if ('active' in existing) {
        return {
          bookId,
          ok: false,
          provider: this.active?.provider ?? engine.id,
          pages: 0,
          blocks: 0,
          error: '已在识别中…',
        };
      }
      return {
        bookId,
        ok: false,
        provider: engine.id,
        pages: 0,
        blocks: 0,
        error: `已在队列中（第 ${existing.position} 位）`,
        queued: true,
        queuePosition: existing.position,
      };
    }

    const book = this.options.getBook(bookId);
    if (!book) return { bookId, ok: false, provider: engine.id, pages: 0, blocks: 0, error: '书不存在' };
    // 图片型小说（format=epub + readerMode=comic）同样是一叠页图，同样需要 OCR。
    // 所以判据是「有没有页图」，不是 format。
    const pages = book.pages ?? [];
    if (pages.length === 0) {
      return {
        bookId,
        ok: false,
        provider: engine.id,
        pages: 0,
        blocks: 0,
        error: '这本书没有页图，不需要 OCR',
      };
    }

    // 已经有文字层且不强制重做 → 跳过。用户点「识别」不该把已有结果覆盖掉。
    // 这一步放在**入队前**：既有的文字层是本地就能查出来的事实，没必要排到队尾
    // 等几分钟才告诉用户「其实不用跑」。
    if (!options.force && hasTextLayer(book)) {
      const skipped: OcrJobResult = {
        bookId,
        ok: true,
        provider: engine.id,
        pages: 0,
        blocks: countBlocks(book),
        skipped: true,
      };
      this.results.set(bookId, skipped);
      return skipped;
    }

    const item: QueueItem = {
      bookId,
      title: book.title,
      provider: engine.id,
      force: options.force === true,
      enqueuedAt: Date.now(),
      total: pages.length,
    };
    this.queue.push(item);
    // 位置要在 `pump()` **之前**取：队列空闲时 pump 会立刻把这条移进 active，
    // 之后再看队列就已经找不到了（会得到「第 1 位」这个假位置）。
    const queuePosition = this.queue.length;

    let resolve!: (result: OcrJobResult) => void;
    const promise = new Promise<OcrJobResult>((res) => {
      resolve = res;
    });
    this.waiters.set(bookId, { promise, resolve });

    this.emitQueue();
    this.pump();

    return {
      bookId,
      ok: true,
      provider: engine.id,
      pages: 0,
      blocks: 0,
      queued: true,
      queuePosition,
    };
  }

  /**
   * 取消：正在跑的中断，排队中的直接移出队列。
   *
   * 两者的用户语义其实不同（一个是「别跑了」，一个是「我改主意了，别开始」），
   * 但按钮是同一个，结果也一样——没有任何文字层被写进去之外的变化。
   */
  cancel(bookId: string): void {
    if (this.active?.entry.bookId === bookId) {
      this.active.cancelled = true;
      return;
    }
    const index = this.queue.findIndex((item) => item.bookId === bookId);
    if (index < 0) return;
    const [removed] = this.queue.splice(index, 1);
    // 排队中被取消：兑现一个明确的结束态，别让 wait() 永远挂着。
    this.settle(bookId, {
      bookId,
      ok: false,
      provider: removed?.provider ?? DEFAULT_PROVIDER,
      pages: 0,
      blocks: 0,
      error: '已取消（还没开始识别）',
    });
    this.emitQueue();
  }

  /** 等一个任务跑完（测试与「退出前收尾」用）。 */
  async wait(bookId: string): Promise<OcrJobResult | null> {
    const waiter = this.waiters.get(bookId);
    if (waiter) return waiter.promise;
    return this.results.get(bookId) ?? null;
  }

  /** 等队列**完全**排空（测试用：一次等好几本时不必挨个 wait）。 */
  async drain(): Promise<void> {
    // 每轮重新取一遍 waiter：跑完一本会接着 pump 下一本，新的 waiter 是那时才建的。
    while (this.active !== null || this.queue.length > 0) {
      const running = this.active;
      if (running) await running.finished;
      // active 为空但队列非空：理论上不会出现（push 之后总会 pump），
      // 但这里再踢一脚而不是空转，免得 drain() 变成死循环。
      else this.pump();
    }
  }

  // -------------------------------------------------------------------------
  // 队列推进
  // -------------------------------------------------------------------------

  private emitQueue(): void {
    emitEvent('ocr:queue', this.queueState());
  }

  /** 兑现某本书的结束态：写结果、通知 waiter、广播 `ocr:done`。 */
  private settle(bookId: string, result: OcrJobResult): void {
    this.results.set(bookId, result);
    const waiter = this.waiters.get(bookId);
    if (waiter) {
      this.waiters.delete(bookId);
      waiter.resolve(result);
    }
    emitEvent('ocr:done', result);
  }

  /**
   * 队列泵：空闲时从队头取一条开始跑，跑完再取下一条。
   *
   * 所有会改变队列的操作最后都要调它一次；它是**唯一**让任务开始跑的地方，
   * 所以「同一时刻只有一本在跑」这条不变量只在一个地方需要保证。
   */
  private pump(): void {
    if (this.active !== null) return;
    const item = this.queue.shift();
    if (item === undefined) return;

    const book = this.options.getBook(item.bookId);
    if (!book) {
      // 排到队时书已经被删了。不能静默跳过——用户会一直等一本不存在的书。
      this.emitQueue();
      this.settle(item.bookId, {
        bookId: item.bookId,
        ok: false,
        provider: item.provider,
        pages: 0,
        blocks: 0,
        error: '书不存在（可能已被删除）',
      });
      this.pump();
      return;
    }

    const engine = this.resolveEngine(item.provider);
    const job: RunningJob = {
      cancelled: false,
      provider: engine.id,
      entry: item,
      finished: undefined as never,
    };
    this.active = job;
    // 先置 active 再广播：队列弹层要立刻把这条从「排队中」挪到「识别中」，
    // 顺序反了会闪一帧「队列空了」。
    this.emitQueue();

    job.finished = this.runJob(book, engine, job)
      .catch(
        (error: unknown): OcrJobResult => ({
          bookId: item.bookId,
          ok: false,
          provider: engine.id,
          pages: 0,
          blocks: 0,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .then((result) => {
        this.active = null;
        this.settle(item.bookId, result);
        this.emitQueue();
        // 递归推进：下一本接着跑。
        this.pump();
        return result;
      });
  }

  // -------------------------------------------------------------------------
  // 执行
  // -------------------------------------------------------------------------

  private emit(progress: OcrProgress): void {
    emitEvent('ocr:progress', progress);
  }

  private async runJob(book: BookRecord, engine: OcrEngine, job: RunningJob): Promise<OcrJobResult> {
    const pages = book.pages ?? [];
    if (pages.length === 0) {
      return { bookId: book.id, ok: false, provider: engine.id, pages: 0, blocks: 0, error: '这本书没有页' };
    }

    const contentDir = bookContentDir(book.id);
    const inputs: OcrPageInput[] = pages.map((page) => ({
      rel: page.url,
      absPath: path.join(contentDir, ...page.url.split('/')),
      width: page.width,
      height: page.height,
    }));

    // 引擎报过的页（进度用）。结果本身在 recognize() 的返回值里，两边形状一致。
    const reported = new Set<number>();

    const request: OcrBookJob = {
      book,
      contentDir,
      pages: inputs,
      direction: book.direction,
      isCancelled: () => job.cancelled,
    };

    const sink: OcrSink = {
      page: (page) => {
        reported.add(page.index);
        this.emit({
          bookId: book.id,
          provider: engine.id,
          done: reported.size,
          total: pages.length,
          pageIndex: page.index,
          stage: 'recognizing',
        });
      },
      message: (message) =>
        this.emit({
          bookId: book.id,
          provider: engine.id,
          done: reported.size,
          total: pages.length,
          pageIndex: 0,
          stage: 'loading-model',
          message,
        }),
    };

    this.emit({
      bookId: book.id,
      provider: engine.id,
      done: 0,
      total: pages.length,
      pageIndex: 0,
      stage: 'loading-model',
    });

    let pagesOut: OcrPageOut[] = [];
    try {
      pagesOut = await engine.recognize(request, sink);
    } finally {
      await engine.dispose().catch(() => undefined);
    }

    // ★ 行 → 块在这里做，且**只在这里做**：引擎只吐行（`core/ocr/blocks.ts` 的
    //   `blocksFromLines` 是唯一实现），阅读顺序与成块不再由每个引擎各写一遍。
    const recognized: PageText[] = pages.map((page, index) => {
      const out = pagesOut[index];
      return { url: page.url, blocks: blocksFromLines(out?.lines ?? [], book.direction) };
    });

    if (job.cancelled) {
      // 取消时**已经识别出来的页照样写盘**：用户重跑不必从第 1 页再来一遍。
      this.writeTextLayer(book, engine, recognized, pages);
      return {
        bookId: book.id,
        ok: false,
        provider: engine.id,
        pages: recognized.filter((page) => page.blocks.length > 0).length,
        blocks: recognized.reduce((sum, page) => sum + page.blocks.length, 0),
        error: '已取消（已识别的页已保存）',
      };
    }

    this.emit({
      bookId: book.id,
      provider: engine.id,
      done: pages.length,
      total: pages.length,
      pageIndex: Math.max(0, pages.length - 1),
      stage: 'writing',
    });

    const total = this.writeTextLayer(book, engine, recognized, pages);
    return {
      bookId: book.id,
      ok: true,
      provider: engine.id,
      pages: pages.length,
      blocks: total,
    };
  }

  /**
   * 把结果合并进 `manga.json`，返回最终文字块总数。
   *
   * 合并规则：**新结果里没识别出东西的页保留原有文字层**。否则一次识别质量差的
   * 重跑会把上一次的好结果抹掉——用户点「重新识别」是想变好，不是想变没。
   */
  private writeTextLayer(
    book: BookRecord,
    engine: OcrEngine,
    recognized: readonly PageText[],
    pages: NonNullable<BookRecord['pages']>,
  ): number {
    const contentDir = bookContentDir(book.id);
    const existing = readExistingPageTexts(contentDir);

    let blocks = 0;
    const merged = pages.map((page, index) => {
      const fresh = recognized[index];
      if (fresh && fresh.blocks.length > 0) {
        blocks += fresh.blocks.length;
        return { url: page.url, width: page.width, height: page.height, blocks: fresh.blocks };
      }
      const old = existing.find((item) => item.url === page.url);
      blocks += old?.blocks.length ?? 0;
      return { url: page.url, width: page.width, height: page.height, blocks: old?.blocks ?? [] };
    });

    try {
      writeJsonAtomic(
        path.join(contentDir, 'manga.json'),
        JSON.parse(
          serializeMangaJson(merged, {
            engine: engine.id,
            engineSignature: `${engine.id}:${engine.id === 'arale_onnx_v1' ? 'v2' : 'v1'}`,
            schemaVersion: 1,
          }),
        ),
      );
      invalidateContentCache(book.id);
      this.options.onFinished?.(book.id);
    } catch (error) {
      // 写盘失败不该让用户以为识别白跑了——但必须让他知道没保存。
      throw new Error(
        `识别完成但写入文字层失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return blocks;
  }
}

// ---------------------------------------------------------------------------
// 文字层状态
// ---------------------------------------------------------------------------

function readExistingPageTexts(contentDir: string): PageText[] {
  try {
    return parseMangaJson(fs.readFileSync(path.join(contentDir, 'manga.json'), 'utf8'));
  } catch {
    return [];
  }
}

function hasTextLayer(book: BookRecord): boolean {
  return readExistingPageTexts(bookContentDir(book.id)).some((page) => page.blocks.length > 0);
}

function countBlocks(book: BookRecord): number {
  return readExistingPageTexts(bookContentDir(book.id)).reduce((sum, page) => sum + page.blocks.length, 0);
}
