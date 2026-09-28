/**
 * 漫画文字的「上下文框」。
 *
 * OCR 引擎只返回文字行；这里在应用侧按几何关系把相邻行聚成气泡/旁白框。原来的
 * 单行 TextBlock 完全保留给精确点击和跨行拖选，分组只负责 hover 与点击上下文。
 */

import type { Box, TextBlock } from '../../shared/types';

export interface ComicContextGroup {
  id: number;
  /** 组内块下标，按该组自身的阅读顺序排列。 */
  indices: number[];
  box: Box;
  text: string;
  /** 每个块在 text 里的 UTF-16 起点。 */
  starts: Record<number, number>;
}

const FONT_RATIO_LIMIT = 2;
const SIDE_GAP_RATIO = 1.35;
const CONTINUATION_GAP_RATIO = 0.8;
const PRIMARY_OVERLAP_RATIO = 0.25;
const SAME_TRACK_OVERLAP_RATIO = 0.5;

function width(box: Box): number {
  return Math.max(1, box[2] - box[0]);
}

function height(box: Box): number {
  return Math.max(1, box[3] - box[1]);
}

function gap(a1: number, a2: number, b1: number, b2: number): number {
  return Math.max(a1 - b2, b1 - a2, 0);
}

function overlap(a1: number, a2: number, b1: number, b2: number): number {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

function ratioCompatible(a: TextBlock, b: TextBlock): boolean {
  const small = Math.max(1, Math.min(a.fontSize, b.fontSize));
  const large = Math.max(a.fontSize, b.fontSize);
  return large / small <= FONT_RATIO_LIMIT;
}

/** 两条 OCR 行是否很可能属于同一个气泡/旁白框。 */
function related(a: TextBlock, b: TextBlock): boolean {
  // 第三方 mokuro 的多行 block 本身就是一个区域，不参与应用侧推断。
  if (a.singleLine !== true || b.singleLine !== true) return false;
  if (a.vertical !== b.vertical || !ratioCompatible(a, b)) return false;

  const aw = width(a.box);
  const ah = height(a.box);
  const bw = width(b.box);
  const bh = height(b.box);

  if (a.vertical) {
    const sideGap = gap(a.box[0], a.box[2], b.box[0], b.box[2]);
    const yOverlap = overlap(a.box[1], a.box[3], b.box[1], b.box[3]);
    const adjacentColumns =
      sideGap <= SIDE_GAP_RATIO * Math.max(aw, bw) &&
      yOverlap / Math.min(ah, bh) >= PRIMARY_OVERLAP_RATIO;

    const xOverlap = overlap(a.box[0], a.box[2], b.box[0], b.box[2]);
    const yGap = gap(a.box[1], a.box[3], b.box[1], b.box[3]);
    const splitColumn =
      xOverlap / Math.min(aw, bw) >= SAME_TRACK_OVERLAP_RATIO &&
      yGap <= CONTINUATION_GAP_RATIO * Math.max(aw, bw);
    return adjacentColumns || splitColumn;
  }

  const sideGap = gap(a.box[1], a.box[3], b.box[1], b.box[3]);
  const xOverlap = overlap(a.box[0], a.box[2], b.box[0], b.box[2]);
  const adjacentRows =
    sideGap <= SIDE_GAP_RATIO * Math.max(ah, bh) &&
    xOverlap / Math.min(aw, bw) >= PRIMARY_OVERLAP_RATIO;

  const yOverlap = overlap(a.box[1], a.box[3], b.box[1], b.box[3]);
  const xGap = gap(a.box[0], a.box[2], b.box[0], b.box[2]);
  const splitRow =
    yOverlap / Math.min(ah, bh) >= SAME_TRACK_OVERLAP_RATIO &&
    xGap <= CONTINUATION_GAP_RATIO * Math.max(ah, bh);
  return adjacentRows || splitRow;
}

function unionBox(blocks: readonly TextBlock[], indices: readonly number[]): Box {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const index of indices) {
    const box = blocks[index]?.box;
    if (box === undefined) continue;
    left = Math.min(left, box[0]);
    top = Math.min(top, box[1]);
    right = Math.max(right, box[2]);
    bottom = Math.max(bottom, box[3]);
  }
  return Number.isFinite(left) ? [left, top, right, bottom] : [0, 0, 0, 0];
}

function orderGroup(blocks: readonly TextBlock[], indices: readonly number[]): number[] {
  const first = blocks[indices[0] ?? -1];
  if (first === undefined || indices.length < 2) return [...indices];
  return [...indices].sort((a, b) => {
    const aa = blocks[a];
    const bb = blocks[b];
    if (aa === undefined || bb === undefined) return a - b;
    if (first.vertical) {
      const ax = (aa.box[0] + aa.box[2]) / 2;
      const bx = (bb.box[0] + bb.box[2]) / 2;
      const track = Math.max(width(aa.box), width(bb.box)) * 0.5;
      return Math.abs(ax - bx) > track ? bx - ax : aa.box[1] - bb.box[1];
    }
    const ay = (aa.box[1] + aa.box[3]) / 2;
    const by = (bb.box[1] + bb.box[3]) / 2;
    const track = Math.max(height(aa.box), height(bb.box)) * 0.5;
    return Math.abs(ay - by) > track ? ay - by : aa.box[0] - bb.box[0];
  });
}

/** 当前页的单行块 → 上下文框。复杂度 O(n²)，一页通常只有几十行。 */
export function buildContextGroups(blocks: readonly TextBlock[]): ComicContextGroup[] {
  const parent = Array.from({ length: blocks.length }, (_, index) => index);
  const find = (value: number): number => {
    let root = value;
    while (parent[root] !== root) {
      parent[root] = parent[parent[root] as number] as number;
      root = parent[root] as number;
    }
    return root;
  };

  for (let a = 0; a < blocks.length; a += 1) {
    for (let b = a + 1; b < blocks.length; b += 1) {
      const aa = blocks[a];
      const bb = blocks[b];
      if (aa === undefined || bb === undefined || !related(aa, bb)) continue;
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    }
  }

  const buckets = new Map<number, number[]>();
  for (let index = 0; index < blocks.length; index += 1) {
    const root = find(index);
    const bucket = buckets.get(root);
    if (bucket === undefined) buckets.set(root, [index]);
    else bucket.push(index);
  }

  return [...buckets.values()].map((rawIndices, id) => {
    const indices = orderGroup(blocks, rawIndices);
    const starts: Record<number, number> = {};
    let text = '';
    for (const index of indices) {
      starts[index] = text.length;
      text += blocks[index]?.lines.join('') ?? '';
    }
    return { id, indices, box: unionBox(blocks, indices), text, starts };
  });
}
