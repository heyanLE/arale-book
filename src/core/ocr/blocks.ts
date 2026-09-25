/**
 * 把「识别好的一行/一块」组装成 mokuro 的 `TextBlock`。
 *
 * ## 一个文字行/列 = 一个 block
 *
 * 两个引擎都是这么给的：
 * - 系统 OCR（macOS Vision / Windows WinRT）按**行**返回文字与框；
 * - manga-anki 那条管线（`scripts/ocr-bridge.py`）按 `comictextdetector` 的
 *   **行/列多边形**逐条裁切识别，一条一行。
 *
 * 所以这里给每个 block 打上 `singleLine: true` —— 这是**生产者的承诺**，几何层不必
 * 再去猜「这段文字排了几行几列」。曾经不是这样：manga-anki 那边整块识别一次当一条，
 * 于是 40 个字的方块到底是 3 列还是 4 列只能靠面积猜，猜错就表现为划词偏移。
 *
 * 刻意**不做**「把同一列的相邻行合并成一个 block」：那要判断行距、列宽与换行语义，
 * 而合并错了会让命中区变成一大块（点哪都查到整段），体验比多几个小框差得多。
 * mokuro 本身也不合并。
 */

import type { TextBlock } from '../../shared/types';
import type { OcrBox } from './types';
import { estimateFontSize } from './geometry';

function round4(value: number): number {
  const rounded = Math.round(value * 10000) / 10000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * 组装 blocks。[recognized] 必须**已经按阅读顺序排好**（`computeReadingOrder` 的输出顺序）。
 *
 * 空文本的框会被丢掉——留一个没有文字的可点区域只会让用户点到空气
 * （Fushi `manga_ocr_pipeline.dart:133` 的 `if (text.isEmpty) continue;` 是同一条规则）。
 */
export function buildBlocks(recognized: readonly OcrBox[]): TextBlock[] {
  const blocks: TextBlock[] = [];
  for (const item of recognized) {
    const text = item.text.trim();
    if (text.length === 0) continue;

    const box = item.box;
    const vertical = item.vertical;
    blocks.push({
      box: [round4(box[0]), round4(box[1]), round4(box[2]), round4(box[3])],
      vertical,
      fontSize: round4(estimateFontSize(box, vertical, text)),
      lines: [text],
      // 承诺：这个框里只有这一段文字，几何层不用猜行列（见文件头）。
      singleLine: true,
    });
  }
  return blocks;
}

/** 把识别结果里的文本按顺序拼起来（调试 / 日志 / 测试断言用）。 */
