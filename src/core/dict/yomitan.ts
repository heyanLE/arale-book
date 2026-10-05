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
  DictTerm,
  DictionaryInfo,
} from '../../shared/types';
import { writeFileAtomic, writeJsonAtomic } from '../util/atomic-json';
import { byNaturalOrder } from '../util/natural-sort';

import { parseTermRow, parseMetaRow, parseFrequencyData, emptyTermIndex, addDictionaryToIndex, type StoredFrequency, type TermIndex, type ZipEntry, type YomitanImportResult } from './model';
export { emptyTermIndex, frequencyKey, type TermIndex, type ZipEntry, type YomitanImportResult, type StoredFrequency } from './model';

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

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

export function loadTermIndex(dictRootDir: string, dicts: DictionaryInfo[]): TermIndex {
  const index = emptyTermIndex();
  for (const dict of dicts) {
    if (!dict.enabled) continue;
    addDictionaryToIndex(index, dict,
      readJsonArray(path.join(dictRootDir, dict.id, 'terms.json')),
      readJsonArray(path.join(dictRootDir, dict.id, 'freq.json')));
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

export { sanitizeGlossaryHtml, renderGlossaryHtml } from './glossary';
