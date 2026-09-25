/**
 * 分词服务（主进程侧）。
 *
 * 形状照抄 `main/ocr/service.ts`，因为两者是同一类东西：**可选的、可反复重跑的、
 * 后台跑的产物生成任务**。共同约定：
 * - `start()` 立刻返回，真正的活在后台跑（首次让出事件循环，见 `runJob`）；
 * - 每处理一批单元发一次进度事件，UI 自己再节流渲染；
 * - 按书去重，同一本不会同时跑两遍；
 * - 支持取消（单元之间检查一次）；
 * - **任何异常都不许穿到 IPC 边界**：统一转成 `ok:false` 的结果。
 *
 * 与 OCR 的三处不同：
 * 1. 产物写在 `<bookDir>/segments.json`，**不在 `content/` 里**——它是派生数据，
 *    不是阅读器内容，`arale://` 那条链不应该能访问到它。
 * 2. 已经生成过且没要求 `force` 时直接复用现有产物。冻结契约的 `SegmentJobResult`
 *    **没有** `skipped` 字段（那是 `OcrJobResult` 的），所以「跳过」只能表达成
 *    「`ok:true` + 现有计数 + 没有 `error`」。不能为了好看去改冻结文件。
 * 3. 没装词典也照样产出产物（`dictionaryCount: 0`）：那时注入的切词器会走空索引，
 *    对每个非空白字符产出 `matched:false` 的单码点占位——那是 `core/dict` 的行为，
 *    这里不再兜底。产物仍然有用：UI 至少能画出「哪些位置是文字」的骨架，
 *    而且用户装好词典后重新生成即可。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  BookRecord,
  BookSegments,
  SegmentJobResult,
  SegmentProgress,
  SegmentRecord,
  SegmentUnit,
  SegmentVocabularyEntry,
} from '../../shared/types';
import type { AraleEvents } from '../../shared/ipc';
import { writeJsonAtomic } from '../../core/util/atomic-json';
import {
  buildVocabulary,
  refForChapter,
  refForComicBlock,
  segmentUnits,
  type SegmentTextUnit,
} from '../../core/segment';
import { bookDir } from '../paths';
import { emitEvent } from '../events';

/** 产物文件名。派生数据，和 `content/` 平级。 */
export const SEGMENTS_FILE = 'segments.json';

/** 生成器标识：写进产物，将来换算法时用它判断「旧产物要不要重生成」。 */
export const SEGMENT_ENGINE = 'dictionary-longest-match';

/**
 * 进度节流：每 50 个单元或每 250 ms 最多发一次（谁先到算谁）。
 *
 * 一本 1500 个文字块的漫画如果按块发事件，渲染进程光反序列化就会卡；
 * 但只按时间节流，几千块的书在单次让出之前又发不出去，所以两个条件都要。
 */
const PROGRESS_UNIT_STEP = 50;
const PROGRESS_INTERVAL_MS = 250;

export interface SegmentServiceOptions {
  getBook: (bookId: string) => BookRecord | null;
  /** 词典索引（由 ipc 层注入，避免这里依赖具体实现）。 */
  dictionary: { segment: (text: string) => SegmentRecord[]; count: number; signature: string; ready: boolean };
  /** 漫画文字层来源；返回每页的 blocks。 */
  readComicText: (book: BookRecord) => Array<{ pageUrl: string; blocks: Array<{ lines: string[] }> }>;
  /** 小说章节来源；返回按 spine 顺序的 {index, href, title, plainText}。 */
  readChapters: (book: BookRecord) => Array<{ index: number; href: string; title: string; plainText: string }>;
  /** job 结束后回调（用于清缓存/广播）。 */
  onFinished?: (bookId: string) => void;
}

interface RunningJob {
  cancelled: boolean;
  finished: Promise<SegmentJobResult>;
}

export class SegmentService {
  private readonly jobs = new Map<string, RunningJob>();
  /** 成功产物的结果缓存：`status()` 要能立刻回答，不必每次重读磁盘。 */
  private readonly results = new Map<string, SegmentJobResult>();

  constructor(private readonly options: SegmentServiceOptions) {}

  /** 产物绝对路径。 */
  private fileFor(bookId: string): string {
    return path.join(bookDir(bookId), SEGMENTS_FILE);
  }

  /**
   * 这本书的分词状态。
   *
   * `null` 的语义是「没有产物」。所以：
   * - 正在跑 → 返回一个「进行中」的结果（不是 null，否则 UI 会把「正在跑」当成「没跑过」）；
   * - 内存里有成功结果 → 直接给（跑完那一刻就已经算好了）；
   * - 否则**现读磁盘**——应用重启后内存是空的，而「有没有产物」的真相在磁盘上。
   */
  status(bookId: string): SegmentJobResult | null {
    if (this.jobs.has(bookId)) {
      return { bookId, ok: false, units: 0, tokens: 0, uniqueWords: 0, error: '正在分词中…' };
    }
    const cached = this.results.get(bookId);
    if (cached !== undefined) return cached;

    const artifact = this.read(bookId);
    return artifact === null ? null : summarize(bookId, artifact);
  }

  /**
   * 同步读产物。缺失或损坏一律返回 `null`，**绝不抛**。
   *
   * 为什么损坏也当「没有」而不是报错：它是**可再生的派生数据**，坏掉的唯一正确处理
   * 就是重新生成一次。为此把 IPC handler 打崩（渲染进程看到的是整页报错）完全不划算。
   * 这里也不做 `readJson` 那种「另存为 .corrupt」——那会把文件从原地搬走，
   * 用户下次「生成」时连证据都没有了。
   */
  read(bookId: string): BookSegments | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.fileFor(bookId), 'utf8');
    } catch {
      return null; // 没生成过（或书目录已被删）——这是正常状态，不是错误
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null; // 截断/乱码：当没生成过
    }
    if (!isRecord(parsed)) return null;
    // 只校验两个数组字段：它们是产物能被消费的下限，其余标量缺了就补默认值。
    if (!Array.isArray(parsed['units']) || !Array.isArray(parsed['vocabulary'])) return null;

    return {
      bookId: typeof parsed['bookId'] === 'string' ? parsed['bookId'] : bookId,
      generatedAt: typeof parsed['generatedAt'] === 'number' ? parsed['generatedAt'] : 0,
      engine: typeof parsed['engine'] === 'string' ? parsed['engine'] : SEGMENT_ENGINE,
      dictionarySignature: typeof parsed['dictionarySignature'] === 'string' ? parsed['dictionarySignature'] : '',
      dictionaryCount: typeof parsed['dictionaryCount'] === 'number' ? parsed['dictionaryCount'] : 0,
      units: parsed['units'] as SegmentUnit[],
      vocabulary: parsed['vocabulary'] as SegmentVocabularyEntry[],
    };
  }

  /**
   * 起一个后台任务并**立刻**返回。
   *
   * 同一本书已在跑 → 返回「进行中」；没有 `force` 且已有产物 → 返回现有计数（跳过）。
   */
  start(bookId: string, options: { force?: boolean } = {}): SegmentJobResult {
    if (this.jobs.has(bookId)) {
      return { bookId, ok: false, units: 0, tokens: 0, uniqueWords: 0, error: '正在分词中…' };
    }

    const book = this.options.getBook(bookId);
    if (!book) return fail(bookId, '书不存在');

    if (options.force !== true) {
      const existing = this.read(bookId);
      // 已经生成过：把现有计数原样报回去。契约里没有 skipped 字段，所以「跳过」
      // 与「跑完」在结果上无法区分——这是有意为之：对调用方来说两者都是「现在可用」。
      if (existing !== null) return summarize(bookId, existing);
    }

    const job: RunningJob = { cancelled: false, finished: undefined as never };
    this.jobs.set(bookId, job);

    job.finished = this.runJob(book, job)
      .catch((error: unknown): SegmentJobResult => fail(bookId, errorMessage(error)))
      .then((result) => {
        this.jobs.delete(bookId);
        // 只有成功的结果才进缓存：`status()` 回答的是「有没有产物」，
        // 失败/取消不该被当成产物缓存下来（真相在磁盘上，没写盘就是没有）。
        if (result.ok) this.results.set(bookId, result);
        safeEmit('segment:done', result);
        return result;
      });

    return { bookId, ok: true, units: 0, tokens: 0, uniqueWords: 0 };
  }

  cancel(bookId: string): void {
    const job = this.jobs.get(bookId);
    if (job) job.cancelled = true;
  }

  /** 删掉产物。同时停掉正在跑的 job——否则「删了又自己回来」比删不掉更费解。 */
  clear(bookId: string): void {
    this.cancel(bookId);
    this.results.delete(bookId);
    try {
      fs.rmSync(this.fileFor(bookId), { force: true });
    } catch {
      // 删不掉（Windows 上被占用很常见）也不能抛给 IPC；对调用方来说「读不到」即可。
    }
  }

  isRunning(bookId: string): boolean {
    return this.jobs.has(bookId);
  }

  /** 等一个任务跑完（测试与「退出前收尾」用）。 */
  async wait(bookId: string): Promise<SegmentJobResult | null> {
    const job = this.jobs.get(bookId);
    if (!job) return this.results.get(bookId) ?? null;
    return job.finished;
  }

  private emit(progress: SegmentProgress): void {
    safeEmit('segment:progress', progress);
  }

  private async runJob(book: BookRecord, job: RunningJob): Promise<SegmentJobResult> {
    const bookId = book.id;
    this.emit({ bookId, done: 0, total: 0, stage: 'reading' });

    // 让出一次事件循环。`start()` 是同步返回的，如果这里一路同步跑下去，
    // 「后台任务」就只是句谎话——整个 IPC 会卡到整本书切完为止。
    await yieldToEventLoop();

    const textUnits = this.collectUnits(book);
    const total = textUnits.length;
    this.emit({ bookId, done: 0, total, stage: 'segmenting' });

    const deps = {
      // 包一层方法调用而不是直接传 `this.options.dictionary.segment`：
      // 注入方可能是个带 `this` 的类实例方法，裸传会丢绑定。
      segmentText: (text: string): SegmentRecord[] => this.options.dictionary.segment(text),
      dictionary: {
        count: this.options.dictionary.count,
        signature: this.options.dictionary.signature,
      },
      engine: SEGMENT_ENGINE,
    };

    const units: SegmentUnit[] = [];
    let tokenCount = 0;
    let lastEmitAt = Date.now();
    let lastEmitDone = 0;

    for (let index = 0; index < total; index += 1) {
      if (job.cancelled) {
        // 半成品也报出已算的部分：UI 的进度条不用跳回 0。
        return {
          bookId,
          ok: false,
          units: units.length,
          tokens: tokenCount,
          uniqueWords: buildVocabulary(units).length,
          error: '已取消',
        };
      }

      const source = textUnits[index];
      if (source === undefined) continue;

      // 逐单元复用 core 的纯逻辑（夹紧偏移、空文本、词表规则都在那边），
      // 而不是在这里重写一遍——重写就会有两份会漂移的归一化规则。
      const one = segmentUnits([source], deps);
      const produced = one.units[0];
      if (produced !== undefined) {
        units.push(produced);
        tokenCount += one.tokenCount;
      }

      const done = index + 1;
      const now = Date.now();
      if (done - lastEmitDone >= PROGRESS_UNIT_STEP || now - lastEmitAt >= PROGRESS_INTERVAL_MS) {
        this.emit({ bookId, done, total, stage: 'segmenting' });
        lastEmitDone = done;
        lastEmitAt = now;
        // 只在发进度的时候让出：这样进度事件真的能送到渲染进程，
        // `cancel()` 也才有机会插进来（纯同步循环里取消是永远收不到的）。
        await yieldToEventLoop();
      }
    }

    this.emit({ bookId, done: total, total, stage: 'writing' });

    const vocabulary = buildVocabulary(units);
    const artifact: BookSegments = {
      bookId,
      generatedAt: Date.now(),
      engine: SEGMENT_ENGINE,
      dictionarySignature: this.options.dictionary.signature,
      dictionaryCount: this.options.dictionary.count,
      units,
      vocabulary,
    };
    // 原子写：半截 JSON 会让 `read()` 只能返回 null，用户看到的是「生成成功了但读不出来」。
    writeJsonAtomic(path.join(bookDir(bookId), SEGMENTS_FILE), artifact);
    this.options.onFinished?.(bookId);

    this.emit({ bookId, done: total, total, stage: 'done' });
    return { bookId, ok: true, units: units.length, tokens: tokenCount, uniqueWords: vocabulary.length };
  }

  /** 按格式收集文本单元。两个来源都是注入的，这里只管 ref/label 的口径。 */
  private collectUnits(book: BookRecord): SegmentTextUnit[] {
    return book.format === 'comic' ? this.collectComicUnits(book) : this.collectChapterUnits(book);
  }

  /** 漫画：一个**文字块**一个单元（不是一页一个——块才是可点击的最小上下文）。 */
  private collectComicUnits(book: BookRecord): SegmentTextUnit[] {
    const pages = this.options.readComicText(book);
    const out: SegmentTextUnit[] = [];

    pages.forEach((page, pageIndex) => {
      const pageUrl = typeof page?.pageUrl === 'string' ? page.pageUrl : '';
      const blocks = Array.isArray(page?.blocks) ? page.blocks : [];
      blocks.forEach((block, blockIndex) => {
        const lines = Array.isArray(block?.lines) ? block.lines : [];
        out.push({
          // 块序号是**页内**序号，所以同一页的多个块各有各的 ref（页 url 相同也不冲突）。
          ref: refForComicBlock(pageUrl, blockIndex),
          text: lines.map((line) => (typeof line === 'string' ? line : '')).join(''),
          label: `第 ${pageIndex + 1} 页 第 ${blockIndex + 1} 块`,
        });
      });
    });

    return out;
  }

  /** 小说：一个 spine 项一个单元。 */
  private collectChapterUnits(book: BookRecord): SegmentTextUnit[] {
    // TOC 里同一 href 可能出现多次（父级目录项 + 锚点项），首个胜出：先出现的层级更高。
    const tocLabels = new Map<string, string>();
    for (const entry of book.toc ?? []) {
      const label = entry.label.trim();
      if (label.length === 0) continue;
      if (!tocLabels.has(entry.href)) tocLabels.set(entry.href, label);
    }

    return this.options.readChapters(book).map((chapter) => {
      const href = typeof chapter.href === 'string' ? chapter.href : '';
      const fromToc = tocLabels.get(href);
      const fromChapter = typeof chapter.title === 'string' ? chapter.title.trim() : '';
      return {
        ref: refForChapter(chapter.index, href),
        text: typeof chapter.plainText === 'string' ? chapter.plainText : '',
        // 标签优先级：书里的 TOC 标题 → 文本源自带的章节标题 → href 文件名。
        // 契约只要求前两者之一与「href basename」兜底，多一层中间态只是为了
        // 在 toc 缺失但来源知道标题时也别退化成文件名。
        label: fromToc ?? (fromChapter.length > 0 ? fromChapter : basename(href)),
      };
    });
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(bookId: string, error: string): SegmentJobResult {
  return { bookId, ok: false, units: 0, tokens: 0, uniqueWords: 0, error };
}

/** 由产物反推任务结果（`status` 与「跳过」两条路都要用）。 */
function summarize(bookId: string, artifact: BookSegments): SegmentJobResult {
  let tokens = 0;
  for (const unit of artifact.units) {
    if (unit && Array.isArray(unit.tokens)) tokens += unit.tokens.length;
  }
  return {
    bookId,
    ok: true,
    units: artifact.units.length,
    tokens,
    uniqueWords: artifact.vocabulary.length,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `href` 的文件名部分。章节标签的最后兜底，空 href 时原样返回。 */
function basename(href: string): string {
  const normalized = href.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const last = parts[parts.length - 1] ?? '';
  return last.length > 0 ? last : normalized;
}

/**
 * 发事件。**必须**吞异常：`emitEvent` 会走到 Electron 的 `BrowserWindow`，
 * 在没有窗口的场合（单元测试、退出过程中的收尾）它会直接抛。
 * 分词算完了却因为「广播不出去」而失败，是完全不划算的。
 */
function safeEmit<K extends keyof AraleEvents>(event: K, payload: AraleEvents[K]): void {
  try {
    emitEvent(event, payload);
  } catch {
    /* 事件是尽力而为，不是分词的前置条件 */
  }
}

/** 让出事件循环一次，给 IPC/取消/其他后台任务一个执行机会。 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
