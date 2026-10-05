/** Browser-safe Yomitan parsing and indexing used by Tauri workers. */
import type { DictFrequency, DictTerm, DictionaryInfo, GlossaryContent, GlossaryStructured } from '../../shared/types';
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

/** `definitionTags` / `rules` / `termTags` 是空格分隔的字符串，可能是 `''`。 */
export function splitTags(raw: unknown): string[] {
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
export function toGlossaryContent(value: unknown, depth = 0): GlossaryContent {
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

export function toNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 解析 term_bank 的一行：`[expression, reading, definitionTags, rules, score, glossary, sequence, termTags]`。
 * 返回 null 表示这一行坏了，跳过并计数（绝不让一行坏数据废掉整本词典——Yomitan 官方
 * schema 与真实词典在若干行上互相矛盾）。
 */
export function parseTermRow(row: unknown, dictionaryId: string, dictionaryTitle: string): DictTerm | null {
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
export function parseFrequencyData(data: unknown): { value: number | string; display: string | null; reading: string } | null {
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
export function parseMetaRow(row: unknown): { expression: string; mode: string; data: unknown } | null {
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

export function addDictionaryToIndex(index: TermIndex, dict: DictionaryInfo, terms: unknown[], freqRecords: unknown[]): void {
  if (!dict.enabled) return;
  index.dictionaries.push(dict);
  const addKey = (key: string, term: DictTerm): void => {
    const list = index.byKey.get(key);
    if (list) list.push(term); else index.byKey.set(key, [term]);
  };
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

    for (const record of freqRecords) {
      if (!isRecord(record) || typeof record['expression'] !== 'string') continue;
      const list = Array.isArray(record['frequencies']) ? (record['frequencies'] as DictFrequency[]) : [];
      if (list.length === 0) continue;
      const reading = typeof record['reading'] === 'string' ? record['reading'] : '';
      index.freqByTerm.set(frequencyKey(record['expression'], reading), list);
    }
}
