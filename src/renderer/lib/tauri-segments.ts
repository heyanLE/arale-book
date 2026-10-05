import { morphologyToRecords } from '@core/segment/morph';
import { segmentUnits, buildVocabulary, type SegmentTextUnit } from '@core/segment';
import { normalizeQuery } from '@core/dict/normalize';
import type { TermIndex } from '@core/dict/model';
import { CURRENT_SEGMENT_ENGINE, type BookSegments, type SegmentJobResult, type SegmentUnit } from '@shared/types';
import { tokenizeJapanese } from './tauri-tokenizer';

interface Job { cancelled: boolean; finished: Promise<SegmentJobResult>; }
export class TauriSegments {
  private jobs = new Map<string, Job>();
  private clearing = new Set<string>();
  constructor(
    private native: (channel: string, ...args: unknown[]) => Promise<any>,
    private emit: (channel: string, payload: unknown) => void,
    private dictionary: () => Promise<TermIndex>,
  ) {}
  private result(id: string, data: BookSegments): SegmentJobResult {
    return { bookId: id, ok: true, units: data.units.length, tokens: data.units.reduce((n, unit) => n + (Array.isArray(unit?.tokens) ? unit.tokens.length : 0), 0), uniqueWords: data.vocabulary.length };
  }
  private fail(id: string, error: string): SegmentJobResult { return { bookId: id, ok: false, units: 0, tokens: 0, uniqueWords: 0, error }; }
  async request(channel: string, args: any[]): Promise<unknown> {
    const id = args[0] as string;
    if (channel === 'segment:read') return this.native(channel, id);
    if (channel === 'segment:status') {
      if (this.jobs.has(id)) return this.fail(id, '正在分词中…');
      const data = await this.native('segment:read', id) as BookSegments | null;
      return data ? this.result(id, data) : null;
    }
    if (channel === 'segment:cancel') { const job = this.jobs.get(id); if (job) job.cancelled = true; return; }
    if (channel === 'segment:clear') {
      this.clearing.add(id);
      try {
        const job = this.jobs.get(id);
        if (job) { job.cancelled = true; await job.finished; }
        await this.native('segment:clear', id);
      } finally { this.clearing.delete(id); }
      return;
    }
    if (channel !== 'segment:start') throw new Error(`未知分词请求 ${channel}`);
    if (this.jobs.has(id) || this.clearing.has(id)) return this.fail(id, '正在分词中…');
    // Reserve before the first await, so concurrent clicks cannot start duplicate jobs.
    const job: Job = { cancelled: false, finished: undefined as never };
    this.jobs.set(id, job);
    const initial = this.fail(id, '正在分词中…');
    job.finished = (async () => {
      if (args[1]?.force !== true) {
        const existing = await this.native('segment:read', id) as BookSegments | null;
        if (existing?.engine === CURRENT_SEGMENT_ENGINE) return this.result(id, existing);
      }
      return this.run(id, job);
    })().catch(error => this.fail(id, String(error))).then(result => {
      this.jobs.delete(id); this.emit('segment:done', result); return result;
    });
    // Match the shared immediate acknowledgment; done/progress report the actual outcome.
    return { ...initial, ok: true, error: undefined };
  }
  private async run(id: string, job: Job): Promise<SegmentJobResult> {
    this.emit('segment:progress', { bookId: id, done: 0, total: 0, stage: 'reading' });
    const index = await this.dictionary();
    const source = await this.native('segment:input', id) as { units: SegmentTextUnit[]; fingerprint: string };
    const descriptor = { count: index.dictionaries.length, signature: index.dictionaries.map(dict => `${dict.id}:${dict.termCount}`).sort().join('|') };
    const units: SegmentUnit[] = [];
    let tokens = 0;
    let lastTime = Date.now();
    const progress = (stage: string) => this.emit('segment:progress', { bookId: id, done: units.length, total: source.units.length, stage });
    progress('segmenting');
    for (const textUnit of source.units) {
      if (job.cancelled) return { ...this.fail(id, '已取消'), units: units.length, tokens, uniqueWords: buildVocabulary(units).length };
      const parsed = morphologyToRecords(textUnit.text, await tokenizeJapanese(textUnit.text), expression =>
        (index.byKey.get(normalizeQuery(expression)) ?? []).some(term => term.expression === expression));
      const produced = segmentUnits([textUnit], { segmentText: () => parsed, dictionary: descriptor, engine: CURRENT_SEGMENT_ENGINE });
      units.push(...produced.units); tokens += produced.tokenCount;
      if (units.length % 50 === 0 || Date.now() - lastTime >= 250) {
        progress('segmenting'); lastTime = Date.now(); await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    if (job.cancelled) return this.fail(id, '已取消');
    const data: BookSegments = { bookId: id, generatedAt: Date.now(), engine: CURRENT_SEGMENT_ENGINE, dictionarySignature: descriptor.signature, dictionaryCount: descriptor.count, units, vocabulary: buildVocabulary(units) };
    progress('writing');
    await this.native('segment:commit', id, JSON.stringify(data), source.fingerprint);
    progress('done'); return this.result(id, data);
  }
}
