/**
 * 划词的**跨方块**选择（纯函数，可脱离 DOM 单测）。
 *
 * ## 为什么需要这一层：一句话换行就落在两个方块里
 *
 * 文字层是「一个文字行/列 = 一个方块」（见 `core/ocr/blocks.ts`）——也就是说，横排
 * 一句话只要换行、竖排只要换列，它就在**两个** `TextBlock` 里。而拖动原本被锁死在
 * 「按下时那一个方块」上（`start.block !== block` 就 return），于是跨行/跨列根本
 * 划不动：用户在第二行松开鼠标，选中的还只是第一行。
 *
 * 这里回答三件事，全是纯函数——不碰 DOM、不碰 React，所以「跨行到底选到哪几个字」
 * 可以逐条断言，而不是靠肉眼看高亮：
 *
 * 1. [selectionRanges]：锚点与当前点之间的**所有**方块，两端各取一段、中间整段
 *    （这就是「跨矩形划词」：划过的每一个矩形都进来，而不只是首尾两个）；
 * 2. [selectionContext] / [selectionText]：拼出来的原文。方块之间**不插换行**，
 *    并且把原文里出现的 `\r\n` 一律去掉——用户要的是「连在一起的一段话」，多一个
 *    换行就会让词典查不到、词卡里也难看；
 * 3. [pickBlockAt]：指针落在哪一块上。落在方块外的空白里时按**矩形距离宽容度**
 *    吸附最近的一块——行距、列距都是空白，没有宽容度就必须精确压在字上才能继续拖。
 */

import type { Box, TextBlock } from '../../shared/types';

/** 锚点 / 当前点：方块下标 + 该方块内的字符边界。 */
export interface SelectionPoint {
  /** `PageText.blocks` 里的下标。**该数组本身就是阅读顺序**（成块时排过序）。 */
  block: number;
  /** 字符边界 `0..length`（语义见 `boundaryAt` 的注释）。 */
  boundary: number;
}

/** 一个方块里被选中的一段。 */
export interface SelectionRange {
  index: number;
  /** 起点（含），UTF-16 偏移。 */
  from: number;
  /** 终点（不含）。 */
  to: number;
}

/** 一次划词的全部结果：给 UI 的 ranges + 给查词/词卡的 context/start/end/text。 */
export interface SelectionResult {
  ranges: SelectionRange[];
  /** 跨越的方块拼起来的原文（**不含**我们插入的分隔符）。 */
  context: string;
  /** `start`/`end` 在 `context` 里的偏移。 */
  start: number;
  end: number;
  /** 选区原文：`context.slice(start, end)` 去掉换行后的结果。 */
  text: string;
}

/**
 * 矩形距离宽容度（**CSS 像素**，不是原图像素）。
 *
 * 拖动时指针难免落在方块之间的空白上（行距、列距、气泡内的留白）。没有宽容度就得
 * 精确压在字上，手一抖就断在空隙里，跨行根本拖不过去。所以：指针在方块外时，
 * 离得比这个近就吸附到最近的一块。
 *
 * 取 CSS px 而不是原图像素：手感要跟**屏幕**一致，缩放多少都是「差几个像素」的量级。
 * 24 px ≈ fit 缩放下大半行行距，够容错，又不会隔着半个气泡把人拽到隔壁去。
 */
export const SELECT_GAP_TOLERANCE_PX = 24;

/** 方块全文。与几何层（`text-geometry.ts`）同一个口径：`lines.join('')`。 */
function textOf(block: TextBlock | undefined): string {
  return block === undefined ? '' : block.lines.join('');
}

/** 换行/行分隔符。跨行拼起来的那段话不该带着它们。 */
const LINE_BREAKS = /[\r\n\u2028\u2029]+/g;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * 锚点 → 当前点之间的每个方块各选哪一段。空数组 = 没选中任何东西。
 *
 * 跨多个方块时的规则（与任何文本编辑器一致）：
 * - 首块：从锚点的边界到**块尾**；
 * - 末块：从**块首**到当前点的边界；
 * - 中间块：**整块**（这就是「跨矩形划词」——划过的矩形整块进来）。
 *
 * 反向拖动（当前点在锚点前面）与正向拖动产生**同一组区间**，只是端点互换：区间本身
 * 是按阅读顺序 lo→hi 生成的，所以「从下往上划」和「从上往下划」得到完全一样的高亮。
 */
export function selectionRanges(
  blocks: readonly TextBlock[],
  anchor: SelectionPoint,
  focus: SelectionPoint,
): SelectionRange[] {
  if (blocks.length === 0) return [];
  const anchorIndex = clampInt(anchor.block, 0, blocks.length - 1);
  const focusIndex = clampInt(focus.block, 0, blocks.length - 1);
  const lo = Math.min(anchorIndex, focusIndex);
  const hi = Math.max(anchorIndex, focusIndex);

  const ranges: SelectionRange[] = [];
  for (let index = lo; index <= hi; index += 1) {
    const length = textOf(blocks[index]).length;
    if (length === 0) continue;

    let from: number;
    let to: number;
    if (lo === hi) {
      // 同一个方块内：两个边界之间（反向拖动就是 to < from，取 min/max 即可）。
      from = Math.min(anchor.boundary, focus.boundary);
      to = Math.max(anchor.boundary, focus.boundary);
    } else if (index === lo) {
      from = lo === anchorIndex ? anchor.boundary : focus.boundary;
      to = length;
    } else if (index === hi) {
      from = 0;
      to = hi === focusIndex ? focus.boundary : anchor.boundary;
    } else {
      from = 0;
      to = length;
    }

    from = clampInt(from, 0, length);
    to = clampInt(to, 0, length);
    if (to > from) ranges.push({ index, from, to });
  }
  return ranges;
}

/**
 * ranges → 原文与它在 context 里的偏移。
 *
 * `context` 从**第一个被选中的方块的开头**开始（不是整页文本）：查词只看这一段就够了，
 * 而且偏移与用户框住的文字严格对应，不必维护「整页拼起来时第几块从第几个字符开始」。
 * 方块之间**直接拼接、不插分隔符**——日文原文换行本来就不该多一个字符，插进来只会让
 * 词典的连续匹配断掉。
 */
export function selectionContext(
  blocks: readonly TextBlock[],
  ranges: readonly SelectionRange[],
): { context: string; start: number; end: number } {
  if (ranges.length === 0) return { context: '', start: 0, end: 0 };
  const first = ranges[0]!;
  const last = ranges[ranges.length - 1]!;

  let context = '';
  let start = 0;
  let end = 0;
  for (let index = first.index; index <= last.index; index += 1) {
    const blockText = textOf(blocks[index]);
    if (index === first.index) start = context.length + first.from;
    context += blockText;
    if (index === last.index) end = context.length - (blockText.length - last.to);
  }
  return { context, start, end };
}

/**
 * 选区原文。**去掉换行符**：跨行拼起来的是「连在一起的一段话」，`\n` 会跟着进词典、
 * 进词卡、进 LLM 提示词，然后在界面上变成一个莫名其妙的空行。
 */
export function selectionText(
  blocks: readonly TextBlock[],
  ranges: readonly SelectionRange[],
): string {
  let out = '';
  for (const range of ranges) {
    out += textOf(blocks[range.index]).slice(range.from, range.to);
  }
  return out.replace(LINE_BREAKS, '');
}

/** 一步到位：锚点 + 当前点 → ranges / context / start / end / text。 */
export function buildSelection(
  blocks: readonly TextBlock[],
  anchor: SelectionPoint,
  focus: SelectionPoint,
): SelectionResult {
  const ranges = selectionRanges(blocks, anchor, focus);
  const { context, start, end } = selectionContext(blocks, ranges);
  return { ranges, context, start, end, text: selectionText(blocks, ranges) };
}

/**
 * 指针位置 → 方块下标。**没有合适的方块时返回 null**（调用方应保持上一次的落点，
 * 而不是跳到一个远处的方块上）。
 *
 * 优先「点在方块内」：都在里面时取**面积最小**的那块（重叠的粗框里，小的才是用户
 * 真正指着的那一行）。都在外面时取**矩形距离**最近的一块，且必须 ≤ `tolerance`。
 *
 * `rects` 与 `x`/`y` 同一坐标系（渲染进程里就是 client 坐标，所以宽容度天然是
 * 屏幕像素，缩放不影响手感）。
 */
export function pickBlockAt(
  rects: readonly (Box | undefined)[],
  x: number,
  y: number,
  tolerance: number = SELECT_GAP_TOLERANCE_PX,
): number | null {
  let insideIndex: number | null = null;
  let insideArea = Number.POSITIVE_INFINITY;
  let nearIndex: number | null = null;
  let nearDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index];
    if (rect === undefined) continue;
    const [left, top, right, bottom] = rect;
    const dx = Math.max(left - x, 0, x - right);
    const dy = Math.max(top - y, 0, y - bottom);
    const distance = Math.hypot(dx, dy);
    if (distance === 0) {
      const area = (right - left) * (bottom - top);
      if (area < insideArea) {
        insideArea = area;
        insideIndex = index;
      }
    } else if (distance < nearDistance) {
      nearDistance = distance;
      nearIndex = index;
    }
  }

  if (insideIndex !== null) return insideIndex;
  return nearDistance <= tolerance ? nearIndex : null;
}
