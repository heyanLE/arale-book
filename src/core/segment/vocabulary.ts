/**
 * 词表汇总 —— 从「已经切好的单元」里建出去重词表。
 *
 * 为什么单独拆一个文件：词表是这个子系统里**唯一会被 UI 反复重排**的东西。
 * 用户换词典后重新生成，如果排序不稳定，两次结果看起来就不一样，会被当成「分词坏了」。
 * 去重/排序规则因此值得有独立的测试，而不是埋在 segmenter 里顺带覆盖。
 */

import type { SegmentUnit, SegmentVocabularyEntry } from '../../shared/types';

/**
 * 每个词最多保留几个表面形。
 * UI 那一栏放不下更多；产物也没必要为了「见过 300 种写法」而膨胀。
 */
const MAX_SURFACES = 8;

/**
 * 归一化：去掉首尾空白 + **只折叠 ASCII 大小写**。
 *
 * 为什么不是 `toLowerCase()`：那会把全角 `Ａ`、土耳其语 `İ` 之类也一起改掉，日语里
 * 这些字符是「原样」的一部分（和语/外来语的写法差异），改了就是把不同的词并成一个。
 * 而 ASCII 的大小写差异（`Test` / `test`）在日语文本里几乎只来自拉丁词，合并才是对的。
 */
export function normalizeTerm(value: string): string {
  return value.trim().replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/** 一个词在汇总过程中的累积状态。 */
interface Bucket {
  /** 首次出现时的辞书形（已 trim，保留原始写法，便于显示）。 */
  base: string;
  /** 出现次数（含重复）。 */
  count: number;
  /** 任一次出现过词典命中就算命中。 */
  matched: boolean;
  /** 表面形 → 出现次数。Map 的插入顺序就是「首次出现顺序」。 */
  surfaces: Map<string, number>;
}

/**
 * 汇总词表。输入是**已经切好**的单元（`tokens` 里 offsets 已夹紧），所以这里不再碰文本。
 *
 * 去重键 = `baseForm ?? surface` 归一化后的值；计数按出现次数；表面形最多留 8 个
 * （先按出现次数降序，同次数按首次出现顺序）。
 *
 * 排序必须是全序：`count` 降序 → `base` 升序（用码元比较，不用 localeCompare，
 * 后者结果依赖运行环境的 locale，会让同一份数据在两台机器上排出不同顺序）。
 */
export function buildVocabulary(units: readonly SegmentUnit[]): SegmentVocabularyEntry[] {
  const buckets = new Map<string, Bucket>();

  for (const unit of units) {
    const tokens = Array.isArray(unit?.tokens) ? unit.tokens : [];
    for (const token of tokens) {
      if (!token) continue;
      // 查不到词典时 `baseForm` 为 null，退回表面形——契约里 `base` 的语义就是这个。
      const raw = (token.baseForm ?? token.surface ?? '').trim();
      const key = normalizeTerm(raw);
      // 空的去重键既没法显示也点不开，直接跳过（坏数据不该污染词表）。
      if (key.length === 0) continue;

      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = { base: raw, count: 0, matched: false, surfaces: new Map<string, number>() };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      if (token.matched === true) bucket.matched = true;

      const surface = typeof token.surface === 'string' ? token.surface.trim() : '';
      if (surface.length > 0) {
        bucket.surfaces.set(surface, (bucket.surfaces.get(surface) ?? 0) + 1);
      }
    }
  }

  const entries: SegmentVocabularyEntry[] = [];
  for (const bucket of buckets.values()) {
    entries.push({
      base: bucket.base,
      count: bucket.count,
      surfaces: topSurfaces(bucket.surfaces),
      matched: bucket.matched,
    });
  }

  // 归一化后的键互不相同，`base` 也就互不相同，所以这个比较器天然是全序，没有并列。
  entries.sort((a, b) => b.count - a.count || compareCodeUnits(a.base, b.base));
  return entries;
}

/** 表面形排序：出现次数降序 → 首次出现顺序；再截到 MAX_SURFACES。 */
function topSurfaces(counts: Map<string, number>): string[] {
  const ordered = [...counts.entries()].map(([surface, count], order) => ({ surface, count, order }));
  ordered.sort((a, b) => b.count - a.count || a.order - b.order);
  return ordered.slice(0, MAX_SURFACES).map((item) => item.surface);
}

/** 码元序比较：结果只取决于字符串本身，与 locale/ICU 无关。 */
function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
