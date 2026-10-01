/** 按书生成学习候选、保存人工审核，并导出 Anki 文本。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import type { BookRecord, BookSegments, DictTerm, DirectFilterOptions, LlmAnalyzeResult, StudyCandidate, StudyCandidatePatch, StudyCardDraft, StudyCardPatch, StudyCardRunRequest, StudyFilterRunRequest, StudyImageMode, StudyList, StudyRunProgress, StudyRunStats } from '../../shared/types';
import { isPipelineTier, readyDraft, withIssues } from '../../core/study/pipeline';
import { previewCardPipeline, runCardPipeline } from './pipeline';
import { readJson, writeFileAtomic, writeJsonAtomic } from '../../core/util/atomic-json';
import { ankiTsv, buildStudyCandidates } from '../../core/study/candidates';
import { CARD_TIERS, FILTER_TIERS, MAX_HARNESS_CONTEXT_CHARS, MAX_HARNESS_TRANSLATION_CHARS, HarnessOutputError, cardHarnessPrompt, chosenOccurrence, defaultStudyWorkflow, directCandidates, filterHarnessPrompt, normalizeDirectOptions, normalizeLevels, parseCardBatchResponse, parseFilterResponse, parseVerifyBatchResponse, verifyCardPrompt, verifyFilterPrompt } from '../../core/study/harness';
import { harnessSubmissionTool } from '../../core/study/harness-tool';
import { createJlptIndex, lookupJlpt, normalizeReading, studyKey, type JlptRow } from '../../core/study/jlpt';
import { bookDir } from '../paths';
import { buildAnkiPackage } from './apkg';
import { cropStudyOccurrence, pageStudyOccurrence, sourcePage, type StudyCrop } from './crop';
import { normalizeHarnessConcurrency, runConcurrentBatches } from './concurrency';
import { wordfreqSource, zipfForCandidate } from './wordfreq';
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
  lookupTerms?(expression: string): DictTerm[];
  progress?(bookId: string, done: number, total: number): void;
  workflowProgress?(progress: StudyRunProgress): void;
  llm?: Pick<LlmService, 'complete'> & Partial<Pick<LlmService, 'profileSignature'>>;
  translation?: Pick<TranslationService, 'translate'> & Partial<Pick<TranslationService, 'profileSignature'>>;
  /** 测试注入纯图片；正式运行从漫画原始页图裁取。 */
  crop?: (bookId: string, occurrence: StudyCandidate['occurrences'][number]) => StudyCrop;
  pageImage?: (bookId: string, occurrence: StudyCandidate['occurrences'][number]) => StudyCrop;
}

export class StudyService {
  private readonly running = new Map<string, { cancelled: boolean; controller?: AbortController }>();

  constructor(private readonly options: StudyServiceOptions) {}

  private fileFor(bookId: string): string { return path.join(bookDir(bookId), FILE); }

  read(bookId: string): StudyList | null {
    const value = readJson<StudyList | null>(this.fileFor(bookId), null);
    if (value?.bookId !== bookId || !Array.isArray(value.candidates)) return null;
    const source = wordfreqSource();
    if (source && value.wordfreqSource !== source) {
      for (const item of value.candidates) item.zipf = zipfForCandidate(item);
    }
    value.wordfreqSource = source;
    for (const item of value.candidates) {
      if (item.partOfSpeech === '短语' && item.forceInclude === undefined) item.forceInclude = true;
      // 旧版默认总是第一处；不同的 contextRef 表明用户曾经选过出处。
      if (item.contextPinned === undefined && item.contextRef !== item.occurrences[0]?.id) item.contextPinned = true;
    }
    return value;
  }

  async generate(bookId: string): Promise<StudyList> {
    if (this.running.has(bookId)) throw new Error('这本书正在生成候选词');
    const previousList = this.read(bookId);
    if (Object.keys(previousList?.workflow?.pendingFilterRun?.decisions ?? {}).length > 0) {
      throw new Error('已有 LLM 筛选检查点；请先续跑或明确放弃，再重新生成候选');
    }
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
      const frequencySource = wordfreqSource();
      if (frequencySource) for (const item of candidates) item.zipf = zipfForCandidate(item);
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
          item.forceInclude = old.forceInclude;
          item.meaningEdited = old.meaningEdited;
          item.contextPinned = old.contextPinned;
          if (old.contextPinned) {
            const pinned = segments.units.find(unit => old.occurrences.some(one => one.id === old.contextRef && one.ref === unit.ref));
            const occurrence = old.occurrences.find(one => one.id === old.contextRef);
            if (pinned && occurrence && pinned.text === occurrence.text && !item.occurrences.some(one => one.id === occurrence.id)) item.occurrences.push(occurrence);
          }
          if (item.occurrences.some((one) => one.id === old.contextRef)) item.contextRef = old.contextRef;
        }
        if ((index + 1) % 100 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      for (const old of previous.values()) {
        if (old.partOfSpeech === '短语' && !candidates.some((item) => item.id === old.id)) candidates.push(old);
      }
      const list: StudyList = {
        bookId, generatedAt: Date.now(), segmentGeneratedAt: segments.generatedAt,
        jlptSource: source, wordfreqSource: frequencySource, candidates,
        workflow: { ...(previousList?.workflow ?? defaultStudyWorkflow()), directAppliedAt: 0, partialFilterAppliedAt: undefined, filterRun: undefined, pendingFilterRun: undefined, cardRun: undefined, pendingCardRun: undefined },
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
    if (Object.keys(list.workflow?.pendingFilterRun?.decisions ?? {}).length > 0 &&
      (patch.excluded !== undefined || patch.forceInclude !== undefined || patch.expression !== undefined ||
        patch.reading !== undefined || patch.contextRef !== undefined)) {
      throw new Error('已有 LLM 筛选检查点；请先续跑或明确放弃，再修改词形、出处或人工决定');
    }
    const item = list.candidates.find((candidate) => candidate.id === candidateId);
    if (!item) throw new Error('候选词不存在；可能已重新生成');
    if (typeof patch.selected === 'boolean') item.selected = patch.selected;
    if (typeof patch.excluded === 'boolean') item.excluded = patch.excluded;
    if (typeof patch.forceInclude === 'boolean') {
      item.forceInclude = patch.forceInclude;
      if (patch.forceInclude && !item.excluded) item.selected = true;
    }
    if (typeof patch.expression === 'string' && patch.expression.trim().length > 0) item.expression = patch.expression.trim().slice(0, 100);
    if (typeof patch.reading === 'string') item.reading = normalizeReading(patch.reading).slice(0, 100);
    if (patch.expression !== undefined || patch.reading !== undefined) {
      const match = lookupJlpt(loadJlpt().index, item.expression, item.reading);
      item.jlpt = match.level;
      item.jlptConflict = match.conflict;
      item.zipf = zipfForCandidate(item);
    }
    if (typeof patch.meaning === 'string' && patch.meaning !== item.meaning) { item.meaning = patch.meaning.slice(0, 2000); item.meaningEdited = true; }
    if (typeof patch.contextRef === 'string') {
      if (!item.occurrences.some((one) => one.id === patch.contextRef)) throw new Error('出处不属于该词');
      item.contextRef = patch.contextRef;
      item.contextPinned = true;
    }
    writeJsonAtomic(this.fileFor(bookId), list);
    return item;
  }

  patchMany(bookId: string, candidateIds: string[], patch: StudyCandidatePatch): StudyList {
    if (this.running.has(bookId)) throw new Error('正在重新生成候选，请稍后修改');
    const list = this.read(bookId);
    if (!list) throw new Error('尚未生成学习候选');
    if (Object.keys(list.workflow?.pendingFilterRun?.decisions ?? {}).length > 0 &&
      (patch.excluded !== undefined || patch.forceInclude !== undefined)) {
      throw new Error('已有 LLM 筛选检查点；请先续跑或明确放弃，再批量修改人工决定');
    }
    if (candidateIds.length > 10000) throw new Error('一次最多选择 10000 个词');
    const ids = new Set(candidateIds);
    for (const item of list.candidates) {
      if (!ids.has(item.id)) continue;
      if (typeof patch.selected === 'boolean') item.selected = patch.selected;
      if (typeof patch.excluded === 'boolean') item.excluded = patch.excluded;
      if (typeof patch.forceInclude === 'boolean') item.forceInclude = patch.forceInclude;
      if (item.excluded) item.selected = false;
      else if (item.forceInclude) item.selected = true;
    }
    writeJsonAtomic(this.fileFor(bookId), list);
    return list;
  }

  addPhrase(bookId: string, occurrenceId: string, expression: string, reading: string): StudyList {
    if (this.running.has(bookId)) throw new Error('正在重新生成候选，请稍后修改');
    const list = this.read(bookId);
    if (!list) throw new Error('尚未生成学习候选');
    if (Object.keys(list.workflow?.pendingFilterRun?.decisions ?? {}).length > 0) {
      throw new Error('已有 LLM 筛选检查点；请先续跑或明确放弃，再补录短语');
    }
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
      existing.forceInclude = true;
      if (!existing.occurrences.some((one) => one.id === occurrence.id)) existing.occurrences.push(occurrence);
      existing.contextRef = occurrence.id;
    } else {
      list.candidates.unshift({
        id, expression: phrase, reading: normalizeReading(reading), partOfSpeech: '短语',
        jlpt: null, jlptConflict: false, count: 1,
        occurrences: [occurrence],
        meaning: '', selected: true, excluded: false, forceInclude: true, contextRef: occurrence.id, exportedAt: null,
      });
    }
    const phraseCandidate = list.candidates.find((item) => item.id === id);
    if (phraseCandidate) phraseCandidate.zipf = zipfForCandidate(phraseCandidate);
    writeJsonAtomic(this.fileFor(bookId), list);
    return list;
  }

  /** 第一步：按五个 JLPT 勾选项和“未分级”直接筛选，结果持久化为候选选择。 */
  directFilter(bookId: string, levels: number[], includeUnknown: boolean, options?: Partial<DirectFilterOptions>): StudyList {
    if (this.running.has(bookId)) throw new Error('正在运行学习任务，请稍后筛选');
    const list = this.read(bookId);
    if (!list) throw new Error('请先生成学习候选');
    const normalized = normalizeLevels(levels);
    const direct = normalizeDirectOptions(options ?? list.workflow?.direct);
    if (direct.minZipf !== null && !list.wordfreqSource) throw new Error('缺少随包的日语通用词频数据，无法启用 Zipf 筛选');
    const previous = list.workflow;
    const sameRules = previous !== undefined &&
      JSON.stringify(normalizeLevels(previous.levels)) === JSON.stringify(normalized) &&
      previous.includeUnknown === includeUnknown &&
      JSON.stringify(normalizeDirectOptions(previous.direct)) === JSON.stringify(direct);
    if (!sameRules && Object.keys(previous?.pendingFilterRun?.decisions ?? {}).length > 0) {
      throw new Error('直接筛选规则已变化；先续跑或明确放弃旧 LLM 检查点，避免丢失已处理结果');
    }
    const ids = new Set(directCandidates(list.candidates, normalized, includeUnknown, direct).map((item) => item.id));
    for (const item of list.candidates) item.selected = ids.has(item.id);
    list.workflow = {
      levels: normalized, includeUnknown, direct, directAppliedAt: Date.now(), partialFilterAppliedAt: undefined,
      ...(sameRules && previous?.pendingFilterRun ? { pendingFilterRun: previous.pendingFilterRun } : {}),
    };
    writeJsonAtomic(this.fileFor(bookId), list);
    return list;
  }

  /** 可选第二步：固定版本的 F1/F2/F3 Harness；只允许模型评价直接筛选后的候选。 */
  async runFilter(bookId: string, request: StudyFilterRunRequest): Promise<StudyList> {
    if (this.running.has(bookId)) throw new Error('这本书已有学习任务在运行');
    if (!['F1', 'F2', 'F3'].includes(request.tier)) throw new Error('未知 LLM 筛选档位');
    const llm = this.options.llm;
    if (!llm) throw new Error('LLM 筛选服务未就绪');
    const profileSignature = llm.profileSignature?.(request.profileId) ?? undefined;
    const list = this.read(bookId);
    if (!list) throw new Error('请先生成学习候选');
    const workflow = list.workflow ?? defaultStudyWorkflow();
    const source = directCandidates(list.candidates, workflow.levels, workflow.includeUnknown, workflow.direct)
      .filter((item) => item.forceInclude !== true);
    if (source.length === 0) throw new Error('没有需要 LLM 筛选的候选词；手动保留项不送模型');
    const sourceHash = createHash('sha256').update(JSON.stringify(source.map((item) => ({
      id: item.id, expression: item.expression, reading: item.reading, contextRef: item.contextRef, occurrences: item.occurrences,
    })))).digest('hex');
    const concurrency = normalizeHarnessConcurrency(request.concurrency);
    const prior = workflow.pendingFilterRun;
    const resumed = prior?.tier === request.tier && prior.profileId === request.profileId && prior.sourceHash === sourceHash && prior.profileSignature === profileSignature;
    if (!resumed && Object.keys(prior?.decisions ?? {}).length > 0) {
      throw new Error('已有不同档位、模型或规则的 LLM 检查点；先续跑原任务或明确放弃旧检查点');
    }
    const decisions: NonNullable<NonNullable<StudyList['workflow']>['filterRun']>['decisions'] =
      resumed ? { ...prior.decisions } : {};
    const stats: StudyRunStats = resumed && prior.stats ? { ...prior.stats } : { llmCalls: 0, translationCalls: 0, elapsedMs: 0 };
    const startedAt = Date.now();
    const job = { cancelled: false, controller: new AbortController() };
    this.running.set(bookId, job);
    type FilterRow = { id: string; decision: 'keep' | 'reject' | 'review'; reason: string };
    const emitFilterProgress = (updates: FilterRow[] = [], message?: string): void => {
      const counts = { keep: 0, reject: 0, review: 0 };
      for (const value of Object.values(decisions)) counts[value.decision] += 1;
      this.options.workflowProgress?.({
        bookId, stage: 'filter', done: Object.keys(decisions).length, total: source.length, message,
        filter: { ...counts, llmCalls: stats.llmCalls, httpAttempts: stats.llmHttpAttempts,
          fallbackCount: stats.llmFallbacks, cacheHitTokens: stats.cacheHitTokens, cacheMissTokens: stats.cacheMissTokens,
          elapsedMs: stats.elapsedMs + Date.now() - startedAt, updates },
      });
    };
    try {
      const batchSize = FILTER_TIERS[request.tier].batchSize;
      const filterTool = harnessSubmissionTool('filter');
      emitFilterProgress([], resumed ? '从已保存的批次续跑' : '正在筛选');
      const evaluateBatch = async (batch: StudyCandidate[]): Promise<FilterRow[]> => {
        const first = await llm.complete({ profileId: request.profileId, expectedProfileSignature: profileSignature, ...filterHarnessPrompt(request.tier, batch), tool: filterTool, temperature: 0.1, signal: job.controller.signal });
        recordLlmResult(stats, first);
        if (job.cancelled) throw new Error('已取消 LLM 筛选，原选择未更改');
        if (!first.ok) throw batchFailure('LLM 筛选失败', first.error, batch.length);
        const firstRows = parseFilterResponse(first.text, batch.map((item) => item.id));
        if (request.tier !== 'F3') return firstRows;
        const second = await llm.complete({ profileId: request.profileId, expectedProfileSignature: profileSignature, ...verifyFilterPrompt(batch, firstRows), tool: filterTool, temperature: 0.1, signal: job.controller.signal });
        recordLlmResult(stats, second);
        if (job.cancelled) throw new Error('已取消 LLM 筛选，原选择未更改');
        if (!second.ok) throw batchFailure('LLM 复核失败', second.error, batch.length);
        const checked = parseFilterResponse(second.text, batch.map((item) => item.id));
        return firstRows.map((row) => {
          const reviewer = checked.find((item) => item.id === row.id)!;
          return row.decision === reviewer.decision
            ? row
            : { id: row.id, decision: 'review' as const, reason: `两轮意见不一致：${row.reason} / ${reviewer.reason}`.slice(0, 240) };
        });
      };
      const processBatch = async (batch: StudyCandidate[]): Promise<void> => {
        let rows: FilterRow[];
        try { rows = await evaluateBatch(batch); }
        catch (error) {
          if (!(error instanceof HarnessOutputError) || batch.length === 1) throw error;
          const midpoint = Math.ceil(batch.length / 2);
          await processBatch(batch.slice(0, midpoint));
          await processBatch(batch.slice(midpoint));
          return;
        }
        for (const row of rows) decisions[row.id] = { decision: row.decision, reason: row.reason };
        list.workflow = { ...workflow, pendingFilterRun: { tier: request.tier, profileId: request.profileId, concurrency, sourceHash, profileSignature, decisions, stats: { ...stats, elapsedMs: stats.elapsedMs + Date.now() - startedAt } } };
        writeJsonAtomic(this.fileFor(bookId), list);
        emitFilterProgress(rows);
        await new Promise<void>((resolve) => setImmediate(resolve));
      };
      const pendingBatches: StudyCandidate[][] = [];
      for (let offset = 0; offset < source.length; offset += batchSize) {
        if (job.cancelled) throw new Error('已取消 LLM 筛选，原选择未更改');
        const batch = source.slice(offset, offset + batchSize).filter((item) => !decisions[item.id]);
        if (batch.length === 0) {
          emitFilterProgress([], '复用已完成结果');
          continue;
        }
        pendingBatches.push(batch);
      }
      await runConcurrentBatches(pendingBatches, concurrency, processBatch, () => job.controller.abort());
      if (job.cancelled) throw new Error('已取消 LLM 筛选，原选择未更改');
      for (const item of list.candidates) {
        if (decisions[item.id]) item.selected = decisions[item.id]?.decision !== 'reject';
      }
      list.workflow = { ...workflow, filterRun: { tier: request.tier, profileId: request.profileId, concurrency, completedAt: Date.now(), decisions, stats: { ...stats, elapsedMs: stats.elapsedMs + Date.now() - startedAt } }, pendingFilterRun: undefined, partialFilterAppliedAt: undefined, cardRun: undefined, pendingCardRun: undefined };
      writeJsonAtomic(this.fileFor(bookId), list);
      return list;
    } catch (error) {
      list.workflow = { ...workflow, pendingFilterRun: {
        tier: request.tier, profileId: request.profileId, concurrency, sourceHash, profileSignature, decisions,
        stats: { ...stats, elapsedMs: stats.elapsedMs + Date.now() - startedAt },
        lastError: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      } };
      writeJsonAtomic(this.fileFor(bookId), list);
      emitFilterProgress([], '本次中断，已保存进度');
      throw error;
    } finally { this.running.delete(bookId); }
  }

  /** 中断后只使用已判断的候选；未处理项暂不制卡，检查点仍可续跑。 */
  applyCompletedFilter(bookId: string): StudyList {
    if (this.running.has(bookId)) throw new Error('LLM 筛选仍在运行，请先取消或等待完成');
    const list = this.read(bookId);
    const workflow = list?.workflow;
    const decisions = workflow?.pendingFilterRun?.decisions;
    if (!list || !workflow || !decisions || Object.keys(decisions).length === 0) throw new Error('没有可使用的筛选检查点');
    for (const item of directCandidates(list.candidates, workflow.levels, workflow.includeUnknown, workflow.direct)) {
      item.selected = item.forceInclude === true || (!!decisions[item.id] && decisions[item.id]?.decision !== 'reject');
    }
    list.workflow = { ...workflow, filterRun: undefined, partialFilterAppliedAt: Date.now(), cardRun: undefined, pendingCardRun: undefined };
    writeJsonAtomic(this.fileFor(bookId), list);
    return list;
  }

  clearFilterProgress(bookId: string): StudyList {
    if (this.running.has(bookId)) throw new Error('LLM 筛选仍在运行，请先取消');
    const list = this.read(bookId);
    if (!list) throw new Error('请先生成学习候选');
    if (list.workflow) { list.workflow.pendingFilterRun = undefined; list.workflow.partialFilterAppliedAt = undefined; }
    writeJsonAtomic(this.fileFor(bookId), list);
    return list;
  }

  /** 只读取词典和候选的消耗预览，不调用模型或翻译。 */
  async previewCards(bookId: string, tier: string) {
    if (!isPipelineTier(tier)) throw new Error('预算预览仅支持 A0–A4');
    const list = this.read(bookId);
    if (!list) throw new Error('请先生成候选');
    await this.options.ensureDictionary();
    return previewCardPipeline(list, tier, this.options.lookupTerms);
  }

  /** 兼容旧 R 档位，并把新 A 档位交给统一流水线。 */
  async runCards(bookId: string, request: StudyCardRunRequest): Promise<StudyList> {
    if (this.running.has(bookId)) throw new Error('这本书已有学习任务在运行');
    if (isPipelineTier(request.tier)) {
      const list = this.read(bookId);
      if (!list) throw new Error('请先生成学习候选');
      const job = { cancelled: false, controller: new AbortController() };
      this.running.set(bookId, job);
      try {
        return await runCardPipeline({ list, request: { ...request, tier: request.tier }, sourceHash: selectedHash(list),
          llm: this.options.llm, translation: this.options.translation, ensureDictionary: this.options.ensureDictionary,
          lookupTerms: this.options.lookupTerms, signal: job.controller.signal,
          save: () => writeJsonAtomic(this.fileFor(bookId), list), progress: this.options.workflowProgress });
      } finally { this.running.delete(bookId); }
    }
    if (!['R0', 'R1', 'R2', 'R3'].includes(request.tier)) throw new Error('未知制卡档位');
    const translation = this.options.translation;
    if (!translation) throw new Error('翻译服务未就绪');
    const llm = this.options.llm;
    if (request.tier !== 'R0' && (!llm || !request.profileId)) throw new Error('R1–R3 需要选择 LLM 配置');
    const profileSignature = request.profileId ? llm?.profileSignature?.(request.profileId) ?? undefined : undefined;
    const list = this.read(bookId);
    if (!list) throw new Error('请先生成学习候选');
    const selected = selectedCandidates(list);
    if (selected.length === 0) throw new Error('请先在筛选步骤选择候选词');
    const sourceHash = selectedHash(list);
    const concurrency = request.tier === 'R0' ? 1 : normalizeHarnessConcurrency(request.concurrency);
    const prior = list.workflow?.pendingCardRun;
    const resumed = prior?.tier === request.tier &&
      prior.translationProfileId === request.translationProfileId &&
      prior.profileId === (request.tier === 'R0' ? null : request.profileId ?? null) &&
      prior.sourceHash === sourceHash;
    const drafts: StudyCardDraft[] = resumed ? [...prior.drafts] : [];
    const stats: StudyRunStats = resumed && prior.stats ? { ...prior.stats } : { llmCalls: 0, translationCalls: 0, elapsedMs: 0 };
    const startedAt = Date.now();
    const job = { cancelled: false, controller: new AbortController() };
    this.running.set(bookId, job);
    try {
      const translated = new Map<string, { candidate: StudyCandidate; translatedWord: string; translatedSentence: string }>();
      const cardTool = harnessSubmissionTool('card');
      const verifyTool = harnessSubmissionTool('verify');
      const translateItem = async (item: StudyCandidate): Promise<{ candidate: StudyCandidate; translatedWord: string; translatedSentence: string }> => {
        const cached = translated.get(item.id);
        if (cached) return cached;
        const occurrence = chosenOccurrence(item);
        if (!occurrence) throw new Error(`「${item.expression}」没有原文出处`);
        const [word, sentence] = await Promise.all([
          translation.translate({ text: item.expression, profileId: request.translationProfileId, targetLanguage: 'zh-Hans' }),
          translation.translate({ text: occurrence.text, profileId: request.translationProfileId, targetLanguage: 'zh-Hans' }),
        ]);
        stats.translationCalls += 2;
        if (job.cancelled || job.controller.signal.aborted) throw new Error('已取消制卡，旧草稿保持不变');
        if (!word.ok || !sentence.ok) throw new Error(`「${item.expression}」翻译失败：${word.error ?? sentence.error ?? '未知错误'}`);
        const entry = { candidate: item, translatedWord: word.text, translatedSentence: sentence.text };
        translated.set(item.id, entry);
        return entry;
      };
      const evaluateBatch = async (entries: Array<{ candidate: StudyCandidate; translatedWord: string; translatedSentence: string }>): Promise<StudyCardDraft[]> => {
        if (request.tier === 'R0') return entries.map(({ candidate, translatedWord, translatedSentence }) => ({
          candidateId: candidate.id, meaning: translatedWord, sentenceTranslation: translatedSentence,
          usage: '', nuance: '', needsReview: false, reviewReason: '',
        }));
        if (!llm) throw new Error('LLM 制卡服务未就绪');
        const result = await llm.complete({ profileId: request.profileId, expectedProfileSignature: profileSignature, ...cardHarnessPrompt(request.tier, entries), tool: cardTool, temperature: 0.1, signal: job.controller.signal });
        recordLlmResult(stats, result);
        if (job.cancelled || job.controller.signal.aborted) throw new Error('已取消制卡，旧草稿保持不变');
        if (!result.ok) throw batchFailure('LLM 制卡失败', result.error, entries.length);
        const ids = entries.map(({ candidate }) => candidate.id);
        const generated = parseCardBatchResponse(result.text, ids);
        const byId = new Map(generated.map((draft) => {
          const entry = entries.find(({ candidate }) => candidate.id === draft.candidateId)!;
          const longContext = (chosenOccurrence(entry.candidate)?.text.length ?? 0) > MAX_HARNESS_CONTEXT_CHARS;
          const longTranslation = entry.translatedSentence.length > MAX_HARNESS_TRANSLATION_CHARS;
          if (!longContext && !longTranslation) return [draft.candidateId, draft] as const;
          const reason = [draft.reviewReason, longContext ? '原文仅截取了目标词附近 320 字' : '', longTranslation ? '句译过长已截断' : ''].filter(Boolean).join('；');
          return [draft.candidateId, { ...draft, needsReview: true, reviewReason: reason }] as const;
        }));
        if (request.tier !== 'R3') return ids.map((id) => byId.get(id)!);
        const checked = await llm.complete({ profileId: request.profileId, expectedProfileSignature: profileSignature, ...verifyCardPrompt(entries.map(({ candidate }) => ({ candidate, draft: byId.get(candidate.id)! }))), tool: verifyTool, temperature: 0.1, signal: job.controller.signal });
        recordLlmResult(stats, checked);
        if (job.cancelled || job.controller.signal.aborted) throw new Error('已取消制卡，旧草稿保持不变');
        if (!checked.ok) throw batchFailure('LLM 复核失败', checked.error, entries.length);
        const verdicts = new Map(parseVerifyBatchResponse(checked.text, ids).map((verdict) => [verdict.id, verdict]));
        return ids.map((id) => {
          const draft = byId.get(id)!;
          const verdict = verdicts.get(id)!;
          return verdict.approved ? draft : { ...draft, needsReview: true, reviewReason: verdict.reason || '复核未通过' };
        });
      };
      const processBatch = async (batch: StudyCandidate[]): Promise<void> => {
        if (job.cancelled || job.controller.signal.aborted) throw new Error('已取消制卡，旧草稿保持不变');
        const entries = [];
        for (const item of batch) entries.push(await translateItem(item));
        let produced: StudyCardDraft[];
        try { produced = await evaluateBatch(entries); }
        catch (error) {
          if (!(error instanceof HarnessOutputError) || batch.length === 1) throw error;
          const midpoint = Math.ceil(batch.length / 2);
          await processBatch(batch.slice(0, midpoint));
          await processBatch(batch.slice(midpoint));
          return;
        }
        drafts.push(...produced);
        list.workflow = { ...(list.workflow ?? defaultStudyWorkflow()), pendingCardRun: {
          tier: request.tier, profileId: request.tier === 'R0' ? null : request.profileId ?? null,
          translationProfileId: request.translationProfileId, concurrency, sourceHash, drafts,
          stats: { ...stats, elapsedMs: stats.elapsedMs + Date.now() - startedAt },
        } };
        writeJsonAtomic(this.fileFor(bookId), list);
        this.options.workflowProgress?.({ bookId, stage: 'cards', done: drafts.length, total: selected.length, message: `完成 ${produced.length} 张` });
        await new Promise<void>((resolve) => setImmediate(resolve));
      };
      const batchSize = CARD_TIERS[request.tier].batchSize;
      const pendingBatches: StudyCandidate[][] = [];
      for (let offset = 0; offset < selected.length; offset += batchSize) {
        if (job.cancelled) throw new Error('已取消制卡，旧草稿保持不变');
        const batch = selected.slice(offset, offset + batchSize).filter((item) => !drafts.some((draft) => draft.candidateId === item.id));
        if (batch.length === 0) {
          this.options.workflowProgress?.({ bookId, stage: 'cards', done: Math.min(offset + batchSize, selected.length), total: selected.length, message: '复用已完成草稿' });
          continue;
        }
        pendingBatches.push(batch);
      }
      await runConcurrentBatches(pendingBatches, concurrency, processBatch, () => job.controller.abort());
      if (job.cancelled) throw new Error('已取消制卡，旧草稿保持不变');
      const order = new Map(selected.map((item, index) => [item.id, index]));
      drafts.sort((a, b) => (order.get(a.candidateId) ?? 0) - (order.get(b.candidateId) ?? 0));
      list.workflow = { ...(list.workflow ?? defaultStudyWorkflow()), cardRun: {
        tier: request.tier, profileId: request.tier === 'R0' ? null : request.profileId ?? null,
        translationProfileId: request.translationProfileId, concurrency, completedAt: Date.now(), sourceHash, drafts,
        stats: { ...stats, elapsedMs: stats.elapsedMs + Date.now() - startedAt },
      }, pendingCardRun: undefined };
      writeJsonAtomic(this.fileFor(bookId), list);
      return list;
    } catch (error) {
      list.workflow = { ...(list.workflow ?? defaultStudyWorkflow()), pendingCardRun: {
        tier: request.tier, profileId: request.tier === 'R0' ? null : request.profileId ?? null,
        translationProfileId: request.translationProfileId, concurrency, sourceHash, drafts,
        stats: { ...stats, elapsedMs: stats.elapsedMs + Date.now() - startedAt },
        lastError: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      } };
      writeJsonAtomic(this.fileFor(bookId), list);
      throw error;
    } finally { this.running.delete(bookId); }
  }

  /** 配图独立于 AI 生成与制卡档位；更改它不丢弃已有草稿。 */
  setImageMode(bookId: string, mode: StudyImageMode): StudyList {
    if (this.running.has(bookId)) throw new Error('学习任务正在运行，请稍后修改配图');
    if (mode !== 'none' && mode !== 'crop' && mode !== 'page') throw new Error('未知漫画配图方式');
    const list = this.read(bookId);
    if (!list) throw new Error('请先生成学习候选');
    list.workflow = { ...(list.workflow ?? defaultStudyWorkflow()), imageMode: mode };
    writeJsonAtomic(this.fileFor(bookId), list);
    return list;
  }

  /** 人工修正卡面与原文出处；不修改候选身份和既有 LLM 草稿进度。 */
  patchCard(bookId: string, candidateId: string, patch: StudyCardPatch): StudyList {
    if (this.running.has(bookId)) throw new Error('正在制卡，请稍后审核');
    const list = this.read(bookId);
    const draft = list?.workflow?.cardRun?.drafts.find((item) => item.candidateId === candidateId);
    if (!list || !draft) throw new Error('找不到制卡草稿');
    const candidate = list.candidates.find((item) => item.id === candidateId);
    if (!candidate) throw new Error('词卡候选已失效');
    if (patch.contextRef !== undefined) {
      if (!candidate.occurrences.some((one) => one.id === patch.contextRef)) throw new Error('词卡出处不属于该词');
      if (patch.contextRef !== (draft.contextRef ?? candidate.contextRef)) {
        draft.manuallyApproved = false;
        Object.assign(draft, withIssues(draft, [{ field: 'sentence', code: 'changed', reason: '原图出处已更换，请核对新原句的词义与句译' }]));
      }
      draft.contextRef = patch.contextRef;
    }
    for (const key of ['expression', 'reading', 'sentence', 'sourceLabel', 'meaning', 'sentenceTranslation', 'usage', 'nuance'] as const) {
      if (typeof patch[key] !== 'string') continue;
      const value = patch[key]!.trim().slice(0, key === 'sentence' ? 5000 : key === 'sourceLabel' ? 300 : 1000);
      if ((key === 'expression' || key === 'sentence') && !value) throw new Error('词语和原句不能为空');
      draft[key] = value;
    }
    const missingReading = isPipelineTier(list.workflow!.cardRun!.tier) && /[\p{Script=Han}]/u.test(draft.expression ?? candidate.expression) && !(draft.reading ?? candidate.reading).trim();
    if (isPipelineTier(list.workflow!.cardRun!.tier) && missingReading) {
      Object.assign(draft, withIssues(draft, [...(draft.issues ?? []), { field: 'reading', code: 'missing', reason: '请补全汉字词的读音后再通过审核' }]));
    }
    if (patch.needsReview === false && !missingReading && draft.meaning && (list.workflow?.cardRun?.tier === 'A0' || draft.sentenceTranslation)) {
      draft.needsReview = false;
      draft.reviewReason = '';
      draft.issues = [];
      draft.status = 'ready';
      draft.manuallyApproved = true;
    }
    writeJsonAtomic(this.fileFor(bookId), list);
    return list;
  }

  /** 第五步：依配图选项组装媒体；不调用翻译或 LLM。 */
  async exportPackage(bookId: string, targetPath: string): Promise<number> {
    if (this.running.has(bookId)) throw new Error('学习任务仍在运行');
    const list = this.read(bookId);
    const book = this.options.getBook(bookId);
    const run = list?.workflow?.cardRun;
    if (!list || !book || !run) throw new Error('请先运行制卡 Harness');
    const segments = this.options.getSegments(bookId);
    if (segments && segments.generatedAt !== list.segmentGeneratedAt) throw new Error('原文分词已更新，请重新生成候选和词卡');
    if (run.sourceHash !== selectedHash(list)) throw new Error('候选已变化，请重新制作词卡');
    if (!isPipelineTier(run.tier) && run.drafts.some((item) => item.needsReview)) throw new Error('还有存疑词卡，请先审核');
    const byId = new Map(selectedCandidates(list).map((item) => [item.id, item]));
    if (run.drafts.length !== byId.size) throw new Error('制卡草稿与候选数量不一致');
    if (new Set(run.drafts.map(d => d.candidateId)).size !== byId.size || run.drafts.some(d => !byId.has(d.candidateId))) throw new Error('制卡草稿 ID 与候选不一致');
    const exportDrafts = isPipelineTier(run.tier) ? run.drafts.filter(d => readyDraft(d, run.tier)) : run.drafts;
    if (!exportDrafts.length) throw new Error('没有已通过的词卡，请先处理待审或暂缓项');
    const imageMode = list.workflow?.imageMode ?? 'crop';
    const crop = this.options.crop ?? cropStudyOccurrence;
    const pageImage = this.options.pageImage ?? pageStudyOccurrence;
    const pageCache = new Map<string, StudyCrop>();
    const inputs = [];
    for (let index = 0; index < exportDrafts.length; index += 1) {
      const draft = exportDrafts[index]!;
      const candidate = byId.get(draft.candidateId);
      const occurrence = candidate && (candidate.occurrences.find((one) => one.id === draft.contextRef) ?? chosenOccurrence(candidate));
      if (!candidate || !occurrence) throw new Error('制卡草稿的原文出处已失效');
      if (imageMode === 'none') {
        inputs.push({ candidate, draft });
      } else {
        let image: StudyCrop;
        if (imageMode === 'crop') image = crop(bookId, occurrence);
        else {
          const pageKey = occurrence.ref.slice(0, occurrence.ref.lastIndexOf('#'));
          const cached = pageCache.get(pageKey);
          if (cached && !this.options.pageImage) sourcePage(bookId, occurrence);
          image = cached ?? pageImage(bookId, occurrence);
          pageCache.set(pageKey, image);
        }
        inputs.push({ candidate, draft, imageName: image.name, image: image.data });
      }
      this.options.workflowProgress?.({ bookId, stage: 'export', done: index + 1, total: exportDrafts.length });
    }
    const content = await buildAnkiPackage(bookId, book.title, run.tier, inputs);
    writeFileAtomic(targetPath, content);
    const now = Date.now();
    const exportedIds = new Set(exportDrafts.map(d => d.candidateId));
    for (const item of selectedCandidates(list)) if (exportedIds.has(item.id)) item.exportedAt = now;
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

/** 逻辑 Harness 调用与真实 HTTP 尝试分开计数；不保存原始提示词或响应。 */
function recordLlmResult(stats: StudyRunStats, result: LlmAnalyzeResult): void {
  stats.llmCalls += 1;
  if (result.responseMode) {
    const modes = stats.responseModes ?? {};
    modes[result.responseMode] = (modes[result.responseMode] ?? 0) + 1;
    stats.responseModes = modes;
  }
  if (result.httpAttempts !== undefined) stats.llmHttpAttempts = (stats.llmHttpAttempts ?? 0) + result.httpAttempts;
  if (result.fallbackCount !== undefined) stats.llmFallbacks = (stats.llmFallbacks ?? 0) + result.fallbackCount;
  if (result.usage?.promptTokens !== undefined) stats.promptTokens = (stats.promptTokens ?? 0) + result.usage.promptTokens;
  if (result.usage?.completionTokens !== undefined) stats.completionTokens = (stats.completionTokens ?? 0) + result.usage.completionTokens;
  if (result.usage?.cacheHitTokens !== undefined && result.usage.cacheMissTokens !== undefined) {
    stats.cacheHitTokens = (stats.cacheHitTokens ?? 0) + result.usage.cacheHitTokens;
    stats.cacheMissTokens = (stats.cacheMissTokens ?? 0) + result.usage.cacheMissTokens;
    stats.cacheReportedCalls = (stats.cacheReportedCalls ?? 0) + 1;
  }
}

/** 小模型上下文不够时缩批；鉴权、网络故障等原样报错，避免无意义重试。 */
function batchFailure(label: string, reason: string | undefined, count: number): Error {
  const detail = reason ?? '未知错误';
  const message = `${label}：${detail}`;
  return count > 1 && /context.{0,25}(length|window|limit|exceed)|context_length_exceeded|prompt.{0,20}too long|token.{0,20}limit|上下文.{0,20}(过长|超限|长度)|HTTP 413/i.test(detail)
    ? new HarnessOutputError(message) : new Error(message);
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
  const kanaFallback = matchingExpression.find(item => !item.term.reading && normalizeReading(item.term.expression) === normalizeReading(reading));
  if (reading && !exact && !kanaFallback) return '';
  return plainGlossary((exact ?? kanaFallback ?? matchingExpression[0])?.term.glossary).slice(0, 1000);
}
