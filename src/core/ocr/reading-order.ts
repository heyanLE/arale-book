/**
 * 三级阅读顺序（面板 → 行带 → 列），日漫右起。
 *
 * ## 这个目录的分层（`src/core/ocr/`，依赖只能向下）
 *
 * ```
 * types          OcrBox 等区间类型 + 竖排推断
 * geometry       纯框代数（并集 / 重叠与间隙 / 字号估算）
 * reading-order  三级阅读顺序（本文件）——对外只导出 computeReadingOrder
 * blocks         OcrBox[] → mokuro TextBlock[]
 * ```
 *
 * **引擎实现不在 core 里**：它们在 `main/ocr/providers/`，因为要 spawn 进程、访问文件
 * 系统、读扩展目录——core 只保留能在纯 Node 里测的部分。这里也**不再有桶文件**：
 * 各个使用者直接 import 具体模块（与 `core/comic/*`、`core/cards/*` 的写法一致），
 * 免得桶里堆一堆没人用的转出口。
 */

import type { Box } from '../../shared/types';
import { boxCenterX, gapX, gapY, horizontalOverlaps, verticalOverlaps } from './geometry';

/**
 * 按谓词做 union-find 聚类，返回每簇的**原始下标**列表。
 *
 * 复杂度 O(n²)：一页的文字块通常几十个，几十的平方完全无所谓；换成 R-tree 只会
 * 让这段可读性变差。
 */
function clusterBy(count: number, related: (a: number, b: number) => boolean): number[][] {
  const parent = Array.from({ length: count }, (_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) {
      parent[root] = parent[parent[root] as number] as number;
      root = parent[root] as number;
    }
    return root;
  };

  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      if (!related(i, j)) continue;
      const ri = find(i);
      const rj = find(j);
      if (ri !== rj) parent[ri] = rj;
    }
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < count; i += 1) {
    const root = find(i);
    const bucket = clusters.get(root);
    if (bucket) bucket.push(i);
    else clusters.set(root, [i]);
  }
  return [...clusters.values()];
}

function minDimension(box: Box): number {
  return Math.min(box[2] - box[0], box[3] - box[1]);
}

/**
 * 面板聚类：两块的横/纵间距都 ≤ `gapRatio × min(两块各自的短边)` 时视为同一面板。
 *
 * 直觉：同格气泡的间距通常小于一个气泡的尺度，跨格间距更大。
 */
function clusterPanels(boxes: readonly Box[], gapRatio = 0.75): number[][] {
  return clusterBy(boxes.length, (i, j) => {
    const a = boxes[i];
    const b = boxes[j];
    if (!a || !b) return false;
    const threshold = gapRatio * Math.min(minDimension(a), minDimension(b));
    return gapX(a, b) <= threshold && gapY(a, b) <= threshold;
  });
}

/** 一组框的包围盒。 */
function panelBounds(boxes: readonly Box[], panel: readonly number[]): Box {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const index of panel) {
    const box = boxes[index];
    if (!box) continue;
    left = Math.min(left, box[0]);
    top = Math.min(top, box[1]);
    right = Math.max(right, box[2]);
    bottom = Math.max(bottom, box[3]);
  }
  if (!Number.isFinite(left)) return [0, 0, 0, 0];
  return [left, top, right, bottom];
}

/**
 * 面板内列主序：横向重叠的块聚成列，列按 `centerX` 排（RTL 时右列先），
 * 列内按 `top` 从上到下。返回**原始下标**的排列。
 */
function orderWithinPanel(
  boxes: readonly Box[],
  panel: readonly number[],
  rightToLeft = true,
): number[] {
  const localColumns = clusterBy(panel.length, (a, b) => {
    const boxA = boxes[panel[a] as number];
    const boxB = boxes[panel[b] as number];
    if (!boxA || !boxB) return false;
    return horizontalOverlaps(boxA, boxB);
  });

  const columns: number[][] = localColumns.map((column) =>
    column.map((local) => panel[local] as number),
  );

  const colCenter = (column: readonly number[]): number => {
    let sum = 0;
    let count = 0;
    for (const index of column) {
      const box = boxes[index];
      if (!box) continue;
      sum += boxCenterX(box);
      count += 1;
    }
    return count === 0 ? 0 : sum / count;
  };

  columns.sort((a, b) => (rightToLeft ? colCenter(b) - colCenter(a) : colCenter(a) - colCenter(b)));

  const order: number[] = [];
  for (const column of columns) {
    column.sort((a, b) => (boxes[a]?.[1] ?? 0) - (boxes[b]?.[1] ?? 0));
    order.push(...column);
  }
  return order;
}

export interface ReadingOrderOptions {
  /** 日漫 RTL 为 true（默认）。 */
  rightToLeft?: boolean;
  /** 面板聚类的间距比。 */
  panelGapRatio?: number;
}

/**
 * 计算整页阅读顺序：返回 `boxes` 的下标排列。
 *
 * 空输入返回 `[]`（调用方不必先判空）。
 */
export function computeReadingOrder(
  boxes: readonly Box[],
  options: ReadingOrderOptions = {},
): number[] {
  const rightToLeft = options.rightToLeft ?? true;
  const panelGapRatio = options.panelGapRatio ?? 0.75;
  if (boxes.length === 0) return [];

  const panels = clusterPanels(boxes, panelGapRatio);
  const bounds = panels.map((panel) => panelBounds(boxes, panel));

  // 面板整页流向：纵向重叠的面板归同一条「带」，带间从上到下。
  const bands = clusterBy(panels.length, (a, b) => {
    const boundA = bounds[a];
    const boundB = bounds[b];
    if (!boundA || !boundB) return false;
    return verticalOverlaps(boundA, boundB);
  });

  const bandTop = (band: readonly number[]): number => {
    let top = Infinity;
    for (const panelIndex of band) {
      const bound = bounds[panelIndex];
      if (bound) top = Math.min(top, bound[1]);
    }
    return Number.isFinite(top) ? top : 0;
  };

  bands.sort((a, b) => bandTop(a) - bandTop(b));

  const order: number[] = [];
  for (const band of bands) {
    band.sort((a, b) => {
      const boundA = bounds[a];
      const boundB = bounds[b];
      if (!boundA || !boundB) return 0;
      return rightToLeft
        ? boxCenterX(boundB) - boxCenterX(boundA)
        : boxCenterX(boundA) - boxCenterX(boundB);
    });
    for (const panelIndex of band) {
      order.push(...orderWithinPanel(boxes, panels[panelIndex] ?? [], rightToLeft));
    }
  }
  return order;
}

/**
 * 路由判据：块比它高还宽 → 走横排识别路径。
 *
 * **刻意与 `isVerticalBox`（1.25）不同**（Fushi `routing_ocr_recognizer.dart:35`）：
 * 那个是「展示上算不算竖排」的阈值，这个是「**肯定不是**一列竖排」的保守判定。
 * 1.0~1.25 之间的近方块（「は？」「宮城！」这类短句）继续按竖排处理。
 */
function routesToHorizontalPath(box: Box): boolean {
  return box[2] - box[0] >= box[3] - box[1];
}
