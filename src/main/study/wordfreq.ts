/** 包内日语 Zipf 参考数据：构建期由 wordfreq 生成，运行时只读压缩 JSON。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { StudyCandidate } from '../../shared/types';

const DATA_FILE = 'ja-wordfreq-3.1.1.json.gz';
export const WORDFREQ_SOURCE = 'wordfreq@3.1.1/ja-large';

let cached: Readonly<Record<string, number>> | null | undefined;

function loadIndex(): Readonly<Record<string, number>> | null {
  if (cached !== undefined) return cached;
  let dir = __dirname;
  for (let i = 0; i < 7; i += 1) {
    const file = path.join(dir, 'data', DATA_FILE);
    if (fs.existsSync(file)) {
      try {
        const decoded = JSON.parse(gunzipSync(fs.readFileSync(file)).toString('utf8')) as {
          source?: string; version?: string; language?: string; wordlist?: string; entries?: Record<string, number>;
        };
        if (decoded.source === 'wordfreq' && decoded.version === '3.1.1' && decoded.language === 'ja' &&
            decoded.wordlist === 'large' && decoded.entries && typeof decoded.entries === 'object') {
          cached = decoded.entries;
          return cached;
        }
      } catch { /* 缺失/损坏时在 UI 标明不可用，不能把未收录误判为低频。 */ }
      cached = null;
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cached = null;
  return null;
}

export function wordfreqSource(): string | null {
  return loadIndex() ? WORDFREQ_SOURCE : null;
}

/** report 使用 lemma / normalized / surface 中的最高频；这里有 lemma 和最多五个原文 surface。 */
export function zipfForCandidate(candidate: StudyCandidate): number | null | undefined {
  const index = loadIndex();
  if (!index) return undefined;
  const forms = new Set<string>([candidate.expression, candidate.expression.normalize('NFKC')]);
  for (const occurrence of candidate.occurrences) {
    const surface = occurrence.text.slice(occurrence.start, occurrence.end);
    if (surface) { forms.add(surface); forms.add(surface.normalize('NFKC')); }
  }
  let highest: number | null = null;
  for (const form of forms) {
    const value = index[form];
    if (typeof value === 'number' && Number.isFinite(value)) highest = Math.max(highest ?? value, value);
  }
  return highest;
}
