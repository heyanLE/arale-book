/**
 * Yomitan（= Yomichan v3）词典包的导入、落盘与索引。
 *
 * 与 Fushi 的对照：Fushi 把导入/查询全交给 C++ `native/fushidicts`（哈希表 + bloom +
 * 压缩 blob），v1 不做那套二进制格式，改成「导入时解析成 JSON，查询时全量装进内存」——
 * 桌面端词典规模（几十万词条）完全吃得下，而且少了 FFI 与 mmap 释放时序那一堆坑
 * （analysis 03 §A.4 的 BUG-1756）。
 *
 * 落盘布局（自定义，保持简单）：
 *   <dictRootDir>/<dictId>/meta.json    → DictionaryInfo（可读，供 list() 用）
 *   <dictRootDir>/<dictId>/terms.json   → DictTerm[]（紧凑 JSON）
 *   <dictRootDir>/<dictId>/freq.json    → StoredFrequency[]（紧凑 JSON）
 * 先写 terms/freq 再写 meta，meta.json 存在即代表导入完整（崩溃不会留下半本词典）。
 *
 * 不做的事（有意）：
 * - `tag_bank_*.json`（标签说明）v1 不读：UI 只展示 `definitionTags` 原文，不翻译；
 * - `kanji_bank_*.json` / 音调（pitch）数据不读：v1 只做词语查询；
 * - 媒体文件（图片/音频）不解压：查询结果里不引用媒体 URL。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { strFromU8, unzipSync } from 'fflate';

import type {
  DictFrequency,
  DictTerm,
  DictionaryInfo,
  GlossaryContent,
  GlossaryStructured,
} from '../../shared/types';
import { writeFileAtomic, writeJsonAtomic } from '../util/atomic-json';
import { byNaturalOrder } from '../util/natural-sort';
import { normalizeQuery } from './normalize';

/** ZIP 成员的一行元信息，够用就好（`isYomitanDictionary` 只认名字）。 */
export interface ZipEntry {
  name: string;
  /** 有的 zip 读取器会把「逻辑名」（剥掉 wrapper 目录后的名字）放在这里。 */
  logicalName?: string;
}

export interface YomitanImportResult {
  info: DictionaryInfo;
  termCount: number;
  freqCount: number;
}

/** 存进 freq.json 的一条记录。term_meta_bank 行本身不带读音，所以 reading 常为空串。 */
export interface StoredFrequency {
  expression: string;
  reading: string;
  frequencies: DictFrequency[];
}

/** 内存索引：查询与分词都只依赖这一个结构。 */
export interface TermIndex {
  /** key = 归一化后的词形（`normalizeQuery`），词形与读音各占一条。 */
  byKey: Map<string, DictTerm[]>;
  terms: DictTerm[];
  dictionaries: DictionaryInfo[];
  /** key = `${expression}\u0000${reading}`。 */
  freqByTerm: Map<string, DictFrequency[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// ZIP 识别
// ---------------------------------------------------------------------------

/** 按 basename 判断，容忍 `MyDict/index.json` 这种 wrapper 目录（Fushi 用 logical_name 同理）。 */
function baseName(entry: ZipEntry): string {
  const raw = entry.logicalName ?? entry.name;
  const slash = raw.lastIndexOf('/');
  return slash === -1 ? raw : raw.slice(slash + 1);
}

const TERM_BANK_RE = /^term_bank_\d+\.json$/;
const META_BANK_RE = /^term_meta_bank_\d+\.json$/;

/** Yomitan 包 = 有 index.json 且有 term_bank_*.json。 */
export function isYomitanDictionary(zip: ZipEntry[]): boolean {
  let hasIndex = false;
  let hasTermBank = false;
  for (const entry of zip) {
    const name = baseName(entry);
    if (name === 'index.json') hasIndex = true;
    else if (TERM_BANK_RE.test(name)) hasTermBank = true;
    if (hasIndex && hasTermBank) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 行解析（bank 的每一行都是数组，形状在真实词典里差异很大，全部按防御式解析）
// ---------------------------------------------------------------------------

/** `definitionTags` / `rules` / `termTags` 是空格分隔的字符串，可能是 `''`。 */
function splitTags(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
}

/**
 * 把 `glossary` 字段（任意 JSON）规整成 `GlossaryContent`。
 *
 * 真实数据里除了字符串/数组/`{tag,style,content}`，还会出现
 * `{type:'text', text}` 与 `{type:'image', path}`（Yomitan structured-content 的
 * 包装形态，类型定义里没建模），这里一并消化：text 取正文，image 丢弃（v1 不管媒体）。
 */
function toGlossaryContent(value: unknown, depth = 0): GlossaryContent {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (depth > 32) return '';
    return value.map((item) => toGlossaryContent(item, depth + 1));
  }
  if (!isRecord(value)) return '';

  if (typeof value['text'] === 'string' && value['content'] === undefined) return value['text'];
  if (typeof value['path'] === 'string' && value['content'] === undefined) return '';

  let style: Record<string, string> | undefined;
  if (isRecord(value['style'])) {
    style = {};
    for (const [key, raw] of Object.entries(value['style'])) {
      if (typeof raw === 'string' || typeof raw === 'number') style[key] = String(raw);
    }
  }
  const node: GlossaryStructured = {
    content: toGlossaryContent(value['content'], depth + 1),
  };
  if (typeof value['tag'] === 'string') node.tag = value['tag'];
  if (style !== undefined) node.style = style;
  return node;
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 解析 term_bank 的一行：`[expression, reading, definitionTags, rules, score, glossary, sequence, termTags]`。
 * 返回 null 表示这一行坏了，跳过并计数（绝不让一行坏数据废掉整本词典——Yomitan 官方
 * schema 与真实词典在若干行上互相矛盾）。
 */
function parseTermRow(row: unknown, dictionaryId: string, dictionaryTitle: string): DictTerm | null {
  if (!Array.isArray(row)) return null;
  const expression = row[0];
  if (typeof expression !== 'string' || expression.length === 0) return null;
  return {
    expression,
    reading: typeof row[1] === 'string' ? row[1] : '',
    definitionTags: splitTags(row[2]),
    rules: splitTags(row[3]),
    score: toNumber(row[4], 0),
    glossary: toGlossaryContent(row[5]),
    sequence: toNumber(row[6], 0),
    termTags: splitTags(row[7]),
    dictionaryId,
    dictionaryTitle,
  };
}

/**
 * 解析频率数据。见过的四种形状：
 * - 数字：`1234`
 * - 数字字符串：`"1234"`
 * - `{value, display}` / `{value, displayValue}`（JPDB 把真实顺位放 displayValue）
 * - `{frequency: {...}}`（套一层）
 * 全部消化；解析不出来的返回 null（跳过）。
 */
function parseFrequencyData(data: unknown): { value: number | string; display: string | null; reading: string } | null {
  if (typeof data === 'number' && Number.isFinite(data)) return { value: data, display: null, reading: '' };
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (trimmed.length === 0) return null;
    const numeric = Number(trimmed);
    return { value: Number.isFinite(numeric) ? numeric : trimmed, display: trimmed, reading: '' };
  }
  if (!isRecord(data)) return null;
  if (isRecord(data['frequency'])) return parseFrequencyData(data['frequency']);
  const display =
    typeof data['display'] === 'string'
      ? data['display']
      : typeof data['displayValue'] === 'string'
        ? data['displayValue']
        : null;
  const reading = typeof data['reading'] === 'string' ? data['reading'] : '';
  const rawValue = data['value'];
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) return { value: rawValue, display, reading };
  if (typeof rawValue === 'string') {
    const numeric = Number(rawValue);
    return { value: Number.isFinite(numeric) ? numeric : rawValue, display: display ?? rawValue, reading };
  }
  if (display !== null) return { value: display, display, reading };
  return null;
}

/** `term_meta_bank` 的一行：`[expression, mode, data]`（个别词典写成对象形式）。 */
function parseMetaRow(row: unknown): { expression: string; mode: string; data: unknown } | null {
  if (Array.isArray(row)) {
    const expression = row[0];
    const mode = row[1];
    if (typeof expression !== 'string' || expression.length === 0) return null;
    return { expression, mode: typeof mode === 'string' ? mode : '', data: row[2] };
  }
  if (isRecord(row)) {
    const expression = row['expression'];
    const mode = row['mode'];
    if (typeof expression !== 'string' || expression.length === 0) return null;
    return { expression, mode: typeof mode === 'string' ? mode : '', data: row['data'] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

const BANK_EXT_RE = /\.json$/;

/** 只解压需要的成员：媒体文件不碰（一本带图的词典解压出来可能几个 GB）。 */
function zipFilter(info: { name: string }): boolean {
  const name = info.name;
  if (!BANK_EXT_RE.test(name)) return false;
  const slash = name.lastIndexOf('/');
  const base = slash === -1 ? name : name.slice(slash + 1);
  return base === 'index.json' || TERM_BANK_RE.test(base) || META_BANK_RE.test(base);
}

/** 解析 ZIP 里的 index.json（title/format/revision），title 缺失时退回 zip 文件名。 */
function parseIndex(raw: string, zipPath: string): { title: string; format: number; revision: string } {
  const fallbackTitle = path.basename(zipPath, path.extname(zipPath));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { title: fallbackTitle, format: 3, revision: '' };
  }
  if (!isRecord(parsed)) return { title: fallbackTitle, format: 3, revision: '' };
  const title = typeof parsed['title'] === 'string' && parsed['title'].trim().length > 0 ? parsed['title'].trim() : fallbackTitle;
  const format = typeof parsed['format'] === 'number' ? parsed['format'] : 3;
  const revision = typeof parsed['revision'] === 'string' ? parsed['revision'] : '';
  if (format !== 3) {
    // 中文注释：v1 声明只吃 format 3（Yomichan v3 / Yomitan）；别的版本仍尝试导入，只警告。
    console.warn(`[dict] ${title}: index.json format=${format}（期望 3），按 v3 bank 布局尽力解析`);
  }
  return { title, format, revision };
}

/**
 * 把 zip 导入 `<dictRootDir>/<dictId>/`。
 *
 * 关于 wrapper 目录：很多 zip 的成员名是 `MyDict/term_bank_1.json`。这里以最浅的
 * `index.json` 所在目录为根，把它从成员名里剥掉，与 Fushi 用 `zip.logical_name(i)`
 * 修掉「整本词典变空」的那次 BUG 同一个思路（analysis 03 §A.5）。
 */
export async function importYomitanZip(
  zipPath: string,
  dictRootDir: string,
  dictId: string,
): Promise<YomitanImportResult> {
  const archive = unzipSync(new Uint8Array(fs.readFileSync(zipPath)), { filter: zipFilter });
  const entries = Object.keys(archive);

  // 1. 找最浅的 index.json 作为根标记。
  let rootPrefix = '';
  let indexRaw: string | null = null;
  for (const name of entries) {
    const slash = name.lastIndexOf('/');
    const base = slash === -1 ? name : name.slice(slash + 1);
    if (base !== 'index.json') continue;
    const prefix = slash === -1 ? '' : name.slice(0, slash + 1);
    if (indexRaw === null || prefix.length < rootPrefix.length) {
      indexRaw = strFromU8(archive[name]!);
      rootPrefix = prefix;
    }
  }
  if (indexRaw === null) throw new Error(`不是 Yomitan 词典：缺少 index.json（${zipPath}）`);

  const relative = (name: string): string | null =>
    rootPrefix.length === 0 ? name : name.startsWith(rootPrefix) ? name.slice(rootPrefix.length) : null;

  const termBanks: string[] = [];
  const metaBanks: string[] = [];
  for (const name of entries) {
    const rel = relative(name);
    if (rel === null || rel.includes('/')) continue;
    if (TERM_BANK_RE.test(rel)) termBanks.push(rel);
    else if (META_BANK_RE.test(rel)) metaBanks.push(rel);
  }
  /*
   * 允许**只有频率**的词典（没有 term_bank，只有 term_meta_bank）。
   *
   * 为什么会遇到：Yomitan 生态里的频率词典（JPDB Frequency、青空文庫熟語、BCCWJ…）
   * 本来就不含释义，只有一个 `term_meta_bank_*.json`。旧代码一律要求 term_bank，
   * 于是这些词典**根本装不进来**——而它们的价值恰恰是给别的词典查出来的词补频率。
   *
   * 判定条件要严：既没有 term_bank、又没有 meta_bank 的 zip 仍然不是词典
   * （普通压缩包不该被当成词典放行）。
   */
  if (termBanks.length === 0 && metaBanks.length === 0) {
    throw new Error(`不是 Yomitan 词典：缺少 term_bank_*.json（${zipPath}）`);
  }
  termBanks.sort(byNaturalOrder((name) => name));
  metaBanks.sort(byNaturalOrder((name) => name));

  const index = parseIndex(indexRaw, zipPath);
  const dictDir = path.join(dictRootDir, dictId);
  fs.mkdirSync(dictDir, { recursive: true });

  // 2. 词条。坏行跳过并计数，最后统一打印。
  const terms: DictTerm[] = [];
  let skippedTermRows = 0;
  for (const bank of termBanks) {
    const raw = strFromU8(archive[`${rootPrefix}${bank}`]!);
    let rows: unknown;
    try {
      rows = JSON.parse(raw) as unknown;
    } catch {
      skippedTermRows += 1;
      continue;
    }
    if (!Array.isArray(rows)) {
      skippedTermRows += 1;
      continue;
    }
    for (const row of rows) {
      const term = parseTermRow(row, dictId, index.title);
      if (term === null) skippedTermRows += 1;
      else terms.push(term);
    }
  }
  if (skippedTermRows > 0) {
    console.warn(`[dict] ${index.title}: 跳过 ${skippedTermRows} 行无法解析的 term_bank 数据`);
  }

  // 3. 频率（mode !== 'freq' 的 meta 数据是音调等，v1 不用）。
  const freqRecords = new Map<string, StoredFrequency>();
  let skippedFreqRows = 0;
  let freqCount = 0;
  for (const bank of metaBanks) {
    const raw = strFromU8(archive[`${rootPrefix}${bank}`]!);
    let rows: unknown;
    try {
      rows = JSON.parse(raw) as unknown;
    } catch {
      skippedFreqRows += 1;
      continue;
    }
    if (!Array.isArray(rows)) {
      skippedFreqRows += 1;
      continue;
    }
    for (const row of rows) {
      const meta = parseMetaRow(row);
      if (meta === null) {
        skippedFreqRows += 1;
        continue;
      }
      if (meta.mode !== 'freq') continue;
      const parsed = parseFrequencyData(meta.data);
      if (parsed === null) {
        skippedFreqRows += 1;
        continue;
      }
      const key = `${meta.expression}\u0000${parsed.reading}`;
      let record = freqRecords.get(key);
      if (!record) {
        record = { expression: meta.expression, reading: parsed.reading, frequencies: [] };
        freqRecords.set(key, record);
        freqCount += 1;
      }
      record.frequencies.push({ value: parsed.value, display: parsed.display, dictionary: index.title });
    }
  }
  if (skippedFreqRows > 0) {
    console.warn(`[dict] ${index.title}: 跳过 ${skippedFreqRows} 行无法解析的 term_meta_bank 数据`);
  }

  // 4. 落盘。terms/freq 用紧凑 JSON（体积敏感），meta 用可读 JSON；三者都是原子写。
  const freqList = [...freqRecords.values()];
  writeFileAtomic(path.join(dictDir, 'terms.json'), JSON.stringify(terms));
  writeFileAtomic(path.join(dictDir, 'freq.json'), JSON.stringify(freqList));

  const info: DictionaryInfo = {
    id: dictId,
    title: index.title,
    format: 'yomitan',
    termCount: terms.length,
    freqCount,
    importedAt: Date.now(),
    enabled: true,
  };
  writeJsonAtomic(path.join(dictDir, 'meta.json'), info);

  return { info, termCount: terms.length, freqCount };
}

// ---------------------------------------------------------------------------
// 索引
// ---------------------------------------------------------------------------

export function emptyTermIndex(): TermIndex {
  return {
    byKey: new Map<string, DictTerm[]>(),
    terms: [],
    dictionaries: [],
    freqByTerm: new Map<string, DictFrequency[]>(),
  };
}

export function frequencyKey(expression: string, reading: string): string {
  return `${expression}\u0000${reading}`;
}

/**
 * 读取所有**启用**词典的 terms.json / freq.json 建内存索引。
 *
 * 键：`normalizeQuery(expression)`，并在 reading 非空时**另加**一条
 * `normalizeQuery(reading)`（读音查词要能命中，对齐 `fushidicts` 的
 * `expr == expression || reading == expression`，analysis 03 §A.6）。
 * 两者归一化后相同时只留一条。
 */
export function loadTermIndex(dictRootDir: string, dicts: DictionaryInfo[]): TermIndex {
  const index = emptyTermIndex();
  const addKey = (key: string, term: DictTerm): void => {
    const list = index.byKey.get(key);
    if (list) list.push(term);
    else index.byKey.set(key, [term]);
  };

  for (const dict of dicts) {
    if (!dict.enabled) continue;
    index.dictionaries.push(dict);

    const terms = readJsonArray(path.join(dictRootDir, dict.id, 'terms.json'));
    for (const term of terms) {
      if (!isRecord(term) || typeof term['expression'] !== 'string' || term['expression'].length === 0) continue;
      const normalized: DictTerm = {
        expression: term['expression'],
        reading: typeof term['reading'] === 'string' ? term['reading'] : '',
        definitionTags: Array.isArray(term['definitionTags']) ? term['definitionTags'].map(String) : [],
        termTags: Array.isArray(term['termTags']) ? term['termTags'].map(String) : [],
        rules: Array.isArray(term['rules']) ? term['rules'].map(String) : [],
        score: toNumber(term['score'], 0),
        sequence: toNumber(term['sequence'], 0),
        glossary: toGlossaryContent(term['glossary']),
        dictionaryId: dict.id,
        dictionaryTitle: dict.title,
      };
      index.terms.push(normalized);
      const expressionKey = normalizeQuery(normalized.expression);
      if (expressionKey.length > 0) addKey(expressionKey, normalized);
      if (normalized.reading.length > 0) {
        const readingKey = normalizeQuery(normalized.reading);
        if (readingKey.length > 0 && readingKey !== expressionKey) addKey(readingKey, normalized);
      }
    }

    const freqRecords = readJsonArray(path.join(dictRootDir, dict.id, 'freq.json'));
    for (const record of freqRecords) {
      if (!isRecord(record) || typeof record['expression'] !== 'string') continue;
      const list = Array.isArray(record['frequencies']) ? (record['frequencies'] as DictFrequency[]) : [];
      if (list.length === 0) continue;
      const reading = typeof record['reading'] === 'string' ? record['reading'] : '';
      index.freqByTerm.set(frequencyKey(record['expression'], reading), list);
    }
  }
  return index;
}

/** 读一个 JSON 数组文件，坏文件/坏形状一律当空数组（跳过坏文件而不是让整本词典消失）。 */
function readJsonArray(source: string): unknown[] {
  if (!fs.existsSync(source)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(source, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 释义 HTML 渲染 + 白名单清洗
// ---------------------------------------------------------------------------

/**
 * 允许出现在释义里的标签。Yomitan 的词条 HTML 是**可信度有限**的富文本：
 * 正常用 `<a>/<span>/<div>/<ruby>/<rt>/<ul>/<table>` 这些，但不保证没有脚本。
 * `img` 不在表里（图片走结构化内容/媒体 URL，<img src=x onerror=...> 是最常见的 XSS 载荷）。
 */
const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup',
  'dd', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'kbd', 'li', 'mark', 'ol', 'p', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span',
  'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u',
  'ul', 'var', 'wbr',
]);

/** 允许保留的属性。`style` 一律丢弃（样式只由结构化内容的 style 字段生成）。 */
const ALLOWED_ATTRS = new Set(['href', 'title', 'class', 'lang', 'dir', 'colspan', 'rowspan', 'alt']);

const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const SCRIPT_BLOCK_RE = /<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;

/**
 * 转义文本，但保留本来就是实体的写法（`&nbsp;` 不会被二次转义成 `&amp;nbsp;`）。
 * Yomitan 的释义串里实体很常见，全量转义会把 `&nbsp;` 直接显示出来。
 */
function escapeFragment(text: string): string {
  return text
    .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeFragment(value).replace(/"/g, '&quot;');
}

/**
 * 解数字字符引用（`&#115;` / `&#x73;` → `s`），命名实体直接丢弃。
 * 必须先解码再判协议：`java&#115;cript:` 在浏览器里就是 `javascript:`。
 */
function decodeEntities(value: string): string {
  const toChar = (code: number): string =>
    Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_all, hex: string) => toChar(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, dec: string) => toChar(Number(dec)))
    .replace(/&[a-zA-Z][a-zA-Z0-9]*;/g, '');
}

/** 协议白名单：`javascript:` / `vbscript:` / `data:`（非图片）一律拒绝，含实体混淆与控制字符。 */
function isSafeUrl(url: string): boolean {
  const decoded = decodeEntities(url)
    .replace(/[\u0000-\u0020\u007f]/g, '')
    .toLowerCase();
  if (decoded.startsWith('javascript:') || decoded.startsWith('vbscript:')) return false;
  if (decoded.startsWith('data:') && !decoded.startsWith('data:image/')) return false;
  return true;
}

function parseAttributes(raw: string): string {
  let out = '';
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(raw)) !== null) {
    const name = match[1]!.toLowerCase();
    if (name.startsWith('on')) continue; // 事件处理器一律丢
    const isAllowed = ALLOWED_ATTRS.has(name) || name.startsWith('data-');
    if (!isAllowed) continue;
    const value = match[2] ?? match[3] ?? match[4];
    if (value === undefined) {
      out += ` ${name}`;
      continue;
    }
    if ((name === 'href') && !isSafeUrl(value)) continue;
    out += ` ${name}="${escapeAttribute(value)}"`;
  }
  return out;
}

/**
 * 释义 HTML 清洗：允许表内标签，剥掉 `on*` 事件属性与 `javascript:` 链接，
 * 其余一切（含表外标签）转义成文本。
 *
 * 注意：`<script>`/`<style>` 连同内容整体删除，而不是转义 —— 否则用户会看到
 * 一坨脚本源码。
 */
export function sanitizeGlossaryHtml(html: string): string {
  const work = html.replace(COMMENT_RE, '').replace(SCRIPT_BLOCK_RE, '');
  const out: string[] = [];
  let last = 0;
  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(work)) !== null) {
    out.push(escapeFragment(work.slice(last, match.index)));
    last = match.index + match[0].length;
    const raw = match[0];
    const name = match[1]!.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) {
      out.push(escapeFragment(raw));
      continue;
    }
    if (raw.startsWith('</')) {
      out.push(`</${name}>`);
      continue;
    }
    out.push(`<${name}${parseAttributes(match[2] ?? '')}>`);
  }
  out.push(escapeFragment(work.slice(last)));
  return out.join('');
}

/** camelCase / snake_case 的 style 键 → kebab-case（对齐 Fushi `getStyle` 的 ReCase.paramCase）。 */
function styleKeyToCss(key: string): string {
  return key.replace(/_/g, '-').replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

/** 结构化内容的 style → ` style="..."`；值里带 url()/expression()/javascript: 的直接丢。 */
function renderStyleAttribute(style: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, rawValue] of Object.entries(style)) {
    if (typeof rawValue !== 'string') continue;
    const cssKey = styleKeyToCss(key);
    if (!/^[a-zA-Z-]+$/.test(cssKey)) continue;
    const clean = rawValue.replace(/[\u0000-\u001f\u007f]/g, '');
    if (/url\s*\(|expression\s*\(|javascript:/i.test(clean)) continue;
    parts.push(`${cssKey}: ${clean}`);
  }
  if (parts.length === 0) return '';
  return ` style="${escapeAttribute(parts.join('; '))}"`;
}

/**
 * 把 `GlossaryContent` 渲染成安全 HTML：
 * - 字符串 → 走 `sanitizeGlossaryHtml`（保留词典自带的富文本）；
 * - 数组 → 依次渲染并连接；
 * - `{tag, style, content}` → `<tag style="...">inner</tag>`；tag 不在白名单里就只渲染子内容。
 */
export function renderGlossaryHtml(content: GlossaryContent): string {
  if (typeof content === 'string') return sanitizeGlossaryHtml(content);
  if (Array.isArray(content)) return content.map((item) => renderGlossaryHtml(item)).join('');

  const node = content as unknown as Record<string, unknown>;
  if (typeof node['text'] === 'string' && node['content'] === undefined) return sanitizeGlossaryHtml(node['text']);
  if (typeof node['path'] === 'string' && node['content'] === undefined) return '';

  const inner = renderGlossaryHtml(toGlossaryContent(node['content']));
  const tag = typeof node['tag'] === 'string' ? node['tag'].toLowerCase() : '';
  if (tag.length === 0 || !ALLOWED_TAGS.has(tag)) return inner;
  const style = isRecord(node['style']) ? renderStyleAttribute(node['style']) : '';
  return `<${tag}${style}>${inner}</${tag}>`;
}
