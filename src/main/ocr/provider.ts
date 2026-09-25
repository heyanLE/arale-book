/**
 * OCR 引擎接口（冻结契约）。
 *
 * OCR 在本应用里是**完全可选**的：不跑 OCR，漫画就是纯图片，能看能翻，只是点不出词典。
 * 所以引擎层被设计成一个可替换的、按需构造的东西，而不是应用启动路径上的依赖。
 *
 * 两个实现：
 * - `system`：**操作系统自带**的 OCR。macOS 走 Vision（`VNRecognizeTextRequest`），
 *   Windows 走 `Windows.Media.Ocr`。随应用走、零下载、零额外依赖。
 *   见 `providers/system.ts`。
 * - `manga-anki`：下载安装的**扩展**，内含 mokuro 管线（comic-text-detector + manga-ocr）。
 *   质量明显更好，但体积大，所以做成可选扩展而不是随包分发。
 *   见 `providers/manga-anki.ts`。
 *
 * 接口刻意做成**书级**（`recognizeBook`）而不是页级：全程只需要一次模型加载 /
 * 一次子进程启动，而页级接口会逼着每个引擎自己解决「模型别重复加载」这个问题。
 */

import type {
  BookRecord,
  OcrEngineStatus,
  OcrProviderId,
  PageText,
  TextBlock,
} from '../../shared/types';

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

export interface OcrBookContext {
  book: BookRecord;
  /** 书目录（`<library>/<bookId>/content`）。 */
  contentDir: string;
  pages: OcrPageInput[];
  /** 阅读方向，决定文字层里块的阅读顺序。 */
  direction: 'ltr' | 'rtl';
  /** 某一页识别完了。引擎可以乱序/分批调，服务层按 index 归位。 */
  onPage: (pageIndex: number, blocks: TextBlock[]) => void;
  /** 一句给人看的进展说明（如「正在识别 3/171」）。 */
  onMessage: (message: string) => void;
  /** 取消检查：引擎应在每个安全点（页间）调它，返回 true 就尽快收尾。 */
  isCancelled: () => boolean;
}

/** 一个 OCR 引擎。 */
export interface OcrEngine {
  readonly id: OcrProviderId;
  /** 轻量探测：不加载模型、不启进程。UI 每次打开详情页都会调。 */
  status(): Promise<OcrEngineStatus>;
  /**
   * 跑完整本书。返回按 `pages` 顺序排列的每页文字层。
   *
   * 中途取消时返回**已经完成的部分**（服务层会把它们写盘，用户重跑时不必从头来）。
   */
  recognizeBook(context: OcrBookContext): Promise<PageText[]>;
  dispose(): Promise<void>;
}
