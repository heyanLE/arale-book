/** 按书生成学习候选、保存人工审核，并导出 Anki 文本。 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { BookRecord, BookSegments, StudyCandidate, StudyCandidatePatch, StudyList } from '../../shared/types';
import { readJson, writeJsonAtomic } from '../../core/util/atomic-json';
import { ankiTsv, buildStudyCandidates } from '../../core/study/candidates';
import { createJlptIndex, lookupJlpt, normalizeReading, studyKey, type JlptRow } from '../../core/study/jlpt';
import { bookDir } from '../paths';
import { tokenizeJapanese } from './tokenizer';

const FILE = 'study-list.json';
const DATA_FILE = 'jlpt-vocabulary.json';

export interface StudyServiceOptions {
  getBook(bookId: string): BookRecord | null;
  getSegments(bookId: string): BookSegments | null;
  ensureDictionary(): Promise<unknown>;
  lookupMeaning(expression: string, reading: string): string;
  progress?(bookId: string, done: number, total: number): void;
}

export class StudyService {
  private readonly running = new Map<string, { cancelled: boolean }>();

  constructor(private readonly options: StudyServiceOptions) {}

  private fileFor(bookId: string): string { return path.join(bookDir(bookId), FILE); }

  read(bookId: string): StudyList | null {
    const value = readJson<StudyList | null>(this.fileFor(bookId), null);
    return value?.bookId === bookId && Array.isArray(value.candidates) ? value : null;
  }

  async generate(bookId: string): Promise<StudyList> {
    if (this.running.has(bookId)) throw new Error('这本书正在生成候选词');
    const book = this.options.getBook(bookId);
    if (!book) throw new Error('书不存在');
    if ((book.readerMode ?? book.format) !== 'comic') throw new Error('当前仅支持漫画文字层');
    const segments = this.options.getSegments(bookId);
    if (!segments || segments.units.length === 0) throw new Error('请先生成这本书的分词结果；漫画需要 OCR 或文字层');

    const job = { cancelled: false };
    this.running.set(bookId, job);
    try {
      await this.options.ensureDictionary();
      const { index, source } = loadJlpt();
      const parsed = [];
      const total = segments.units.length;
      for (let i = 0; i < total; i += 1) {
        if (job.cancelled) throw new Error('已取消生成');
        parsed.push(await tokenizeJapanese(segments.units[i]?.text ?? ''));
        if ((i + 1) % 20 === 0 || i + 1 === total) {
          this.options.progress?.(bookId, i + 1, total);
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      const candidates = buildStudyCandidates(segments.units, parsed, index);
      const previous = new Map(this.read(bookId)?.candidates.map((item) => [item.id, item]) ?? []);
      for (let index = 0; index < candidates.length; index += 1) {
        if (job.cancelled) throw new Error('已取消生成');
        const item = candidates[index]!;
        const old = previous.get(item.id);
        item.meaning = old?.meaning ?? this.options.lookupMeaning(item.expression, item.reading);
        if (old) {
          item.expression = old.expression;
          item.reading = old.reading;
          item.selected = old.selected;
          item.excluded = old.excluded;
          item.exportedAt = old.exportedAt;
          if (item.occurrences.some((one) => one.id === old.contextRef)) item.contextRef = old.contextRef;
        }
        if ((index + 1) % 100 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      for (const old of previous.values()) {
        if (old.partOfSpeech === '短语' && !candidates.some((item) => item.id === old.id)) candidates.push(old);
      }
      const list: StudyList = {
        bookId, generatedAt: Date.now(), segmentGeneratedAt: segments.generatedAt,
        jlptSource: source, candidates,
      };
      writeJsonAtomic(this.fileFor(bookId), list);
      return list;
    } finally { this.running.delete(bookId); }
  }

  cancel(bookId: string): void { const job = this.running.get(bookId); if (job) job.cancelled = true; }

  patch(bookId: string, candidateId: string, patch: StudyCandidatePatch): StudyCandidate {
    if (this.running.has(bookId)) throw new Error('正在重新生成候选，请稍后修改');
    const list = this.read(bookId);
    if (!list) throw new Error('尚未生成学习候选');
    const item = list.candidates.find((candidate) => candidate.id === candidateId);
    if (!item) throw new Error('候选词不存在；可能已重新生成');
    if (typeof patch.selected === 'boolean') item.selected = patch.selected;
    if (typeof patch.excluded === 'boolean') item.excluded = patch.excluded;
    if (typeof patch.expression === 'string' && patch.expression.trim().length > 0) item.expression = patch.expression.trim().slice(0, 100);
    if (typeof patch.reading === 'string') item.reading = normalizeReading(patch.reading).slice(0, 100);
    if (patch.expression !== undefined || patch.reading !== undefined) {
      const match = lookupJlpt(loadJlpt().index, item.expression, item.reading);
      item.jlpt = match.level;
      item.jlptConflict = match.conflict;
    }
    if (typeof patch.meaning === 'string') item.meaning = patch.meaning.slice(0, 2000);
    if (typeof patch.contextRef === 'string') {
      if (!item.occurrences.some((one) => one.id === patch.contextRef)) throw new Error('出处不属于该词');
      item.contextRef = patch.contextRef;
    }
    writeJsonAtomic(this.fileFor(bookId), list);
    return item;
  }

  patchMany(bookId: string, candidateIds: string[], patch: StudyCandidatePatch): StudyList {
    if (this.running.has(bookId)) throw new Error('正在重新生成候选，请稍后修改');
    const list = this.read(bookId);
    if (!list) throw new Error('尚未生成学习候选');
    if (candidateIds.length > 10000) throw new Error('一次最多选择 10000 个词');
    const ids = new Set(candidateIds);
    for (const item of list.candidates) {
      if (!ids.has(item.id)) continue;
      if (typeof patch.selected === 'boolean') item.selected = patch.selected;
      if (typeof patch.excluded === 'boolean') item.excluded = patch.excluded;
    }
    writeJsonAtomic(this.fileFor(bookId), list);
    return list;
  }

  addPhrase(bookId: string, occurrenceId: string, expression: string, reading: string): StudyList {
    if (this.running.has(bookId)) throw new Error('正在重新生成候选，请稍后修改');
    const list = this.read(bookId);
    if (!list) throw new Error('尚未生成学习候选');
    const phrase = expression.trim();
    if (phrase.length < 2 || phrase.length > 100) throw new Error('短语长度需为 2–100 个字符');
    const source = list.candidates.flatMap((item) => item.occurrences).find((one) => one.id === occurrenceId && one.text.includes(phrase));
    if (!source) throw new Error('短语必须来自所选文字块');
    const id = studyKey(phrase, reading);
    const start = source.text.indexOf(phrase);
    const occurrence = { ...source, id: `${source.ref}@${start}`, start, end: start + phrase.length };
    const existing = list.candidates.find((item) => item.id === id);
    if (existing) {
      existing.selected = true;
      existing.excluded = false;
      if (!existing.occurrences.some((one) => one.id === occurrence.id)) existing.occurrences.push(occurrence);
      existing.contextRef = occurrence.id;
    } else {
      list.candidates.unshift({
        id, expression: phrase, reading: normalizeReading(reading), partOfSpeech: '短语',
        jlpt: null, jlptConflict: false, count: 1,
        occurrences: [occurrence],
        meaning: '', selected: true, excluded: false, contextRef: occurrence.id, exportedAt: null,
      });
    }
    writeJsonAtomic(this.fileFor(bookId), list);
    return list;
  }

  exportText(bookId: string, targetPath: string): number {
    if (this.running.has(bookId)) throw new Error('正在重新生成候选，请稍后导出');
    const list = this.read(bookId);
    const book = this.options.getBook(bookId);
    if (!list || !book) throw new Error('书或学习候选不存在');
    const result = ankiTsv(list.candidates, book.title);
    if (result.count === 0) throw new Error('请先选择要导出的词');
    fs.writeFileSync(targetPath, result.text, 'utf8');
    const now = Date.now();
    for (const item of list.candidates) if (item.selected && !item.excluded) item.exportedAt = now;
    writeJsonAtomic(this.fileFor(bookId), list);
    return result.count;
  }
}

function loadJlpt(): { index: ReturnType<typeof createJlptIndex>; source: string } {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    const filename = path.join(dir, 'data', DATA_FILE);
    if (fs.existsSync(filename)) {
      const data = JSON.parse(fs.readFileSync(filename, 'utf8')) as { revision: string; entries: JlptRow[] };
      return { index: createJlptIndex(data.entries), source: `stephenmk/yomitan-jlpt-vocab@${data.revision}` };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('找不到随包的 JLPT 参考词表');
}

/** 取与读音相符的首条词典释义；递归扁平化，导出时再进行 HTML 转义。 */
export function plainGlossary(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(plainGlossary).filter(Boolean).join('；');
  if (value && typeof value === 'object' && 'content' in value) return plainGlossary((value as { content: unknown }).content);
  return '';
}

export function chooseMeaning(
  results: readonly { term: { expression: string; reading: string; glossary: unknown } }[],
  expression: string,
  reading: string,
): string {
  const matchingExpression = results.filter((item) => item.term.expression === expression);
  const exact = matchingExpression.find((item) => normalizeReading(item.term.reading) === normalizeReading(reading));
  if (reading && !exact) return '';
  return plainGlossary((exact ?? matchingExpression[0])?.term.glossary).slice(0, 1000);
}
