/**
 * 漫画文字层的**命中与选区几何**（纯函数）。
 *
 * ## 为什么单独一个文件
 *
 * 这块在连续三轮反馈里出了三次 bug，而且**每一次的烟测都是绿的**：
 * 1. 高亮用原图绝对坐标渲染在方块内部 → 被 `overflow: hidden` 整片裁掉；
 * 2. 高亮遇到反向拖动区间（`to < from`）全部跳过 → 一个字都不高亮；
 * 3. 用 `block.lines` 当行列结构 → 竖排多列方块退化成「按 y 线性取字」，
 *    往下划会选出整句话、且词尾多出一段。
 *
 * 三次都是「DOM 在、逻辑错」或者「只在特定数据形状下错」，靠 GUI 烟测根本盖不住。
 * 抽成纯函数之后可以对**具体数据形状**逐个断言，几毫秒跑完。
 *
 * ## 坐标口径（两个方向刻意不同，别改错）
 *
 * - [charIndexAt] 收的是**原图像素**坐标（与 `TextBlock.box` 同一个坐标系）；
 * - [charRangeRects] 吐的是**相对方块左上角**的坐标，因为调用方 `.comic-text-block`
 *   自己已经用 `left: box[0]*scale` 定位好了，再给绝对坐标就会多加一次偏移。
 */

import type { TextBlock } from '../../shared/types';

/**
 * 方块的**视觉排版网格**。
 *
 * ## 为什么不直接用 `block.lines`
 *
 * `lines` 的语义**因生产者而异**，不能拿来算几何。实测同一页的数据：
 *
 * ```
 * #0 vertical=true box=52x620 lines=16 字数=16   "吾輩は猫である。名前はまだ無い。"
 * #2 vertical=false box=400x60 lines=1 字数=11   "今日はいい天気ですね。"
 * ```
 *
 * 竖排那块有 16 个 `lines`、但方块只有 52px 宽，它其实是**一列 16 个字**（mokuro 竖排
 * 按「一行一个字」写）。旧代码把「一个 lines 条目 = 一列」，于是用 x 去算字符序号
 * （52/16 ≈ 3.25px 一个字）、完全忽略 y。往下一划就变成：高亮是横跨整块宽度的碎片，
 * 而选出来的词和鼠标经过的字无关——用户看到的正是「高亮宽度是整句话、单词后面多了内容」。
 *
 * ## 所以从**方块尺寸 + 字数**反推网格
 *
 * 词字格近似正方形，边长为 s：`W ≈ 列数 × s`、`H ≈ 每列字数 × s`、`列数 × 每列字数 ≈ N`，
 * 于是 `s ≈ sqrt(W·H/N)`。这个推导只用到方块和字数，**与生产者无关**，上面两块算出来
 * 分别是「1 列 16 字」和「1 行 11 字」，都对。
 *
 * ## 但如果生产者自己知道，就别猜
 *
 * 面积推断是**给第三方数据用的兜底**。本项目自己的两个 OCR 引擎是「一个文字行/列一个
 * block」，它们会在 `singleLine` 上明确声明这件事（`buildBlocks` 统一打标，落盘为
 * `single_line`）。有声明时直接 `count = 1`：字符沿框的长边等分，映射是线性的。
 *
 * 为什么非要这个声明、而不继续用面积猜：实测 14 个真实方块里有 6 个面积法算错（竖排
 * 36×98 / 字高 30 / 5 个字：真值「2 列」，面积法得出「1 列」）。而且**倾斜**的行（漫画
 * 手写体常见，`comictextdetector` 的 `angle` 能到 -20°）会让外接矩形变高，面积法于是
 * 把一整行误判成两行——那正是「高亮和看到的字对不上」的最后一点残留。
 */
interface BlockLayout {
  vertical: boolean;
  /** 段数：横排 = 行数，竖排 = 列数。 */
  count: number;
  /** 每段最多几个字（最后一段可能更短）。 */
  perSegment: number;
}

function layoutOf(block: TextBlock): BlockLayout {
  const length = block.lines.join('').length;
  const [x1, y1, x2, y2] = block.box;
  const width = Math.max(1, x2 - x1);
  const height = Math.max(1, y2 - y1);
  if (length === 0) return { vertical: block.vertical, count: 1, perSegment: 0 };

  // 生产者已经声明「这个框里只有一段文字」：不猜。倾斜的行也走这条——外接矩形虽然比
  // 真实的行高，但字符仍然沿着长边一个个排下去，按长边等分就是最接近真相的映射。
  if (block.singleLine === true) {
    return { vertical: block.vertical, count: 1, perSegment: length };
  }

  const cell = Math.sqrt((width * height) / length);
  const raw = block.vertical ? width / cell : height / cell;
  // 段数不能超过字数（1 个字不可能占 3 列）。
  const count = Math.min(length, Math.max(1, Math.round(raw)));
  return { vertical: block.vertical, count, perSegment: Math.ceil(length / count) };
}

/** 第 `segment` 段实际有几个字（最后一段通常短于 perSegment）。 */
function segmentLength(length: number, perSegment: number, segment: number): number {
  if (perSegment <= 0) return 0;
  return Math.max(0, Math.min(perSegment, length - segment * perSegment));
}

/**
 * 点击/拖动位置 → 字符下标。
 *
 * ① 有字符级命中框（regions，Google Lens 一类生产者会给）→ 直接矩形命中，取 `utf16Start`；
 * ② 命中不到 → 取最近字符框的中心；
 * ③ 没有 regions → 按 [layoutOf] 推出的网格定位：横排先定行再定列，竖排先定列再定行。
 *
 * **拖动全程用同一套网格**，所以「往一个方向直着拖」只会命中一条行/列——这是划词能用
 * 的前提（旧版会因为几像素的横向漂移整块串过去）。
 */
export function charIndexAt(block: TextBlock, x: number, y: number): number {
  const text = block.lines.join('');
  const length = text.length;
  if (length === 0) return 0;

  const regions = block.regions;
  if (regions !== undefined && regions.length > 0) {
    for (const region of regions) {
      const [rx1, ry1, rx2, ry2] = region.box;
      if (x >= rx1 && x <= rx2 && y >= ry1 && y <= ry2) {
        return clamp(region.utf16Start, 0, length - 1);
      }
    }
    let bestStart = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const region of regions) {
      const [rx1, ry1, rx2, ry2] = region.box;
      const cx = (rx1 + rx2) / 2;
      const cy = (ry1 + ry2) / 2;
      const distance = (cx - x) * (cx - x) + (cy - y) * (cy - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestStart = region.utf16Start;
      }
    }
    if (bestStart >= 0) return clamp(bestStart, 0, length - 1);
  }

  const [left, top, right, bottom] = block.box;
  const { vertical, count, perSegment } = layoutOf(block);

  if (vertical) {
    // 竖排：第 0 列在最右，列内自上而下。
    const segWidth = Math.max(1 / count, (right - left) / count);
    const segment = clamp(Math.floor((right - x) / segWidth), 0, count - 1);
    const segLen = segmentLength(length, perSegment, segment);
    const cellHeight = Math.max(1, (bottom - top) / Math.max(1, segLen));
    const row = clamp(Math.floor((y - top) / cellHeight), 0, Math.max(0, segLen - 1));
    return clamp(segment * perSegment + row, 0, length - 1);
  }

  const segHeight = Math.max(1 / count, (bottom - top) / count);
  const segment = clamp(Math.floor((y - top) / segHeight), 0, count - 1);
  const segLen = segmentLength(length, perSegment, segment);
  const cellWidth = Math.max(1, (right - left) / Math.max(1, segLen));
  const column = clamp(Math.floor((x - left) / cellWidth), 0, Math.max(0, segLen - 1));
  return clamp(segment * perSegment + column, 0, length - 1);
}

/**
 * 字符区间 → 矩形，坐标**相对方块左上角**（不是原图坐标）。
 *
 * ⚠️ 这个「相对」非常要紧。调用方 `.comic-text-block` 自己已经用 `left: x1*scaleX` 定位到
 * 原图位置了，作为它的子元素，这里再给原图绝对坐标就会**多加一次偏移**；而方块有
 * `overflow: hidden`，多加的那部分正好被裁掉 —— 表现是「高亮 DOM 节点都在、屏幕上什么都
 * 看不到」。
 *
 * 用 [layoutOf] 的**同一套网格**，所以高亮范围和 [charIndexAt] 选出来的文字一定是同一段。
 * 每段的矩形铺满段的整宽（横排）/ 整高（竖排），看起来就是文字的底色块。
 */
export function charRangeRects(block: TextBlock, from: number, to: number): Array<[number, number, number, number]> {
  const rects: Array<[number, number, number, number]> = [];
  const length = block.lines.join('').length;
  if (length === 0) return rects;

  // 拖动是双向的：横排从右往左、竖排从左往右（下一列在左）时 `to` 会小于 `from`。
  // 不排序的话下面按区间求交会全部跳过，表现为「拖了半天一个字都没高亮」。
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);

  const [left, top, right, bottom] = block.box;
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  const { vertical, count, perSegment } = layoutOf(block);

  for (let segment = 0; segment < count; segment += 1) {
    const segStart = segment * perSegment;
    const segLen = segmentLength(length, perSegment, segment);
    if (segLen <= 0) continue;

    const start = Math.max(lo, segStart);
    const end = Math.min(hi, segStart + segLen);
    if (start >= end) continue;

    const f0 = (start - segStart) / segLen;
    const f1 = (end - segStart) / segLen;

    if (vertical) {
      const segWidth = width / count;
      const x2 = width - segment * segWidth;
      const x1 = x2 - segWidth;
      rects.push([x1, f0 * height, x2, f1 * height]);
    } else {
      const segHeight = height / count;
      const y1 = segment * segHeight;
      const y2 = y1 + segHeight;
      rects.push([f0 * width, y1, f1 * width, y2]);
    }
  }
  return rects;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * 指针位置 → **字符边界**（0..length），用于划词。
 *
 * ## 为什么划词不能用 [charIndexAt]
 *
 * [charIndexAt] 回答的是「光标下面是哪一个字」，那对**点击**是对的。但用它当划词的端点会
 * **总是多选一个字**：只要指针越过下一格的左边缘（还没到中间），那一个字就被算进来了，
 * 而用户的心理预期是「我停在两个字中间」。
 *
 * 输入框的选区规则是按**字符边界**算的：格内前半 → 边界在**这个字之前**，后半 → 在**之后**。
 * 于是「拖到某个字的一半」正好把它包含进来，「刚碰到格子的边」则不含。这就是
 * 「跟平常输入框一样」的含义。
 *
 * 返回 `0..length`（含 length = 末尾之后），所以划词直接 `[min(b0,b1), max(b0,b1))`，
 * 不需要再 `+1`——那个 `+1` 正是一次次「多一个字」的来源。
 */
export function boundaryAt(block: TextBlock, x: number, y: number): number {
  const length = block.lines.join('').length;
  if (length === 0) return 0;

  const [left, top, right, bottom] = block.box;
  const { vertical, count, perSegment } = layoutOf(block);

  if (vertical) {
    const segWidth = Math.max(1 / count, (right - left) / count);
    const segment = clamp(Math.floor((right - x) / segWidth), 0, count - 1);
    const segLen = segmentLength(length, perSegment, segment);
    if (segLen === 0) return clamp(segment * perSegment, 0, length);
    const cellHeight = Math.max(1, (bottom - top) / segLen);
    // 格内比例：< 0.5 落在这个字之前，>= 0.5 落在之后。
    const offset = (y - top) / cellHeight;
    const row = clamp(Math.floor(offset), 0, segLen);
    const half = offset - Math.floor(offset) >= 0.5 ? 1 : 0;
    return clamp(segment * perSegment + Math.min(row + half, segLen), 0, length);
  }

  const segHeight = Math.max(1 / count, (bottom - top) / count);
  const segment = clamp(Math.floor((y - top) / segHeight), 0, count - 1);
  const segLen = segmentLength(length, perSegment, segment);
  if (segLen === 0) return clamp(segment * perSegment, 0, length);
  const cellWidth = Math.max(1, (right - left) / segLen);
  const offset = (x - left) / cellWidth;
  const column = clamp(Math.floor(offset), 0, segLen);
  const half = offset - Math.floor(offset) >= 0.5 ? 1 : 0;
  return clamp(segment * perSegment + Math.min(column + half, segLen), 0, length);
}
