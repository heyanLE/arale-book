/** 按书生成学习候选、保存人工审核，并导出 Anki 文本。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import type { BookRecord, BookSegments, StudyCandidate, StudyCandidatePatch, StudyCardDraft, StudyCardRunRequest, StudyFilterRunRequest, StudyList, StudyRunProgress } from '../../shared/types';
import { readJson, writeFileAtomic, writeJsonAtomic } from '../../core/util/atomic-json';
import { ankiTsv, buildStudyCandidates } from '../../core/study/candidates';
import { cardHarnessPrompt, chosenOccurrence, defaultStudyWorkflow, directCandidates, filterHarnessPrompt, normalizeLevels, parseCardResponse, parseFilterResponse, parseVerifyResponse, verifyCardPrompt, verifyFilterPrompt } from '../../core/study/harness';
import { createJlptIndex, lookupJlpt, normalizeReading, studyKey, type JlptRow } from '../../core/study/jlpt';
import { bookDir } from '../paths';
import { buildAnkiPackage } from './apkg';
import { cropStudyOccurrence, type StudyCrop } from './crop';
import type { LlmService } from '../llm/service';
import type { TranslationService } from '../translation/service';
import { tokenizeJapanese } from './tokenizer';

const FILE = 'study-list.json';
const DATA_FILE = 'jlpt-vocabulary.json';

export interface StudyServiceOptions {
  getBook(bookId: string): BookRecord | null;
  getSegments(bookId: string): BookSegments | null;
  ensureDictionary(): Promise<unknown>;
  lookupMeaning(expression: string, reading: string): string;
  progress?(bookId: string, done: number, total: number): void;
  workflowProgress?(progress: StudyRunProgress): void;
  llm?: Pick<LlmService, 'complete'>;
  translation?: Pick<TranslationService, 'translate'>;
  /** 测试注入纯图片；正式运行从漫画原始页图裁取。 */
  crop?: (bookId: string, occurrence: StudyCandidate['occurrences'][number]) => StudyCrop;
}

export class StudyService {
  private readonly running = new Map<string, { cancelled: boolean; controller?: AbortController }>();

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
      const previousList = this.read(bookId);
      const previous = new Map(previousList?.candidates.map((item) => [item.id, item]) ?? []);
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
        workflow: { ...(previousList?.workflow ?? defaultStudyWorkflow()), filterRun: undefined, pendingFilterRun: undefined, cardRun: undefined, pendingCardRun: undefined },
      };
      writeJsonAtomic(this.fileFor(bookId), list);
      return list;
    } finally { this.running.delete(bookId); }
  }

  cancel(bookId: string): void { const job = this.running.get(bookId); if (job) { job.cancelled = true; job.controller?.abort(); } }

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

  /** 第一步：按五个 JLPT 勾选项和“未分级”直接筛选，结果持久化为候选选择。 */
  directFilter(bookId: string, levels: number[], includeUnknown: boolean): StudyList {
    if (this.running.has(bookId)) throw new Error('正在运行学习任务，请稍后筛选');
    const list = this.read(bookId);
    if (!list) throw new Error('请先生成学习候选');
    const normalized = normalizeLevels(levels);
    const ids = new Set(directCandidates(list.candidates, normalized, includeUnknown).map((item) => item.id));
    for (const item of list.candidates) item.selected = ids.has(item.id);
    list.workflow = { levels: normalized, includeUnknown };
    writeJsonAtomic(this.fileFor(bookId), list);
    return list;
  }

  /** 可选第二步：固定版本的 F1/F2/F3 Harness；只允许模型评价直接筛选后的候选。 */
  async runFilter(bookId: string, request: StudyFilterRunRequest): Promise<StudyList> {
    if (this.running.has(bookId)) throw new Error('这本书已有学习任务在运行');
    if (!['F1', 'F2', 'F3'].includes(request.tier)) throw new Error('未知 LLM 筛选档位');
    const llm = this.options.llm;
    if (!llm) throw new Error('LLM 筛选服务未就绪');
    const list = this.read(bookId);
    if (!list) throw new Error('请先生成学习候选');
    const workflow = list.workflow ?? defaultStudyWorkflow();
    const source = directCandidates(list.candidates, workflow.levels, workflow.includeUnknown);
    if (source.length === 0) throw new Error('直接筛选没有候选词，请调整 JLPT 勾选项');
    const sourceHash = createHash('sha256').update(JSON.stringify(source.map((item) => ({
      id: item.id, expression: item.expression, reading: item.reading, contextRef: item.contextRef, occurrences: item.occurrences,
    })))).digest('hex');
    const job = { cancelled: false, controller: new AbortController() };
    this.running.set(bookId, job);
    try {
      const prior = workflow.pendingFilterRun;
      const resumed = prior?.tier === request.tier && prior.profileId === request.profileId && prior.sourceHash === sourceHash;
      const decisions: NonNullable<NonNullable<StudyList['workflow']>['filterRun']>['decisions'] =
        resumed ? { ...prior.decisions } : {};
      const stats = resumed && prior.stats ? { ...prior.stats } : { llmCalls: 0, translationCalls: 0, elapsedMs: 0 };
      const startedAt = Date.now();
      const batchSize = request.tier === 'F1' ? 12 : 1;
      for (let offset = 0; offset < source.length; offset += batchSize) {
        if (job.cancelled) throw new Error('已取消 LLM 筛选，原选择未更改');
        const batch = source.slice(offset, offset + batchSize);
        if (batch.every((item) => decisions[item.id])) {
          this.options.workflowProgress?.({ bookId, stage: 'filter', done: Math.min(offset + batchSize, source.length), total: source.length, message: '复用已完成结果' });
          continue;
        }
        const firstPrompt = filterHarnessPrompt(request.tier, batch);
        const first = await llm.complete({ profileId: request.profileId, ...firstPrompt, temperature: 0.1, signal: job.controller.signal });
        if (job.cancelled) throw new Error('已取消 LLM 筛选，原选择未更改');
        stats.llmCalls += 1;
        if (!first.ok) throw new Error(`LLM 筛选失败：${first.error ?? '未知错误'}`);
        const firstRows = parseFilterResponse(first.text, batch.map((item) => item.id));
        let finalRows = firstRows;
        if (request.tier === 'F3') {
          const second = await llm.complete({ profileId: request.profileId, ...verifyFilterPrompt(batch, firstRows), temperature: 0.1, signal: job.controller.signal });
          if (job.cancelled) throw new Error('已取消 LLM 筛选，原选择未更改');
          stats.llmCalls += 1;
          if (!second.ok) throw new Error(`LLM 复核失败：${second.error ?? '未知错误'}`);
          const checked = parseFilterResponse(second.text, batch.map((item) => item.id));
          finalRows = firstRows.map((row) => {
            const reviewer = checked.find((item) => item.id === row.id)!;
            return row.decision === reviewer.decision
              ? row
              : { id: row.id, decision: 'review' as const, reason: `两轮意见不一致：${row.reason} / ${reviewer.reason}`.slice(0, 240) };
          });
        }
        for (const row of finalRows) decisions[row.id] = { decision: row.decision, reason: row.reason };
        list.workflow = { ...workflow, pendingFilterRun: { tier: request.tier, profileId: request.profileId, sourceHash, decisions, stats: { ...stats, elapsedMs: stats.elapsedMs + Date.now() - startedAt } } };
        writeJsonAtomic(this.fileFor(bookId), list);
        this.options.workflowProgress?.({ bookId, stage: 'filter', done: Math.min(offset + batchSize, source.length), total: source.length });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (job.cancelled) throw new Error('已取消 LLM 筛选，原选择未更改');
      for (const item of list.candidates) {
        if (decisions[item.id]) item.selected = decisions[item.id]?.decision !== 'reject';
      }
      list.workflow = { ...workflow, filterRun: { tier: request.tier, profileId: request.profileId, completedAt: Date.now(), decisions, stats: { ...stats, elapsedMs: stats.elapsedMs + Date.now() - startedAt } }, pendingFilterRun: undefined, cardRun: undefined, pendingCardRun: undefined };
      writeJsonAtomic(this.fileFor(bookId), list);
      return list;
    } finally { this.running.delete(bookId); }
  }

  /** 第三步：R0 翻译或 R1–R3 LLM Harness 制作草稿。每张原句都来自固定的漫画文字块。 */
  async runCards(bookId: string, request: StudyCardRunRequest): Promise<StudyList> {
    if (this.running.has(bookId)) throw new Error('这本书已有学习任务在运行');
    if (!['R0', 'R1', 'R2', 'R3'].includes(request.tier)) throw new Error('未知制卡档位');
    const translation = this.options.translation;
    if (!translation) throw new Error('翻译服务未就绪');
    const llm = this.options.llm;
    if (request.tier !== 'R0' && (!llm || !request.profileId)) throw new Error('R1–R3 需要选择 LLM 配置');
    const list = this.read(bookId);
    if (!list) throw new Error('请先生成学习候选');
    const selected = selectedCandidates(list);
    if (selected.length === 0) throw new Error('请先在筛选步骤选择候选词');
    const sourceHash = selectedHash(list);
    const job = { cancelled: false, controller: new AbortController() };
    this.running.set(bookId, job);
    try {
      const prior = list.workflow?.pendingCardRun;
      const resumed = prior?.tier === request.tier &&
        prior.translationProfileId === request.translationProfileId &&
        prior.profileId === (request.tier === 'R0' ? null : request.profileId ?? null) &&
        prior.sourceHash === sourceHash;
      const drafts: StudyCardDraft[] = resumed ? [...prior.drafts] : [];
      const stats = resumed && prior.stats ? { ...prior.stats } : { llmCalls: 0, translationCalls: 0, elapsedMs: 0 };
      const startedAt = Date.now();
      for (let index = 0; index < selected.length; index += 1) {
        if (job.cancelled) throw new Error('已取消制卡，旧草稿保持不变');
        const item = selected[index]!;
        if (drafts.some((draft) => draft.candidateId === item.id)) {
          this.options.workflowProgress?.({ bookId, stage: 'cards', done: index + 1, total: selected.length, message: '复用已完成草稿' });
          continue;
        }
        const occurrence = chosenOccurrence(item);
        if (!occurrence) throw new Error(`「${item.expression}」没有原文出处`);
        const [word, sentence] = await Promise.all([
          translation.translate({ text: item.expression, profileId: request.translationProfileId, targetLanguage: 'zh-Hans' }),
          translation.translate({ text: occurrence.text, profileId: request.translationProfileId, targetLanguage: 'zh-Hans' }),
        ]);
        if (job.cancelled) throw new Error('已取消制卡，旧草稿保持不变');
        stats.translationCalls += 2;
        if (!word.ok || !sentence.ok) throw new Error(`「${item.expression}」翻译失败：${word.error ?? sentence.error ?? '未知错误'}`);
        let draft: StudyCardDraft = {
          candidateId: item.id, meaning: word.text, sentenceTranslation: sentence.text,
          usage: '', nuance: '', needsReview: false, reviewReason: '',
        };
        if (request.tier !== 'R0' && llm) {
          const prompt = cardHarnessPrompt(request.tier, item, word.text, sentence.text);
          const result = await llm.complete({ profileId: request.profileId, ...prompt, temperature: 0.1, signal: job.controller.signal });
          if (job.cancelled) throw new Error('已取消制卡，旧草稿保持不变');
          stats.llmCalls += 1;
          if (!result.ok) throw new Error(`「${item.expression}」制卡失败：${result.error ?? '未知错误'}`);
          draft = parseCardResponse(result.text, item.id);
          if (request.tier === 'R3') {
            const checked = await llm.complete({ profileId: request.profileId, ...verifyCardPrompt(item, draft), temperature: 0.1, signal: job.controller.signal });
            if (job.cancelled) throw new Error('已取消制卡，旧草稿保持不变');
            stats.llmCalls += 1;
            if (!checked.ok) throw new Error(`「${item.expression}」复核失败：${checked.error ?? '未知错误'}`);
            const verdict = parseVerifyResponse(checked.text);
            if (!verdict.approved) draft = { ...draft, needsReview: true, reviewReason: verdict.reason || '复核未通过' };
          }
        }
        drafts.push(draft);
        list.workflow = { ...(list.workflow ?? defaultStudyWorkflow()), pendingCardRun: {
          tier: request.tier, profileId: request.tier === 'R0' ? null : request.profileId ?? null,
          translationProfileId: request.translationProfileId, sourceHash, drafts,
          stats: { ...stats, elapsedMs: stats.elapsedMs + Date.now() - startedAt },
        } };
        writeJsonAtomic(this.fileFor(bookId), list);
        this.options.workflowProgress?.({ bookId, stage: 'cards', done: index + 1, total: selected.length, message: item.expression });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (job.cancelled) throw new Error('已取消制卡，旧草稿保持不变');
      list.workflow = { ...(list.workflow ?? defaultStudyWorkflow()), cardRun: {
        tier: request.tier, profileId: request.tier === 'R0' ? null : request.profileId ?? null,
        translationProfileId: request.translationProfileId, completedAt: Date.now(), sourceHash, drafts,
        stats: { ...stats, elapsedMs: stats.elapsedMs + Date.now() - startedAt },
      }, pendingCardRun: undefined };
      writeJsonAtomic(this.fileFor(bookId), list);
      return list;
    } finally { this.running.delete(bookId); }
  }

  /** 人工修正或认可 R3 存疑草稿；不修改候选身份。 */
  patchCard(bookId: string, candidateId: string, patch: Partial<Pick<StudyCardDraft, 'meaning' | 'sentenceTranslation' | 'usage' | 'nuance' | 'needsReview'>>): StudyList {
    if (this.running.has(bookId)) throw new Error('正在制卡，请稍后审核');
    const list = this.read(bookId);
    const draft = list?.workflow?.cardRun?.drafts.find((item) => item.candidateId === candidateId);
    if (!list || !draft) throw new Error('找不到制卡草稿');
    for (const key of ['meaning', 'sentenceTranslation', 'usage', 'nuance'] as const) {
      if (typeof patch[key] === 'string') draft[key] = patch[key]!.trim().slice(0, 1000);
    }
    if (patch.needsReview === false && draft.meaning && draft.sentenceTranslation) {
      draft.needsReview = false;
      draft.reviewReason = '';
    }
    writeJsonAtomic(this.fileFor(bookId), list);
    return list;
  }

  /** 第四步：逐张裁 OCR 原文矩形，写入含媒体的 .apkg。 */
  async exportPackage(bookId: string, targetPath: string): Promise<number> {
    if (this.running.has(bookId)) throw new Error('学习任务仍在运行');
    const list = this.read(bookId);
    const book = this.options.getBook(bookId);
    const run = list?.workflow?.cardRun;
    if (!list || !book || !run) throw new Error('请先运行制卡 Harness');
    if (run.sourceHash !== selectedHash(list)) throw new Error('候选已变化，请重新制作词卡');
    if (run.drafts.some((item) => item.needsReview)) throw new Error('还有存疑词卡，请先审核');
    const byId = new Map(selectedCandidates(list).map((item) => [item.id, item]));
    if (run.drafts.length !== byId.size) throw new Error('制卡草稿与候选数量不一致');
    const crop = this.options.crop ?? cropStudyOccurrence;
    const inputs = [];
    for (let index = 0; index < run.drafts.length; index += 1) {
      const draft = run.drafts[index]!;
      const candidate = byId.get(draft.candidateId);
      const occurrence = candidate && chosenOccurrence(candidate);
      if (!candidate || !occurrence) throw new Error('制卡草稿的原文出处已失效');
      const image = crop(bookId, occurrence);
      inputs.push({ candidate, draft, imageName: image.name, image: image.data });
      this.options.workflowProgress?.({ bookId, stage: 'export', done: index + 1, total: run.drafts.length });
    }
    const content = await buildAnkiPackage(bookId, book.title, run.tier, inputs);
    writeFileAtomic(targetPath, content);
    const now = Date.now();
    for (const item of selectedCandidates(list)) item.exportedAt = now;
    writeJsonAtomic(this.fileFor(bookId), list);
    return inputs.length;
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

function selectedCandidates(list: StudyList): StudyCandidate[] {
  return list.candidates.filter((item) => item.selected && !item.excluded);
}

/** 不把 exportedAt 算入：导出后再次导出仍应命中相同草稿。 */
function selectedHash(list: StudyList): string {
  const rows = selectedCandidates(list).map((item) => ({
    id: item.id, expression: item.expression, reading: item.reading, meaning: item.meaning,
    contextRef: item.contextRef, occurrences: item.occurrences,
  }));
  return createHash('sha256').update(JSON.stringify({ segmentGeneratedAt: list.segmentGeneratedAt, rows })).digest('hex');
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
