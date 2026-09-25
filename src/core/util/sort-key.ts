/**
 * 排序键生成。
 *
 * 为什么单独一个文件：标题排序必须与「显示标题」解耦，否则用户改一下大小写就会让
 * 书架顺序跳。生成规则是纯函数，可单测。
 */

/** CJK 统一表意文字及扩展区、假名、谚文、全角标点。 */
function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x3040 && codePoint <= 0x30ff) || // 假名
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // 扩展 A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // 基本区
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // 兼容表意
    (codePoint >= 0xac00 && codePoint <= 0xd7af) || // 谚文
    (codePoint >= 0xff00 && codePoint <= 0xffef) || // 半角/全角
    (codePoint >= 0x20000 && codePoint <= 0x2ffff) // 扩展 B+
  );
}

/** 需要从排序键里剥掉的标点/符号。保留字母、数字、CJK。 */
function isSkippable(codePoint: number): boolean {
  if (codePoint <= 0x20) return true;
  if (isCjk(codePoint)) return false;
  // 字母与数字（含组合记号）保留。
  if (/[\p{L}\p{N}\p{M}]/u.test(String.fromCodePoint(codePoint))) return false;
  return true;
}

/**
 * 生成书名排序键：小写化 → 剥标点 → 折叠空白 → 去掉开头的冠词。
 *
 * 不做音译（`は` → `ha`）——那需要假名罗马字表，属于可选增强，v1 明确不做，
 * 因为中日文书名混排时用户对「假名该排在哪」的预期并不统一。
 */
export function makeSortKey(title: string): string {
  const normalized = title.normalize('NFKC');
  let out = '';
  for (const char of normalized) {
    const cp = char.codePointAt(0);
    if (cp === undefined) continue;
    if (isSkippable(cp)) {
      if (out.length > 0 && !out.endsWith(' ')) out += ' ';
      continue;
    }
    out += char.toLowerCase();
  }
  const collapsed = out.trim().replace(/\s+/g, ' ');
  return stripLeadingArticle(collapsed) || collapsed;
}

const LEADING_ARTICLES = ['the ', 'a ', 'an ', 'der ', 'die ', 'das ', 'le ', 'la ', 'les '];

function stripLeadingArticle(value: string): string {
  for (const article of LEADING_ARTICLES) {
    if (value.startsWith(article) && value.length > article.length) {
      return value.slice(article.length);
    }
  }
  return value;
}

/** 从标题里尽力解析卷号：`第3巻`、`Vol. 3`、`v03`、`(3)`、`3巻`。 */
export function parseVolume(title: string): number | null {
  const patterns = [
    /第\s*(\d+)\s*[巻卷集冊册]/u,
    /(?:vol(?:ume)?\.?|v)\s*(\d+)(?!\d)/iu,
    /[（(]\s*(\d+)\s*[)）]\s*$/u,
    /(\d+)\s*[巻卷]/u,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(title);
    if (match?.[1]) {
      const value = Number.parseInt(match[1], 10);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}
