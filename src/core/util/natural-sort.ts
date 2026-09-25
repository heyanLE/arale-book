/**
 * 自然序比较 —— 逐行移植 Fushi `manga_ocr_folder_job.dart:77-105` 的 `naturalCompare`。
 *
 * 为什么不能直接 `localeCompare(..., {numeric:true})`：那会把 `p001.jpg` 与
 * `p1.jpg` 判成相等，而漫画页序必须是**全序**（否则页序在不同平台/ICU 版本上
 * 抖动，同一卷在两台机器上页序不同）。移植版把「数值相等时位数少的在前」写死，
 * 保证稳定。
 *
 * 语义：数字段按数值比；数值相等时位数少的在前；其余按（不区分大小写的）
 * UTF-16 code unit 比；前缀关系时短的在前。
 */

function isDigit(codeUnit: number): boolean {
  return codeUnit >= 0x30 && codeUnit <= 0x39;
}

/** 去掉前导零；全零串返回空串（与 Dart `replaceFirst(RegExp('^0+'), '')` 一致）。 */
function stripLeadingZeros(value: string): string {
  let i = 0;
  while (i < value.length && value.charCodeAt(i) === 0x30) i += 1;
  return value.slice(i);
}

export function naturalCompare(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  let i = 0;
  let j = 0;
  while (i < la.length && j < lb.length) {
    const ca = la.charCodeAt(i);
    const cb = lb.charCodeAt(j);
    const da = isDigit(ca);
    const db = isDigit(cb);
    if (da && db) {
      const si = i;
      const sj = j;
      while (i < la.length && isDigit(la.charCodeAt(i))) i += 1;
      while (j < lb.length && isDigit(lb.charCodeAt(j))) j += 1;
      const na = stripLeadingZeros(la.slice(si, i));
      const nb = stripLeadingZeros(lb.slice(sj, j));
      if (na.length !== nb.length) return na.length - nb.length;
      const cmp = na < nb ? -1 : na > nb ? 1 : 0;
      if (cmp !== 0) return cmp;
      // 数值相等（如 001 vs 1）：位数少的在前，保证全序稳定。
      if (i - si !== j - sj) return i - si - (j - sj);
    } else {
      if (ca !== cb) return ca - cb;
      i += 1;
      j += 1;
    }
  }
  return la.length - i - (lb.length - j);
}

/** 给 `Array.prototype.sort` 用的比较器。 */
export function byNaturalOrder<T>(key: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => naturalCompare(key(a), key(b));
}
