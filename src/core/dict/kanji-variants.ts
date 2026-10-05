/**
 * 异体字归一化：把兼容/变体汉字折成它们的常用字形。
 *
 * ## 为什么需要（NFKC 不够）
 *
 * NFKC 会折**兼容字符**（全角字母、半角片假名、带圈数字…），但**不会**折兼容汉字：
 * `神`(U+FA19) 在 NFKC 之后仍是 `神`。于是词典里明明有「神」的词条，用户点到 `神`
 * 却查不到，看起来像「词典不全」。这类字在扫描版漫画、旧字体排版的书里很常见。
 *
 * 数据来自 Fushi 的 `kanji_standardization_data.cpp`（2122 条，源自
 * yomidevs/kanji-processor，MIT），由 `scripts/make-kanji-variants.mjs` 生成成
 * `data/kanji-variants.json`（29 KB）随包分发 —— 这是「小数据内嵌」那一类：
 * 29 KB 换来异体字能查，划算；JMdict 那 22 MB 就不划算，走扩展下载。
 *
 * ## 为什么在 `normalizeQuery` 里折，而不是在查询侧单独折一次
 *
 * `normalizeQuery` 是**索引侧与查询侧共用**的键规范形。如果只在查询侧折，索引里的键
 * 仍是变体字形，折出来的常用字形反而查不到。两边都折才等价。
 *
 * 另外这也解释了为什么**不需要重建已导入的词典**：常用字形本来就在索引里（词典收的是
 * 常用字形），我们只是把查询也折过去。
 */

import { loadVariants } from './data-source';

/** 变体码点 → 常用字形码点。 */
let table: Map<number, number> | null = null;

function load(): Map<number, number> {
  if (table !== null) return table;
  table = new Map();
  try {
    const raw = loadVariants() as Record<string, string>;
    for (const [variant, parent] of Object.entries(raw)) {
      const v = Number.parseInt(variant, 16);
      const p = Number.parseInt(parent, 16);
      if (Number.isFinite(v) && Number.isFinite(p) && v !== p) table.set(v, p);
    }
  } catch {
    // 数据文件坏了就当没有：查词照常，只是异体字查不到。
    table = new Map();
  }
  return table;
}

/** 测试用：清掉缓存（换数据文件之后要重新读）。 */
export function resetKanjiVariantsCache(): void {
  table = null;
}

/** 表里有几条（测试与状态展示用）。 */
export function kanjiVariantCount(): number {
  return load().size;
}

/**
 * 把字符串里的异体字折成常用字形。
 *
 * **只折一层**，不做传递闭包：表是「变体 → 父字形」的单层映射（源自 kanji-processor 的
 * full_list），父字形本身不会再是另一条的键。做闭包只会在表被改坏时掩盖问题。
 *
 * 用 `for...of` 而不是 `charCodeAt`：表里含 U+20000 以上的字（如 `𠂣`），
 * 用 UTF-16 码元逐位处理会把代理对拆开，折出乱码。
 */
export function foldKanjiVariants(input: string): string {
  const map = load();
  if (map.size === 0) return input;
  let out = '';
  let changed = false;
  for (const char of input) {
    const folded = map.get(char.codePointAt(0) ?? 0);
    if (folded === undefined) {
      out += char;
    } else {
      out += String.fromCodePoint(folded);
      changed = true;
    }
  }
  return changed ? out : input;
}
