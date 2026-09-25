/**
 * 查询与分词 —— 贪心最长匹配。
 *
 * 关键前提（analysis 03 §B.1）：**Fushi 没有形态分析器**，没有 MeCab/Sudachi/kuromoji。
 * 「分词」不是语言学切分，而是「拿词典扫描窗口能命中的最长词」这一事实的副作用：
 * 词典里没有的词就不可能被切成一个 token。这里不发明统计分词器，只把同一件事重写一遍
 * （Fushi 侧见 `japanese_language.dart:73` 的 `textToWords` 与 `word_scan.cpp:52`）。
 */

import type {
  DeinflectionStep,
  DictFrequency,
  DictTerm,
  LookupResult,
  LookupTermResult,
  SegmentToken,
} from '../../shared/types';
import { deinflect } from './deinflect';
import { normalizeQuery } from './normalize';
import { DEFAULT_SCAN_LENGTH, codePoints, scanCandidates } from './scanner';
import { frequencyKey, type TermIndex } from './yomitan';

export interface LookupOptions {
  /** 返回的词条上限，默认 16（= Fushi 的 defaultMaxResults）。 */
  maxResults?: number;
  /** 扫描窗口（码点），默认 16（= Fushi 的 defaultScanLength）。 */
  scanLength?: number;
  /** 是否做变形还原，默认 true。 */
  deinflect?: boolean;
}

/** Fushi `fushidicts.dart:631` 的 defaultMaxResults。 */
export const DEFAULT_MAX_RESULTS = 16;

/** 从点击位置往回退的 UTF-16 偏移上限：点中词中间也能命中整个词。 */
const MAX_BACKTRACK = 4;

interface Resolved {
  /** 命中的辞书形（词典里的 expression）。 */
  baseForm: string;
  trace: DeinflectionStep[];
}

// ---------------------------------------------------------------------------
// 解析（带缓存：分词会在每个偏移上重复问同样几个串）
// ---------------------------------------------------------------------------

const resolveCache = new WeakMap<TermIndex, Map<string, Resolved | null>>();
const RESOLVE_CACHE_LIMIT = 8192;

/** 键必须与 `loadTermIndex` 的建索引方式完全一致，否则查询命中不到。 */
function directTerms(index: TermIndex, text: string): DictTerm[] {
  const key = normalizeQuery(text);
  if (key.length === 0) return [];
  return index.byKey.get(key) ?? [];
}

/** 直接命中优先；否则在变形候选里挑「步数最少」的那个。 */
function resolveOne(text: string, index: TermIndex, allowDeinflect: boolean): Resolved | null {
  let cache = resolveCache.get(index);
  if (!cache) {
    cache = new Map<string, Resolved | null>();
    resolveCache.set(index, cache);
  }
  const cacheKey = `${allowDeinflect ? 'd' : '-'}\u0000${text}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  let outcome: Resolved | null = null;
  const direct = directTerms(index, text);
  if (direct.length > 0) {
    outcome = { baseForm: direct[0]!.expression, trace: [] };
  } else if (allowDeinflect) {
    // deinflect 的输出按 text 排序；只在「严格更少步数」时替换，
    // 于是同一步数下先出现的文本胜出 —— 排序稳定、可复现。
    for (const candidate of deinflect(text)) {
      if (candidate.trace.length === 0) continue; // 原词上面已经查过
      const terms = directTerms(index, candidate.text);
      if (terms.length === 0) continue;
      if (outcome === null || candidate.trace.length < outcome.trace.length) {
        outcome = { baseForm: terms[0]!.expression, trace: candidate.trace };
      }
    }
  }

  if (cache.size >= RESOLVE_CACHE_LIMIT) cache.clear();
  cache.set(cacheKey, outcome);
  return outcome;
}

// ---------------------------------------------------------------------------
// 频率排序键
// ---------------------------------------------------------------------------

/** `display` 的前导数字（JPDB 这类词典把真实顺位放在 display/displayValue 里）。 */
function leadingRank(text: string): number | null {
  const match = /^\s*(\d+)/.exec(text);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** 移植 Fushi `frequency_rank.dart:28`：display 前导数字优先，其次 value；非正数视为缺失。 */
function frequencyRank(frequency: DictFrequency): number {
  if (typeof frequency.display === 'string') {
    const fromDisplay = leadingRank(frequency.display);
    if (fromDisplay !== null) return fromDisplay;
  }
  if (typeof frequency.value === 'number') {
    return Number.isFinite(frequency.value) && frequency.value > 0 ? frequency.value : Number.POSITIVE_INFINITY;
  }
  const fromValue = leadingRank(frequency.value);
  return fromValue === null ? Number.POSITIVE_INFINITY : fromValue;
}

/** 同一词条跨词典/跨读音取最小顺位（Fushi `dictionaryFrequencyRank`）。 */
function bestFrequencyRank(frequencies: readonly DictFrequency[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const frequency of frequencies) best = Math.min(best, frequencyRank(frequency));
  return best;
}

/** 取一个词条的全部频率数据：先精确 (expression, reading)，再退回 (expression, '')。 */
function frequenciesFor(term: DictTerm, index: TermIndex): DictFrequency[] {
  const out: DictFrequency[] = [];
  const seen = new Set<string>();
  const push = (list: DictFrequency[] | undefined): void => {
    for (const frequency of list ?? []) {
      const key = `${frequency.dictionary}\u0000${String(frequency.value)}\u0000${frequency.display ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(frequency);
    }
  };
  push(index.freqByTerm.get(frequencyKey(term.expression, term.reading)));
  if (term.reading.length > 0) push(index.freqByTerm.get(frequencyKey(term.expression, '')));
  return out;
}

// ---------------------------------------------------------------------------
// 分词
// ---------------------------------------------------------------------------

/** 词内字符例外：撇号与连字符不当作标点跳过（`don't` / `well-known` 不该被切断）。 */
const WORD_INTERNAL = new Set(["'", '\u2019', '-', '\u2010', '\u2011', '\u30fc']);

function isSkipChar(char: string): boolean {
  if (/\s/.test(char)) return true;
  if (WORD_INTERNAL.has(char)) return false;
  return /[\p{P}\p{S}]/u.test(char);
}

/**
 * 贪心最长匹配分词。空白与标点不产出 token（但仍前进），词典查不到的位置产出
 * 单码点 `matched:false` 占位 token —— 这样 UI 永远能完整铺满原文。
 *
 * @param options 只用到 scanLength / deinflect（maxResults 对分词无意义）。
 */
export function segment(text: string, index: TermIndex, options: LookupOptions = {}): SegmentToken[] {
  const allowDeinflect = options.deinflect !== false;
  const scanLength = options.scanLength ?? DEFAULT_SCAN_LENGTH;
  const tokens: SegmentToken[] = [];
  if (text.length === 0) return tokens;

  const points = codePoints(text);
  let pointIndex = 0;
  let offset = 0;
  while (pointIndex < points.length) {
    const point = points[pointIndex]!;
    if (isSkipChar(point)) {
      offset += point.length;
      pointIndex += 1;
      continue;
    }
    let matched = false;
    for (const candidate of scanCandidates(text.slice(offset), scanLength)) {
      const resolved = resolveOne(candidate, index, allowDeinflect);
      if (resolved === null) continue;
      tokens.push({
        surface: candidate,
        start: offset,
        end: offset + candidate.length,
        matched: true,
        baseForm: resolved.baseForm,
      });
      offset += candidate.length;
      pointIndex += codePoints(candidate).length;
      matched = true;
      break;
    }
    if (!matched) {
      tokens.push({ surface: point, start: offset, end: offset + point.length, matched: false, baseForm: null });
      offset += point.length;
      pointIndex += 1;
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

function emptyLookupResult(text: string): LookupResult {
  return { query: text, term: '', results: [], tokens: [], dictionaryCount: 0 };
}

/** 收集一个命中窗口的全部词条：直接命中 + 变形还原命中，按 (expression, reading, dictId) 去重。 */
function collectResults(matched: string, index: TermIndex, allowDeinflect: boolean): LookupTermResult[] {
  const byKey = new Map<string, LookupTermResult>();
  const add = (term: DictTerm, trace: DeinflectionStep[]): void => {
    const key = `${term.expression}\u0000${term.reading}\u0000${term.dictionaryId}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, { term, matched, deinflection: trace, frequencies: frequenciesFor(term, index) });
      return;
    }
    // 直接命中（空轨迹）永远赢；其余取轨迹最短的。
    if (trace.length < existing.deinflection.length) existing.deinflection = trace;
  };

  for (const term of directTerms(index, matched)) add(term, []);
  if (allowDeinflect) {
    for (const candidate of deinflect(matched)) {
      if (candidate.trace.length === 0) continue;
      for (const term of directTerms(index, candidate.text)) add(term, candidate.trace);
    }
  }
  return [...byKey.values()];
}

/**
 * 结果排序。**必须**是确定性的全序：弹窗在同一个词上会查好几次
 * （悬停 → 点击 → 重绘），顺序抖一下用户就会看到列表自己重排。
 * 顺序：有频率数据的在前（顺位升序 = 越常用越前）→ score 降序 → 辞书形长度降序 →
 * 辞书形 → 读音 → 词典 id。
 */
function compareResults(a: LookupTermResult, b: LookupTermResult): number {
  const rankA = bestFrequencyRank(a.frequencies);
  const rankB = bestFrequencyRank(b.frequencies);
  if (rankA !== rankB) return rankA - rankB;
  if (a.term.score !== b.term.score) return b.term.score - a.term.score;
  const lengthA = codePoints(a.term.expression).length;
  const lengthB = codePoints(b.term.expression).length;
  if (lengthA !== lengthB) return lengthB - lengthA;
  if (a.term.expression !== b.term.expression) return a.term.expression < b.term.expression ? -1 : 1;
  if (a.term.reading !== b.term.reading) return a.term.reading < b.term.reading ? -1 : 1;
  if (a.term.dictionaryId !== b.term.dictionaryId) return a.term.dictionaryId < b.term.dictionaryId ? -1 : 1;
  return 0;
}

function sortResults(results: LookupTermResult[]): LookupTermResult[] {
  return results.sort(compareResults);
}

/**
 * 点击位置 → 查询结果。
 *
 * `charOffset` 是 **UTF-16 偏移**（与 DOM `Range.startOffset` 同域，types.ts 的约定）。
 * 先在 `charOffset` 处扫描，取最长的命中候选；一个都没命中就依次回退 1..4 个偏移
 * （点中词中间很常见，回到词首才有最长匹配）。
 */
export function lookup(
  text: string,
  charOffset: number,
  index: TermIndex,
  options: LookupOptions = {},
): LookupResult {
  const requestedMax = options.maxResults;
  const maxResults =
    typeof requestedMax === 'number' && Number.isFinite(requestedMax)
      ? Math.max(1, Math.floor(requestedMax))
      : DEFAULT_MAX_RESULTS;
  const scanLength = options.scanLength ?? DEFAULT_SCAN_LENGTH;
  const allowDeinflect = options.deinflect !== false;

  if (index.dictionaries.length === 0) return emptyLookupResult(text);

  const rawOffset = Number.isFinite(charOffset) ? Math.floor(charOffset) : 0;
  const start = Math.min(Math.max(0, rawOffset), text.length);

  let matched = '';
  let resolved: Resolved | null = null;
  const earliest = Math.max(0, start - MAX_BACKTRACK);
  for (let offset = start; offset >= earliest && resolved === null; offset -= 1) {
    const rest = text.slice(offset);
    if (rest.length === 0) continue;
    for (const candidate of scanCandidates(rest, scanLength)) {
      const attempt = resolveOne(candidate, index, allowDeinflect);
      if (attempt === null) continue;
      matched = candidate;
      resolved = attempt;
      break;
    }
  }

  const tokens = segment(text, index, options);
  if (resolved === null) {
    return {
      query: text,
      term: '',
      results: [],
      tokens,
      dictionaryCount: index.dictionaries.length,
    };
  }

  const results = sortResults(collectResults(matched, index, allowDeinflect)).slice(0, maxResults);
  return {
    query: text,
    term: matched,
    results,
    tokens,
    dictionaryCount: index.dictionaries.length,
  };
}
