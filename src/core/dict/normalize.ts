/**
 * 文本归一化 —— 与 Fushi `text_processor.cpp` 的日语预处理链同口径。
 *
 * 为什么必须先做 NFKC：全角 `ＡＢＣ`、半角片假名 `ｶﾀｶﾅ`、`ｶﾞ` 这类兼容字符只有经过
 * NFKC 才会变成词条里真正写的 `ABC` / `カタカナ` / `ガ`。Yomitan 的 `TextProcessor`
 * 第一步同样是 NFKC，Fushi 的日语链第一项也是 NFKC（text_processor.cpp:448），
 * 所以这里三边一致。
 */

import { foldKanjiVariants } from './kanji-variants';

/** 变体选择符（variation selector）：NFKC **不会**去掉它们，必须手工剥。 */
const VARIATION_SELECTORS = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;

/** 空白折叠：`\s` 覆盖 U+3000 / U+00A0 / U+2028 等，NFKC 已把 U+3000 变成空格。 */
const WHITESPACE_RUN = /\s+/g;

/**
 * 通用归一化：NFKC → 去变体选择符 → 空白折叠成单个空格 → trim。
 *
 * 不做大小写折叠、不折叠假名：这两件事只属于「查询键」语义（见 `normalizeQuery`），
 * 通用归一化会被用来显示与切分，改了会改变用户看到的文本。
 */
export function normalizeText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(VARIATION_SELECTORS, '')
    .replace(WHITESPACE_RUN, ' ')
    .trim();
}

/**
 * 片假名 → 平假名。只搬 0x30A1..0x30F6（对应 0x3041..0x3096），
 * `ー`(0x30FC)、`・`(0x30FB)、`ヷ`(0x30F7) 等一律不动 —— 与 Fushi
 * `text_processor` 的 katakana→hiragana 处理器同样是「仅字母区」，
 * 搬 `ー` 会把 `コーヒー` 变成 `こおひい` 这种错词。
 */
export function toHiragana(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    out += code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : input[i]!;
  }
  return out;
}

/**
 * 词典键的规范化形式（索引侧与查询侧**共用**，必须一致）。
 *
 * 比 `normalizeText` 多三件事：
 * - **异体字折叠**（`神` → `神`）；
 * - 片假名折叠成平假名；
 * - 拉丁字母小写化。
 *
 * 异体字必须在**这一层**折：它是两侧共用的键规范形，只在查询侧折的话，索引里的键
 * 仍是变体字形，折出来的常用字形反倒查不到。放在 NFKC 之前还是之后都行
 * （NFKC 不动兼容汉字），放在前面少一次全串扫描。
 *
 * 为什么把 Yomitan 的「文本变体扇出」压成一次规范化：Fushi 的 text_processor 会为
 * 一个查询生成多种变体（NFKC、katakana→hiragana、lowercase…）再逐个查表；v1 没有
 * 变体扇出，于是把「变体」变成键的**规范形**，两侧都折叠，等价且少一次乘法。
 * 代价：`スシ` 与 `すし` 在索引里合并成同一条键，这是刻意的（日文里二者同词）。
 */
export function normalizeQuery(input: string): string {
  return toHiragana(normalizeText(foldKanjiVariants(input))).toLowerCase();
}

/** 单个字符是否算「日文」：假名（含半角片假名）、汉字、々、 prolonged sound mark。 */
const JAPANESE_CHAR = /[\u3005\u3041-\u309f\u30a1-\u30fa\u30fc-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9d]/;

/**
 * 是否「基本上是日文」：非空白字符里 kana/kanji 占比 >= 30%。
 *
 * 用 30% 而不是 100%，因为真实语料里混着阿拉伯数字、拉丁专名与标点；
 * 用 30% 而不是 10%，因为英文句子里偶尔夹一个汉字（引用）不该被当成日文去做逐码点切分。
 * 全空白 / 空串返回 false（没有东西可判）。
 */
export function isJapaneseText(input: string): boolean {
  let total = 0;
  let japanese = 0;
  for (const char of input) {
    if (/\s/.test(char)) continue;
    total += 1;
    if (JAPANESE_CHAR.test(char)) japanese += 1;
  }
  if (total === 0) return false;
  return japanese / total >= 0.3;
}
