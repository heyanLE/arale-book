/**
 * 查词游标扫描 —— 逐行移植 Fushi `native/fushidicts/fushidicts_src/scan/word_scan.cpp:52`
 * 的 `scan_candidates`（头文件注释见 `word_scan.hpp`）。
 *
 * 为什么需要它：Fushi 没有形态分析器（无 MeCab/Sudachi），「分词」是词典扫描的副作用。
 * 点击位置给的不是一个词，而是一个**后缀窗口**；引擎把窗口里的每个前缀都拿去查一遍，
 * 取最长的命中。所以「点 永 也能命中 永遠」靠的就是这里产出的前缀序列。
 */

/** 扫描窗口上限（码点）。Fushi `fushidicts.dart:632` 的 defaultScanLength = 16。 */
export const DEFAULT_SCAN_LENGTH = 16;

/** 把一个字符串拆成码点数组（代理对算一个元素）。 */
export function codePoints(text: string): string[] {
  return Array.from(text);
}

/**
 * 「空格分词类字母」：用空格分词的语言的字母（拉丁/西里尔/希腊/阿拉伯/希伯来/
 * 亚美尼亚/格鲁吉亚）。刻意**不含** CJK 汉字/假名/谚文，也不含数字/标点/组合记号/
 * 无空格脚本（泰/老挝/高棉/缅甸）—— 范围外一律 false，于是在那些位置退回逐码点切分。
 * 与 C++ 的 `is_space_delimited_letter` 逐段对应。
 */
function isSpaceDelimitedLetter(c: number): boolean {
  // Latin
  if ((c >= 0x0041 && c <= 0x005a) || (c >= 0x0061 && c <= 0x007a)) return true; // A-Z a-z
  if (c === 0x00aa || c === 0x00b5 || c === 0x00ba) return true; // ª µ º
  if ((c >= 0x00c0 && c <= 0x00d6) || (c >= 0x00d8 && c <= 0x00f6) || (c >= 0x00f8 && c <= 0x02af)) {
    return true; // Latin-1 字母 + Latin Ext-A/B + IPA
  }
  if (c >= 0x1e00 && c <= 0x1eff) return true; // Latin Extended Additional
  // Greek and Coptic + Greek Extended
  if (c >= 0x0370 && c <= 0x03ff) return true;
  if (c >= 0x1f00 && c <= 0x1fff) return true;
  // Cyrillic + Cyrillic Supplement
  if (c >= 0x0400 && c <= 0x052f) return true;
  // Armenian
  if ((c >= 0x0531 && c <= 0x0556) || (c >= 0x0561 && c <= 0x0587)) return true;
  // Hebrew 字母（不含点/cantillation）
  if ((c >= 0x05d0 && c <= 0x05ea) || (c >= 0x05ef && c <= 0x05f2)) return true;
  // Arabic 字母：跳过 tatweel(0x0640)、harakat(0x064B-0x065F)、上标 alef(0x0670)、数字
  if (c >= 0x0620 && c <= 0x063f) return true;
  if (c >= 0x0641 && c <= 0x064a) return true;
  if (c === 0x066e || c === 0x066f) return true;
  if (c >= 0x0671 && c <= 0x06d3) return true;
  if (c === 0x06d5) return true;
  if ((c >= 0x06ee && c <= 0x06ef) || (c >= 0x06fa && c <= 0x06fc) || c === 0x06ff) return true;
  if (c >= 0x0750 && c <= 0x077f) return true;
  if (c >= 0x08a0 && c <= 0x08bd) return true;
  // Georgian
  if ((c >= 0x10a0 && c <= 0x10c5) || (c >= 0x10d0 && c <= 0x10fa)) return true;
  return false;
}

/** 与 C++ 的 `is_scan_whitespace` 同一张表（含 U+3000 全角空格）。 */
function isScanWhitespace(c: number): boolean {
  return (
    c === 0x20 ||
    (c >= 0x09 && c <= 0x0d) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

/**
 * 从 `text` 开头锚定，产出「由长到短」的候选前缀。
 *
 * 规则（与 C++ 一一对应）：
 * - 最长窗口 = 前 `min(scanLength, 码点数)` 个码点，然后逐个码点缩短；
 * - 切点落在两个「空格分词类字母」之间时丢弃该前缀（`hello` 不会切出 `hell`/`hel`）；
 *   CJK/假名之间不算，所以日语逐码点照旧；
 * - 以空白结尾的前缀丢弃（更短的去空白前缀已覆盖）。
 *
 * 输出天然无重复（前缀长度各不相同）。
 */
export function scanCandidates(text: string, scanLength: number = DEFAULT_SCAN_LENGTH): string[] {
  if (text.length === 0 || scanLength < 1) return [];
  const points = codePoints(text);
  const total = points.length;
  if (total === 0) return [];

  const start = Math.min(scanLength, total);
  const out: string[] = [];
  for (let i = start; i > 0; i -= 1) {
    const prev = points[i - 1]!;
    // i === total 时切点在串尾，永远合法（此时 points[i] 不存在，靠短路避免越界）。
    const boundaryOk =
      i === total ||
      !(
        isSpaceDelimitedLetter(prev.codePointAt(0)!) &&
        isSpaceDelimitedLetter(points[i]!.codePointAt(0)!)
      );
    if (boundaryOk && !isScanWhitespace(prev.codePointAt(0)!)) {
      out.push(points.slice(0, i).join(''));
    }
  }
  return out;
}
