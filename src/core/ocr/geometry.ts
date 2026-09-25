/**
 * OCR 用到的**框代数**（纯函数，可单测）。
 *
 * 这里只有「对 `Box` 做运算」的函数：夹取、缩放、并集、重叠与间隙、字号估算。
 * **没有位图操作**——裁剪、旋转、PNG 编码曾经在这里，服务的是「把竖排裁剪块转成横排
 * 再喂给只在横排上训练过的识别器」那条路（PP-OCRv5）。那个引擎已经删掉了：
 * 现在两个引擎（系统 OCR / manga-anki）都**直接给出文字与框**，不需要我们自己做
 * 图像预处理。留着那套代码只会让人以为还有人在用。
 *
 * 阅读顺序（`reading-order.ts`）与成块（`blocks.ts`）仍然需要这些框运算，所以它们留着。
 */

import type { Box } from '../../shared/types';




/** 两个框在 x 轴上是否重叠（重叠长度为 0 也算不重叠）。 */
export function horizontalOverlaps(a: Box, b: Box): boolean {
  return Math.min(a[2], b[2]) > Math.max(a[0], b[0]);
}

/** 两个框在 y 轴上是否重叠。 */
export function verticalOverlaps(a: Box, b: Box): boolean {
  return Math.min(a[3], b[3]) > Math.max(a[1], b[1]);
}

/** 两框在 x 轴上的间隙（相交为 0）。 */
export function gapX(a: Box, b: Box): number {
  return Math.max(0, Math.max(a[0], b[0]) - Math.min(a[2], b[2]));
}

/** 两框在 y 轴上的间隙（相交为 0）。 */
export function gapY(a: Box, b: Box): number {
  return Math.max(0, Math.max(a[1], b[1]) - Math.min(a[3], b[3]));
}

export function boxCenterX(box: Box): number {
  return (box[0] + box[2]) / 2;
}

function boxWidth(box: Box): number {
  return Math.max(0, box[2] - box[0]);
}

function boxHeight(box: Box): number {
  return Math.max(0, box[3] - box[1]);
}

/** 文本的字符数（按码点算，代理对算一个）。 */
function characterCount(text: string): number {
  return Array.from(text).length;
}

/**
 * 估算字号（原图像素）。
 *
 * 两个引擎都不给字号（macOS Vision 只给框和文本，manga-anki 的 mokuro 也不给），只能估：
 * - **竖排**：一个字占一行的 `height / 字数`，同时不超过框宽；
 * - **横排**：框高就是一个行高，直接当字号。
 *
 * 这个值目前只写进 `manga.json` 作参考——阅读器的文字层几何是按 box 算的，
 * 不依赖 `fontSize`。将来接入会吐字号的检测器，直接用它的值覆盖即可。
 */
export function estimateFontSize(box: Box, vertical: boolean, text: string): number {
  const width = Math.max(1, boxWidth(box));
  const height = Math.max(1, boxHeight(box));
  if (!vertical) return Math.max(1, height);
  const count = Math.max(1, characterCount(text));
  return Math.max(1, Math.min(width, height / count));
}
