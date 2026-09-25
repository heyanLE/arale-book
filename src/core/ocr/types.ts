/**
 * 漫画 OCR 的**区间类型**（冻结文件）。
 *
 * ## 这一层留下的东西，以及为什么
 *
 * OCR 的引擎实现已经改成「插件」：`system`（操作系统自带，macOS Vision / Windows.Media.Ocr）
 * 与 `manga-anki`（下载得到的扩展）。两者都是**直接给出文字 + 框**的黑盒，
 * 所以原先为 PP-OCRv5 准备的那套「裁剪 → 旋转 90° → 再识别 → 坐标换回原图」的前后处理
 * 全部删掉了。
 *
 * 留下的 [OcrBox] 是**引擎之间的公共语言**：不管文字从哪来，都先归一成
 * 「原图像素坐标 + 文本 + 置信度 + 是否竖排」，再交给
 * `reading-order.ts`（日漫从右到左的阅读顺序）与 `blocks.ts`（合成 mokuro 文字块）
 * 去处理。这样换引擎不用动排序与成块，而这两块恰好是最容易写错、也最值得测的部分。
 */

import type { Box, TextBlock } from '../../shared/types';

/** 检测出来的一个文本框（原图像素坐标，`[x1,y1,x2,y2]`，已归一到 x1<=x2、y1<=y2）。 */
export interface OcrBox {
  box: Box;
  /** 识别出的文本。 */
  text: string;
  /** 识别置信度 0..1。 */
  confidence: number;
  /**
   * 这个框是不是竖排。
   *
   * 由**引擎**尽量给出：manga-anki 的检测器会告诉我们，macOS Vision 不告诉，
   * 所以 Vision 那条路退回 [isVerticalBox] 的宽高比推断。谁更权威谁给。
   */
  vertical: boolean;
}

/**
 * 竖排判定的阈值：框高 / 框宽 超过它就当竖排。
 *
 * **1.25 不是随手取的**（Fushi `manga_ocr_pipeline.dart:56`）：检测器返回的是**轴对齐**
 * 外接矩形，倾斜的竖排会被横向拉宽。用 1.5 会把真实封面上约 1.4:1 的竖排误判成横排；
 * 1.25 既覆盖这类倾斜竖排，又让接近方形（≤1.2:1）的短句（「は？」「宮城！」）保持横排。
 *
 * 注意它与路由判据 `routesToHorizontalPath`（`width >= height`，即 1.0）**故意不同**：
 * 那个是「肯定不是一列竖排」的保守判定。
 */
const VERTICAL_ASPECT_THRESHOLD = 1.25;

/** 是否把某个框当作竖排。 */
export function isVerticalBox(box: Box): boolean {
  const width = Math.max(1, box[2] - box[0]);
  const height = Math.max(1, box[3] - box[1]);
  return height / width >= VERTICAL_ASPECT_THRESHOLD;
}
