/**
 * 双页跨页的**配对**规则。
 *
 * 单独抽出来当一个纯函数，是因为这件事看起来只有一行 `pageIndex + 1`，实际有四个
 * 容易搞错的地方，而它们全都只在真书上才暴露：
 *
 * 1. **封面**。日漫单行本第 1 页通常就是表紙，硬把「第 1、2 页」并排显示，
 *    等于把封面和扉页拼在一起——两边都看不舒服。所以需要一个「前面几页各自单独成页」
 *    的偏移量（[SpreadOffset]）。
 * 2. **偏移不是步长**。偏移 1 时，从第 1 页往后是「1 单独 → (2,3) → (4,5)」，
 *    从单页跳一步只 +1，从跨页跳一步才 +2。拿固定步长做翻页一定会错位。
 * 3. **总页数是奇数**时最后一个跨页只有一页。
 * 4. 往回翻不能简单地 `start - 1` 再取整——`start - 1` 可能落在上一跨页的**第二页**上，
 *    必须重新跑一遍配对才知道上一跨页从哪开始。
 *
 * 于是约定：**阅读器里的 `pageIndex` 永远是一个跨页的起始页**，任何入口
 * （保存的进度、键盘、按钮、目录跳转）都先过 [spreadPlan] 归一化。
 */

/** 配对偏移的取值范围：`0..SPREAD_OFFSET_MAX`，共 5 个选项。 */
export const SPREAD_OFFSET_MAX = 4;

/**
 * 全部偏移量（0..4）。
 *
 * 导出这个数组而不是让两处 UI 各写一个 `[0,1,2,3,4]`：范围一变（比如日漫之外还想支持
 * 更大的偏移）就会漏改一处，而漏改的表现是「设置页能选 5，阅读器里没有这一项」。
 */
export const SPREAD_OFFSETS: readonly number[] = Array.from(
  { length: SPREAD_OFFSET_MAX + 1 },
  (_, index) => index,
);

/** 一个跨页：起始页下标 + 页数（1 或 2）。 */
export interface SpreadPlan {
  /** 跨页的第一页（0 基）。阅读器的 `pageIndex` 就是这个值。 */
  start: number;
  /** 跨页包含几页。**只有 1 或 2**：单页模式恒为 1，双页模式在书尾可能只剩 1。 */
  size: number;
}

/** 夹到合法范围。非数字/NaN 一律当 0，避免把整个排版算成 NaN。 */
export function clampSpreadOffset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(SPREAD_OFFSET_MAX, Math.max(0, Math.trunc(value)));
}

/**
 * `index` 落在哪一个跨页里。
 *
 * 规则：前 `offset` 页每一页单独成页；从第 `offset` 页开始两两配对。
 * `offset = 0` → `(1,2) (3,4) …`（1 基描述，下同）
 * `offset = 1` → `1 | (2,3) (4,5) …`
 * `offset = 2` → `1 2 | (3,4) (5,6) …`
 *
 * 传来的 `index` 可以是任意页（比如磁盘上存着的旧进度），不要求已经对齐。
 */
export function spreadPlan(
  index: number,
  total: number,
  offset: number,
  spread: boolean,
): SpreadPlan {
  if (total <= 0) return { start: 0, size: 0 };
  const clamped = Math.min(Math.max(0, Math.trunc(index) || 0), total - 1);
  // 单页模式：偏移无意义，一页就是一个跨页。
  if (!spread) return { start: clamped, size: 1 };

  const lead = clampSpreadOffset(offset);
  if (clamped < lead) return { start: clamped, size: 1 };

  const start = lead + Math.floor((clamped - lead) / 2) * 2;
  // 书尾落单的最后一页：只有一页可显示，不能硬凑成两页（会拿到 undefined）。
  return { start, size: Math.min(2, total - start) };
}

/**
 * 往前/往后翻一个跨页，返回目标跨页的起始下标。
 *
 * 已经在头/尾时返回**当前**跨页的起始下标（而不是越界值），调用方不必再夹一次；
 * 这也让「按到底」变成幂等的，不会出现卡在某个非对齐下标上的状态。
 */
export function stepSpread(
  index: number,
  total: number,
  offset: number,
  spread: boolean,
  forward: boolean,
): number {
  if (total <= 0) return 0;
  const { start, size } = spreadPlan(index, total, offset, spread);
  if (forward) {
    const target = start + size;
    return target >= total ? start : target;
  }
  if (start === 0) return 0;
  return spreadPlan(start - 1, total, offset, spread).start;
}

/** 一个跨页要显示的所有页下标。渲染层用它取图（`spreadPlan` 的下标数组形态）。 */
export function spreadPages(
  index: number,
  total: number,
  offset: number,
  spread: boolean,
): number[] {
  const { start, size } = spreadPlan(index, total, offset, spread);
  if (size <= 0) return [];
  const indices: number[] = [];
  for (let step = 0; step < size; step += 1) indices.push(start + step);
  return indices;
}

/**
 * 给 UI 用的选项文案：这个偏移量下，第 1 个跨页是什么。
 *
 * 放在 core 里而不是组件里，是为了让设置页和阅读器工具栏显示**同一句话**——
 * 两边各写一份文案，改了偏移语义必然漏掉一个。
 */
export function spreadOffsetLabel(offset: number): string {
  const value = clampSpreadOffset(offset);
  if (value === 0) return '第 1 页起就并排（1-2 / 3-4 …）';
  const lead = value + 1;
  return `前 ${value} 页单独，之后并排（${lead}-${lead + 1} / ${lead + 2}-${lead + 3} …）`;
}
