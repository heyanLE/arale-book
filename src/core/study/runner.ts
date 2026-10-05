/** A 档位的主进程编排：按证据生成、有限修复、预算和逐批检查点。 */
import { createHash } from '../util/hash';
import type { DictTerm, SegmentUnit, StudyCardDraft, StudyCardField, StudyCardIssue, StudyCardRunRequest, StudyDictionaryEvidence, StudyList, StudyPipelineCheckpoint, StudyPipelinePreview, StudyPipelineTier, StudyRunProgress, StudyRunStats } from '../../shared/types';
import { defaultStudyWorkflow, HarnessOutputError, studyPriorityScore } from './harness';
import { adjacentContext, dictionaryEvidence, estimatePromptTokens, needsLlm, needsSemanticGeneration, needsTranslation, normalizeCardFields, shouldGenerate, selectedSourceIssues, parsePipelineCards,
  pipelineOutputLimit, pipelinePrompt, pipelineTool, recoverPipelineCards,
  selectOccurrence, sourceIssues, validOccurrence, withIssues, type PipelineInput } from './pipeline';
import { normalizeReading } from './jlpt';
import { translatedWordReading } from './reading';
import type { LlmService } from '../services/llm';
import type { TranslationService } from '../services/translation';
import { normalizeHarnessConcurrency, runConcurrentBatches } from './concurrency';

interface Options {
  list: StudyList;
  request: StudyCardRunRequest & { tier: StudyPipelineTier };
  sourceHash: string;
  units?: readonly SegmentUnit[];
  ensureDictionary(): Promise<unknown>;
  lookupTerms?(expression: string): DictTerm[];
  llm?: Pick<LlmService, 'complete'> & Partial<Pick<LlmService, 'profileSignature'>>;
  translation?: Pick<TranslationService, 'translate'> & Partial<Pick<TranslationService, 'profileSignature'>>;
  signal: AbortSignal;
  save(): void;
  progress?(progress: StudyRunProgress): void;
}
class BudgetStop extends Error {}
class OutputTruncated extends HarnessOutputError {
  constructor(readonly text: string) { super('输出 token limit：模型答案被截断'); }
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function addUsage(stats: StudyRunStats, result: Awaited<ReturnType<LlmService['complete']>>): void {
  stats.llmCalls++;
  stats.llmHttpAttempts = (stats.llmHttpAttempts ?? 0) + (result.httpAttempts ?? 1);
  stats.llmFallbacks = (stats.llmFallbacks ?? 0) + (result.fallbackCount ?? 0);
  if (result.usage?.promptTokens !== undefined) stats.promptTokens = (stats.promptTokens ?? 0) + result.usage.promptTokens;
  if (result.usage?.completionTokens !== undefined) stats.completionTokens = (stats.completionTokens ?? 0) + result.usage.completionTokens;
  if (result.usage?.cacheHitTokens !== undefined && result.usage.cacheMissTokens !== undefined) {
    stats.cacheHitTokens = (stats.cacheHitTokens ?? 0) + result.usage.cacheHitTokens;
    stats.cacheMissTokens = (stats.cacheMissTokens ?? 0) + result.usage.cacheMissTokens;
    stats.cacheReportedCalls = (stats.cacheReportedCalls ?? 0) + 1;
  }
  if (result.responseMode) { stats.responseModes ??= {}; stats.responseModes[result.responseMode] = (stats.responseModes[result.responseMode] ?? 0) + 1; }
}

/** 当前已启用词典的预算预览；不修改词单，不产生外部请求。 */
export function previewCardPipeline(list: StudyList, tier: StudyPipelineTier, lookupTerms?: (word: string) => DictTerm[], units: readonly SegmentUnit[] = [], requestedFields?: StudyCardField[]): StudyPipelinePreview {
  const fields = normalizeCardFields(requestedFields, tier);
  const selected = list.candidates.filter(c => c.selected && !c.excluded);
  const inputs = selected.flatMap(original => {
    const evidence = dictionaryEvidence(lookupTerms?.(original.expression) ?? [], original);
    const candidate = { ...original };
    const readings = [...new Set(evidence.map(e => normalizeReading(e.reading)).filter(Boolean))];
    if (!candidate.reading && readings.length === 1) candidate.reading = readings[0]!;
    if (!candidate.reading && /^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u.test(candidate.expression)) candidate.reading = normalizeReading(candidate.expression);
    const occurrence = selectOccurrence(candidate);
    return occurrence && validOccurrence(occurrence) ? [{ candidate, occurrence, evidence, fields, tier, ...(['A3', 'A4'].includes(tier) ? { context: adjacentContext(occurrence, units) } : {}) }] : [];
  });
  const semantic = inputs.filter(i => shouldGenerate(i, tier));
  const translations = needsTranslation(tier, fields) ? new Set(inputs.flatMap(i => [
    ...(fields.includes('sentenceTranslation') || (['A3', 'A4'].includes(tier) && semantic.includes(i)) ? [i.occurrence.text] : []),
    ...(fields.includes('reading') && !i.candidate.reading ? [i.candidate.expression] : []),
  ])).size : 0;
  let inputTokens = 0, outputTokenLimit = 0;
  for (let index = 0; index < semantic.length; index += 6) {
    const batch = semantic.slice(index, index + 6);
    const prompt = pipelinePrompt(batch, tier);
    inputTokens += estimatePromptTokens(prompt.system, prompt.user, pipelineTool().parameters);
    outputTokenLimit += pipelineOutputLimit(tier);
  }
  return { selected: selected.length, aiItems: semantic.length, translationSentences: translations,
    baseCalls: Math.ceil(semantic.length / 6), estimatedInputTokens: inputTokens, outputTokenLimit,
    riskItems: semantic.filter(i => needsSemanticGeneration(i.candidate, i.evidence, i.occurrence)).length };
}

export async function runCardPipeline(options: Options): Promise<StudyList> {
  const { list, request, signal } = options;
  const { tier } = request;
  const fields = normalizeCardFields(request.fields, tier);
  const usesLlm = needsLlm(tier, fields);
  const usesTranslation = needsTranslation(tier, fields) && (!['A3', 'A4'].includes(tier) || !!request.translationProfileId);
  const selected = list.candidates.filter(c => c.selected && !c.excluded);
  if (!selected.length) throw new Error('请先选择要制卡的词');
  if (usesLlm && (!options.llm || !request.profileId)) throw new Error('生成本词含义的 A2–A4 需要选择 LLM 配置');
  if (usesTranslation && (!options.translation || !request.translationProfileId)) throw new Error('当前字段与档位需要选择翻译配置');
  const tokenBudget = request.tokenBudget == null ? null : request.tokenBudget;
  if (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1000)) throw new Error('token 预算必须为至少 1000 的整数，或留空不限');
  const newCardLimit = request.newCardLimit ?? null;
  if (newCardLimit !== null && (!Number.isSafeInteger(newCardLimit) || newCardLimit < 1 || newCardLimit > 10000)) throw new Error('新增卡数必须为 1–10000 的整数，或留空不限');
  const llmSignature = usesLlm ? options.llm?.profileSignature?.(request.profileId!) : null;
  const translationSignature = usesTranslation ? options.translation?.profileSignature?.(request.translationProfileId) : null;
  if (usesLlm && options.llm?.profileSignature && !llmSignature) throw new Error('LLM 配置不存在');
  if (usesTranslation && options.translation?.profileSignature && !translationSignature) throw new Error('翻译配置不存在');
  await options.ensureDictionary();
  signal.throwIfAborted();
  const evidence: Record<string, StudyDictionaryEvidence[]> = {};
  const inputs: PipelineInput[] = [];
  const invalid: StudyCardDraft[] = [];
  for (const original of selected) {
    const terms = options.lookupTerms?.(original.expression) ?? [];
    evidence[original.id] = dictionaryEvidence(terms, original);
    const candidate = { ...original };
    const readings = [...new Set(evidence[original.id]!.map(e => normalizeReading(e.reading)).filter(Boolean))];
    if (!candidate.reading && readings.length === 1) candidate.reading = readings[0]!;
    if (!candidate.reading && /^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u.test(candidate.expression)) candidate.reading = normalizeReading(candidate.expression);
    const occurrence = selectOccurrence(candidate);
    if (!occurrence || !validOccurrence(occurrence)) {
      invalid.push(withIssues({ candidateId: candidate.id, fields, lemma: fields.includes('lemma') ? candidate.expression : '', reading: fields.includes('reading') ? candidate.reading : '', meaning: '', sentenceTranslation: '', usage: '', nuance: '', needsReview: true, reviewReason: '' }, sourceIssues(candidate, occurrence), true));
    } else inputs.push({ candidate, occurrence, evidence: evidence[original.id]!, fields, tier, ...(['A3', 'A4'].includes(tier) ? { context: adjacentContext(occurrence, options.units ?? []) } : {}) });
  }
  const planHash = digest({ version: 3, tier, fields, sourceHash: options.sourceHash, llmSignature, translationSignature,
    profileId: usesLlm ? request.profileId : null, translationProfileId: usesTranslation ? request.translationProfileId : null,
    evidence, contexts: inputs.map(i => i.context ? [i.candidate.id, i.occurrence.id, i.context] : [i.candidate.id, i.occurrence.id]) });
  const pending = list.workflow?.pendingCardRun;
  if (pending?.drafts.length && pending.pipeline?.planHash !== planHash && !request.restart) {
    throw new Error('旧释义检查点与档位、模型、词典或原句不一致；请明确放弃旧检查点后重新生成');
  }
  const prior = request.restart ? undefined : (pending?.pipeline?.planHash === planHash ? pending
    : list.workflow?.cardRun?.pipeline?.planHash === planHash ? list.workflow.cardRun : undefined);
  const state: StudyPipelineCheckpoint = prior?.pipeline ? { ...prior.pipeline, tokenBudget, newCardLimit,
    sentenceTranslations: { ...prior.pipeline.sentenceTranslations }, sourceReadings: { ...prior.pipeline.sourceReadings } } : {
    version: 1, planHash, tokenBudget, newCardLimit, budgetUsed: 0, evidence, fields, sentenceTranslations: {}, sourceReadings: {} };
  const drafts = new Map<string, StudyCardDraft>((prior?.drafts ?? []).filter(d => d.status !== 'deferred').map(d => [d.candidateId, d]));
  for (const draft of invalid) drafts.set(draft.candidateId, draft);
  const stats: StudyRunStats = prior?.stats ? { ...prior.stats, responseModes: { ...prior.stats.responseModes } } : { llmCalls: 0, translationCalls: 0, elapsedMs: 0 };
  const started = Date.now();
  const concurrency = !usesLlm || tokenBudget !== null ? 1 : normalizeHarnessConcurrency(request.concurrency);
  const orderedDrafts = (): StudyCardDraft[] => selected.flatMap(c => drafts.has(c.id) ? [drafts.get(c.id)!] : []);
  const metadata = () => ({ tier, profileId: usesLlm ? request.profileId! : null,
    translationProfileId: usesTranslation ? request.translationProfileId : '', concurrency, sourceHash: options.sourceHash,
    drafts: orderedDrafts(), stats: { ...stats, elapsedMs: stats.elapsedMs + Date.now() - started }, pipeline: state });
  const persist = (message?: string): void => {
    list.workflow = { ...(list.workflow ?? defaultStudyWorkflow()), pendingCardRun: metadata() };
    options.save();
    options.progress?.({ bookId: list.bookId, stage: 'cards', done: drafts.size, total: selected.length, message });
  };
  const checkConfig = (): void => {
    signal.throwIfAborted();
    if (llmSignature && options.llm?.profileSignature?.(request.profileId!) !== llmSignature) throw new Error('LLM 配置已变化，请停止并重新生成');
    if (translationSignature && options.translation?.profileSignature?.(request.translationProfileId) !== translationSignature) throw new Error('翻译配置已变化，请停止并重新生成');
  };
  const callLlm = async (prompt: { system: string; user: string }, count: number, verify = false, expanded = false): Promise<string> => {
    checkConfig();
    const tool = pipelineTool(verify);
    const inputEstimate = estimatePromptTokens(prompt.system, prompt.user, tool.parameters);
    const outputLimit = Math.min(65536, pipelineOutputLimit(tier, verify) * (expanded ? 2 : 1));
    const estimate = inputEstimate + outputLimit;
    if (tokenBudget !== null && state.budgetUsed + estimate > tokenBudget) throw new BudgetStop('剩余预算不足以完成下一次请求');
    const result = await options.llm!.complete({ profileId: request.profileId, expectedProfileSignature: llmSignature ?? undefined,
      ...prompt, tool, temperature: 0.1, signal, maxOutputTokens: outputLimit,
      ...(tokenBudget !== null ? { tokenAllowance: tokenBudget - state.budgetUsed } : {}) });
    addUsage(stats, result);
    const actual = result.usage?.promptTokens !== undefined && result.usage.completionTokens !== undefined
      ? result.usage.promptTokens + result.usage.completionTokens : undefined;
    // usage 缺失/不完整时保守计入每次 HTTP 的输入和输出上限，不能把未知当零。
    const charged = result.budgetTokens ?? actual ?? estimate * (result.httpAttempts ?? 1);
    state.budgetUsed += charged;
    stats.estimatedTokens = (stats.estimatedTokens ?? 0) + Math.max(0, charged - (actual ?? 0));
    persist('已保存调用用量');
    checkConfig();
    if (!result.ok) {
      if (result.truncatedText !== undefined || /^输出 token limit/.test(result.error ?? '')) throw new OutputTruncated(result.truncatedText ?? '');
      if (/token budget/i.test(result.error ?? '')) throw new BudgetStop('格式重试已达到预算');
      if (/context.{0,25}(length|window|limit|exceed)|context_length_exceeded|token.{0,20}limit|上下文.{0,20}(过长|超限)|HTTP 413/i.test(result.error ?? '')) throw new HarnessOutputError(result.error!);
      throw new Error(result.error ?? '词卡生成失败');
    }
    return result.text;
  };
  const sentenceRequests = new Map<string, Promise<string>>();
  const translateSentence = async (text: string): Promise<string> => {
    const key = digest(text);
    if (state.sentenceTranslations[key] !== undefined) return state.sentenceTranslations[key]!;
    const inFlight = sentenceRequests.get(key);
    if (inFlight) return inFlight;
    const promise = (async () => {
      checkConfig();
      const result = await options.translation!.translate({ text, profileId: request.translationProfileId, targetLanguage: 'zh-Hans' });
      stats.translationCalls++;
      checkConfig();
      if (!result.ok || !result.text.trim()) throw new Error(result.error ?? '句译失败');
      state.sentenceTranslations[key] = result.text;
      state.sourceReadings ??= {};
      state.sourceReadings[key] = result.sourceReading;
      persist('译文与原文读音已保存');
      return result.text;
    })();
    sentenceRequests.set(key, promise);
    return promise;
  };
  const prepare = async (input: PipelineInput): Promise<void> => {
    if (!usesTranslation) return;
    if (fields.includes('sentenceTranslation') || (['A3', 'A4'].includes(tier) && shouldGenerate(input, tier))) {
      input.sentenceTranslation = await translateSentence(input.occurrence.text);
      input.sourceReading = state.sourceReadings?.[digest(input.occurrence.text)] ?? '';
    }
    if (fields.includes('reading') && !input.candidate.reading) {
      const word = input.candidate.expression;
      await translateSentence(word); // 仅缺读音时请求辞书形，绝不从整句罗马音猜词位。
      const reading = translatedWordReading(word, word, word, state.sourceReadings?.[digest(word)] ?? '');
      if (reading) { input.candidate.reading = reading; derivedReadings.add(input.candidate.id); }
    }
  };
  const derivedReadings = new Set<string>();
  const localDraft = async (input: PipelineInput): Promise<StudyCardDraft> => {
    const { candidate, occurrence, evidence: rows } = input;
    const issues = selectedSourceIssues(input);
    if (fields.includes('meaning') && !rows.length) issues.push({ field: 'meaning', code: 'missing', reason: '已启用词典未提供匹配释义；可手动导入词典或补充词义' });
    if (fields.includes('meaning') && rows.some(e => e.truncated)) issues.push({ field: 'meaning', code: 'context', reason: '词典释义已截断，请核对完整含义' });
    if (fields.includes('sentenceTranslation') && !input.sentenceTranslation) issues.push({ field: 'sentenceTranslation', code: 'missing', reason: tier === 'A0' ? '缺少句译；A0 不产生外部翻译请求' : '缺少句译，请选择翻译配置或手动补充' });
    return withIssues({ candidateId: candidate.id, contextRef: occurrence.id, reading: candidate.reading,
      meaning: fields.includes('meaning') ? [...new Set(rows.map(e => e.text))].join('\n') : '', sentenceTranslation: fields.includes('sentenceTranslation') ? input.sentenceTranslation ?? '' : '',
      usage: '', nuance: '', evidenceIds: rows.map(e => e.id), needsReview: false, reviewReason: '', referenceOnly: true }, issues);
  };
  const finalize = (input: PipelineInput, draft: StudyCardDraft): StudyCardDraft => {
    const filterDecision = list.workflow?.filterRun?.decisions[input.candidate.id] ?? list.workflow?.pendingFilterRun?.decisions[input.candidate.id];
    const issues = [...(draft.issues ?? [])].filter(i => fields.includes(i.field as StudyCardField) || (i.field === 'sentence' && fields.includes('meaning')) || i.code === 'budget' || i.code === 'limit');
    if (fields.includes('meaning') && filterDecision?.decision === 'review' && !input.candidate.forceInclude) issues.push({ field: 'meaning', code: 'ambiguous', reason: `选词仍存疑：${filterDecision.reason}` });
    const result = withIssues({ ...draft, fields, expression: input.occurrence.text.slice(input.occurrence.start, input.occurrence.end),
      lemma: fields.includes('lemma') ? input.candidate.expression : '',
      sentence: fields.includes('sentence') ? input.occurrence.text : '',
      meaning: fields.includes('meaning') ? draft.meaning : '',
      sentenceTranslation: fields.includes('sentenceTranslation') ? draft.sentenceTranslation : '',
      reading: fields.includes('reading') ? input.candidate.reading : '',
      readingSource: derivedReadings.has(input.candidate.id) ? 'translation_romaji' : input.evidence.some(e => normalizeReading(e.reading) === input.candidate.reading) ? 'dictionary' : 'tokenizer',
      meaningSource: draft.referenceOnly ? 'dictionary' : 'ai', contextRef: draft.contextRef ?? input.occurrence.id }, issues, draft.status === 'deferred');
    return result;
  };
  const repairDraft = async (input: PipelineInput, previous: StudyCardDraft): Promise<StudyCardDraft> => {
    for (const expanded of [false, true]) {
      try {
        return parsePipelineCards(await callLlm(pipelinePrompt([input], tier, [previous]), 1, false, expanded), [input])[0]!;
      } catch (error) {
        if (!(error instanceof OutputTruncated)) throw error;
        const recovered = recoverPipelineCards(error.text, [input]);
        if (recovered.length) return recovered[0]!;
        if (expanded) throw error;
      }
    }
    throw new OutputTruncated('');
  };
  const processBatch = async (batch: PipelineInput[]): Promise<void> => {
    checkConfig();
    try {
      for (const input of batch) await prepare(input);
      const local = batch.filter(i => !shouldGenerate(i, tier));
      for (const input of local) {
        drafts.set(input.candidate.id, finalize(input, await localDraft(input)));
        persist('词典参考卡已保存');
      }
      const semantic = batch.filter(i => !local.includes(i));
      if (!semantic.length) return;
      let generated: StudyCardDraft[];
      try {
        generated = parsePipelineCards(await callLlm(pipelinePrompt(semantic, tier), semantic.length), semantic);
      } catch (error) {
        if (!(error instanceof OutputTruncated)) throw error;
        generated = recoverPipelineCards(error.text, semantic);
        if (!generated.length && semantic.length === 1) {
          try {
            generated = parsePipelineCards(await callLlm(pipelinePrompt(semantic, tier), 1, false, true), semantic);
          } catch (retryError) {
            if (!(retryError instanceof OutputTruncated)) throw retryError;
            generated = recoverPipelineCards(retryError.text, semantic);
            if (!generated.length) {
              const input = semantic[0]!;
              drafts.set(input.candidate.id, finalize(input, withIssues({ candidateId: input.candidate.id, contextRef: input.occurrence.id,
                meaning: '', sentenceTranslation: '', usage: '', nuance: '', needsReview: true, reviewReason: '' },
                [{ field: 'meaning', code: 'limit', reason: '单卡扩大输出额度后仍截断，未生成完整卡片' }], true)));
              persist('单卡仍截断，已暂缓并继续其它卡'); return;
            }
          }
        }
        persist(`截断响应已恢复 ${generated.length} 张完整草稿，继续校验，其余重新分批`);
      }
      const generatedIds = new Set(generated.map(d => d.candidateId));
      const missing = semantic.filter(i => !generatedIds.has(i.candidate.id));
      generated = generated.map(d => ({ ...d, usage: '', nuance: '' }));
      for (let draft of generated) {
        const original = semantic.find(i => i.candidate.id === draft.candidateId)!;
        const maxRepairs = tier === 'A3' || tier === 'A4' ? 3 : 1;
        const tried = new Set([original.occurrence.id]);
        for (let attempt = 0; attempt < maxRepairs && draft.needsReview && draft.status !== 'deferred'; attempt++) {
          const alternate = tier === 'A3' || tier === 'A4'
            ? selectOccurrence({ ...original.candidate, occurrences: original.candidate.occurrences.filter(o => !tried.has(o.id)) })
            : selectOccurrence(original.candidate, original.occurrence.id);
          if (alternate) tried.add(alternate.id);
          const repairInput = alternate && validOccurrence(alternate) ? { ...original, occurrence: alternate,
            ...(original.context ? { context: adjacentContext(alternate, options.units ?? []) } : {}) } : original;
          const before = digest([draft.meaning, draft.sentenceTranslation, draft.issues]);
          try {
            await prepare(repairInput);
            draft = { ...await repairDraft(repairInput, draft), repairs: attempt + 1, usage: '', nuance: '' };

            if (before === digest([draft.meaning, draft.sentenceTranslation, draft.issues]) && !alternate) break;
          } catch (error) {
            if (error instanceof OutputTruncated) {
              draft = withIssues(draft, [...(draft.issues ?? []), { field: 'meaning', code: 'limit', reason: '扩大输出额度后修复仍截断，保留原草稿，修复未完成' }], true);
            } else {
              if (!(error instanceof BudgetStop)) throw error;
              draft = withIssues(draft, [...(draft.issues ?? []), { field: 'meaning', code: 'budget', reason: '预算不足，自动修复未完成' }], true);
            }
          }
        }
        const used = original.candidate.occurrences.find(o => o.id === draft.contextRef);
        drafts.set(draft.candidateId, finalize(used ? { ...original, occurrence: used } : original, draft));
        persist('已生成并校验词卡');
      }
      // 已恢复草稿经过原有复核/修复并落盘后，仅重跑缺失项，避免重复付费生成。
      const size = Math.max(1, Math.ceil(semantic.length / 2));
      for (let offset = 0; offset < missing.length; offset += size) await processBatch(missing.slice(offset, offset + size));
    } catch (error) {
      if (error instanceof BudgetStop) {
        // 大批预算不足时先拆小，能完成的卡仍生成；单项不足才暂缓。
        const remaining = batch.filter(i => !drafts.has(i.candidate.id));
        if (remaining.length > 1) {
          const middle = Math.ceil(remaining.length / 2);
          await processBatch(remaining.slice(0, middle)); await processBatch(remaining.slice(middle)); return;
        }
        for (const input of remaining) drafts.set(input.candidate.id, finalize(input, withIssues({ candidateId: input.candidate.id, contextRef: input.occurrence.id,
          meaning: '', sentenceTranslation: '', usage: '', nuance: '', needsReview: true, reviewReason: '' },
          [{ field: 'meaning', code: 'budget', reason: '预算不足，尚未生成；提高预算可续跑' }], true)));
        persist('剩余卡已暂缓，已通过卡可导出'); return;
      }
      if (error instanceof HarnessOutputError && batch.length > 1) {
        const remaining = batch.filter(i => !drafts.has(i.candidate.id));
        const middle = Math.ceil(remaining.length / 2);
        if (remaining.length) { await processBatch(remaining.slice(0, middle)); if (remaining.length > middle) await processBatch(remaining.slice(middle)); }
        return;
      }
      throw error;
    }
  };
  persist(prior ? '复用已完成卡片，继续暂缓项' : '已选择例句并读取词典证据');
  try {
    const todo = inputs.filter(i => !drafts.has(i.candidate.id)).sort((a, b) => studyPriorityScore(b.candidate) - studyPriorityScore(a.candidate));
    const picked = newCardLimit === null ? todo : todo.slice(0, newCardLimit);
    if (newCardLimit !== null) for (const input of todo.slice(newCardLimit)) drafts.set(input.candidate.id, finalize(input, withIssues({ candidateId: input.candidate.id,
      contextRef: input.occurrence.id, meaning: '', sentenceTranslation: '', usage: '', nuance: '', needsReview: true, reviewReason: '' },
      [{ field: 'meaning', code: 'limit', reason: '超过本次新增卡数上限，稍后可继续生成' }], true)));
    const batches: PipelineInput[][] = [];
    for (let offset = 0; offset < picked.length; offset += 6) batches.push(picked.slice(offset, offset + 6));
    await runConcurrentBatches(batches, concurrency, processBatch, () => undefined);
    checkConfig();
    list.workflow = { ...(list.workflow ?? defaultStudyWorkflow()), cardRun: { ...metadata(), completedAt: Date.now() }, pendingCardRun: undefined };
    options.save();
    options.progress?.({ bookId: list.bookId, stage: 'cards', done: selected.length, total: selected.length, message: '生成结束；已通过卡可导出，待审与暂缓卡保留' });
    return list;
  } catch (error) {
    list.workflow = { ...(list.workflow ?? defaultStudyWorkflow()), pendingCardRun: { ...metadata(), lastError: (error instanceof Error ? error.message : String(error)).slice(0, 300) } };
    options.save(); throw error;
  }
}
