/**
 * OCR 引擎接口（冻结契约）。
 *
 * ## 一句话：**输入一本书，输出进度与结果**
 *
 * ```
 *   recognize(job, sink)
 *        │      │     └── 进度：某页出结果了（ok / 失败原因）、一句给人看的话
 *        │      └── 输入：这本书（页清单 + 阅读方向 + 取消信号）
 *        └── 返回：按 pages 顺序的每页**行**（`OcrLine[]`，不是文字块）
 * ```
 *
 * ## 引擎只吐「行」，不吐「块」
 *
 * 一行是「文字 + 框 + 朝向」；再往下的两件事——**阅读顺序**与**成块**——是漫画排版的知识，
 * 属于应用侧（`core/ocr/blocks.ts` 的 `blocksFromLines`）。以前这段逻辑在每个引擎里各写了
 * 一遍（连注释都在说「必须是公用的」），两份必然漂移；现在引擎完全不知道 mokuro 是什么，
 * 所以换实现（比如把 Python 换成 Rust/ONNX）以后行为一致。
 *
 * ## 接口刻意做成**书级**而不是页级
 *
 * 全程只需要一次模型加载 / 一次子进程启动；页级接口会逼着每个引擎自己解决「模型别重复
 * 加载」这个问题。
 *
 * 两个实现：
 * - `system`：操作系统自带的 OCR（macOS Vision / Windows.Media.Ocr），随应用走、零下载。
 * - `manga-anki`：下载安装的扩展（comic-text-detector + manga-ocr），质量更好但体积大。
 */

import type { BookRecord, OcrEngineStatus, OcrProviderId } from '../../shared/types';
import type { OcrLine } from '../../core/ocr/types';

/** 交给引擎的一页。 */
export interface OcrPageInput {
  /** 书目录内的相对路径（正斜杠），写回 `manga.json` 用。 */
  rel: string;
  /** 绝对路径，引擎自己去读。 */
  absPath: string;
  /** 原图像素尺寸（写回 `manga.json` 用）。 */
  width: number;
  height: number;
}

/** 输入：**一本书**。 */
export interface OcrBookJob {
  book: BookRecord;
  /** 书目录（`<library>/<bookId>/content`）。 */
  contentDir: string;
  pages: readonly OcrPageInput[];
  /** 阅读方向，决定成块时的阅读顺序。 */
  direction: 'ltr' | 'rtl';
  /** 取消检查：引擎应在每个安全点（页间）调它，返回 true 就尽快收尾。 */
  isCancelled: () => boolean;
}

/**
 * 输出：一页的结果。
 *
 * **进度与结果是同一个形状**：`sink.page()` 收到的与 `recognize()` 返回的是同一种对象，
 * 所以不会出现「进度说这页好了、结果里却没有」两套真相——引擎对同一件事只报一次。
 */
export interface OcrPageOut {
  /** 在 `job.pages` 里的下标。引擎可以乱序/分批回调，服务层按它归位。 */
  index: number;
  ok: boolean;
  /** 这一页识别到的行（失败时是空数组）。 */
  lines: OcrLine[];
  /** `ok === false` 时的原因（会出现在队列 UI 上）。 */
  error?: string;
}

/** 输出：进度出口。 */
export interface OcrSink {
  /** 一页有结果了就调一次（`ok === false` 也算「这页有结果了」）。 */
  page(page: OcrPageOut): void;
  /** 一句给人看的进展说明（「正在加载模型」「首次推理较慢」…）。 */
  message(text: string): void;
}

/** 一个 OCR 引擎。 */
export interface OcrEngine {
  readonly id: OcrProviderId;
  /** 轻量探测：不加载模型、不启进程。UI 每次打开详情页都会调。 */
  status(): Promise<OcrEngineStatus>;
  /**
   * 输入一本书 → 逐页回调进度 → 返回**按 `pages` 顺序**排列的每页结果。
   *
   * 中途取消时返回**已经完成的部分**（服务层会把它们写盘，用户重跑时不必从头来）。
   */
  recognize(job: OcrBookJob, sink: OcrSink): Promise<OcrPageOut[]>;
  dispose(): Promise<void>;
}
