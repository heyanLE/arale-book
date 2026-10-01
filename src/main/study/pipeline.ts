/** A 档位的主进程编排：按证据生成、有限修复、预算和逐批检查点。 */
import { createHash } from 'node:crypto';
import type { DictTerm, StudyCardDraft, StudyCardIssue, StudyCardRunRequest, StudyDictionaryEvidence, StudyList, StudyPipelineCheckpoint, StudyPipelinePreview, StudyPipelineTier, StudyRunProgress, StudyRunStats } from '../../shared/types';
import { defaultStudyWorkflow, HarnessOutputError, studyPriorityScore } from '../../core/study/harness';
import { dictionaryEvidence, estimatePromptTokens, needsLlm, needsSemanticGeneration, needsTranslation, parsePipelineCards,
  parsePipelineVerification, pipelinePrompt, pipelineTool, pipelineVerifyPrompt, selectOccurrence, sourceIssues, validOccurrence, withIssues, type PipelineInput } from '../../core/study/pipeline';
import { normalizeReading } from '../../core/study/jlpt';
import type { LlmService } from '../llm/service';
import type { TranslationService } from '../translation/service';
import { normalizeHarnessConcurrency, runConcurrentBatches } from './concurrency';

interface Options {
  list: StudyList;
  request: StudyCardRunRequest & { tier: StudyPipelineTier };
  sourceHash: string;
  ensureDictionary(): Promise<unknown>;
  lookupTerms?(expression: string): DictTerm[];
  llm?: Pick<LlmService, 'complete'> & Partial<Pick<LlmService, 'profileSignature'>>;
  translation?: Pick<TranslationService, 'translate'> & Partial<Pick<TranslationService, 'profileSignature'>>;
  signal: AbortSignal;
  save(): void;
  progress?(progress: StudyRunProgress): void;
}
class BudgetStop extends Error {}
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
export function previewCardPipeline(list: StudyList, tier: StudyPipelineTier, lookupTerms?: (word: string) => DictTerm[]): StudyPipelinePreview {
  const selected = list.candidates.filter(c => c.selected && !c.excluded);
  const inputs = selected.flatMap(original => {
    const evidence = dictionaryEvidence(lookupTerms?.(original.expression) ?? [], original);
    const candidate = { ...original };
    const readings = [...new Set(evidence.map(e => normalizeReading(e.reading)).filter(Boolean))];
    if (!candidate.reading && readings.length === 1) candidate.reading = readings[0]!;
    const occurrence = selectOccurrence(candidate);
    return occurrence && validOccurrence(occurrence) ? [{ candidate, occurrence, evidence }] : [];
  });
  const semantic = !needsLlm(tier) ? [] : tier === 'A2' ? inputs.filter(i => needsSemanticGeneration(i.candidate, i.evidence, i.occurrence)) : inputs;
  const translations = needsTranslation(tier) ? new Set(inputs.filter(i => !semantic.includes(i)).map(i => i.occurrence.text)).size : 0;
  let inputTokens = 0, outputTokenLimit = 0;
  for (let index = 0; index < semantic.length; index += 6) {
    const batch = semantic.slice(index, index + 6);
    const prompt = pipelinePrompt(batch, tier);
    inputTokens += estimatePromptTokens(prompt.system, prompt.user, pipelineTool().parameters);
    outputTokenLimit += Math.max(600, batch.length * (tier === 'A4' ? 700 : 500));
  }
  return { selected: selected.length, aiItems: semantic.length, translationSentences: translations,
    baseCalls: Math.ceil(semantic.length / 6), estimatedInputTokens: inputTokens, outputTokenLimit,
    riskItems: tier === 'A4' ? semantic.length : semantic.filter(i => needsSemanticGeneration(i.candidate, i.evidence, i.occurrence)).length };
}

export async function runCardPipeline(options: Options): Promise<StudyList> {
  const { list, request, signal } = options;
  const { tier } = request;
  const selected = list.candidates.filter(c => c.selected && !c.excluded);
  if (!selected.length) throw new Error('请先选择要制卡的词');
  if (needsLlm(tier) && (!options.llm || !request.profileId)) throw new Error('A2–A4 需要选择 LLM 配置');
  if (needsTranslation(tier) && (!options.translation || !request.translationProfileId)) throw new Error('A1/A2 需要选择翻译配置');
  const tokenBudget = request.tokenBudget == null ? null : request.tokenBudget;
  if (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1000)) throw new Error('token 预算必须为至少 1000 的整数，或留空不限');
  const newCardLimit = request.newCardLimit ?? null;
  if (newCardLimit !== null && (!Number.isSafeInteger(newCardLimit) || newCardLimit < 1 || newCardLimit > 10000)) throw new Error('新增卡数必须为 1–10000 的整数，或留空不限');
  const llmSignature = needsLlm(tier) ? options.llm?.profileSignature?.(request.profileId!) : null;
  const translationSignature = needsTranslation(tier) ? options.translation?.profileSignature?.(request.translationProfileId) : null;
  if (needsLlm(tier) && options.llm?.profileSignature && !llmSignature) throw new Error('LLM 配置不存在');
  if (needsTranslation(tier) && options.translation?.profileSignature && !translationSignature) throw new Error('翻译配置不存在');
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
    const occurrence = selectOccurrence(candidate);
    if (!occurrence || !validOccurrence(occurrence)) {
      invalid.push(withIssues({ candidateId: candidate.id, meaning: '', sentenceTranslation: '', usage: '', nuance: '', needsReview: true, reviewReason: '' }, sourceIssues(candidate, occurrence), true));
    } else inputs.push({ candidate, occurrence, evidence: evidence[original.id]! });
  }
  const planHash = digest({ version: 1, tier, sourceHash: options.sourceHash, llmSignature, translationSignature,
    profileId: needsLlm(tier) ? request.profileId : null, translationProfileId: needsTranslation(tier) ? request.translationProfileId : null,
    evidence, contexts: inputs.map(i => [i.candidate.id, i.occurrence.id]) });
  const pending = list.workflow?.pendingCardRun;
  if (pending?.drafts.length && pending.pipeline?.planHash !== planHash && !request.restart) {
    throw new Error('旧释义检查点与档位、模型、词典或原句不一致；请明确放弃旧检查点后重新生成');
  }
  const prior = request.restart ? undefined : (pending?.pipeline?.planHash === planHash ? pending
    : list.workflow?.cardRun?.pipeline?.planHash === planHash ? list.workflow.cardRun : undefined);
  const state: StudyPipelineCheckpoint = prior?.pipeline ? { ...prior.pipeline, tokenBudget, newCardLimit,
    sentenceTranslations: { ...prior.pipeline.sentenceTranslations } } : {
    version: 1, planHash, tokenBudget, newCardLimit, budgetUsed: 0, evidence, sentenceTranslations: {} };
  const drafts = new Map<string, StudyCardDraft>((prior?.drafts ?? []).filter(d => d.status !== 'deferred').map(d => [d.candidateId, d]));
  for (const draft of invalid) drafts.set(draft.candidateId, draft);
  const stats: StudyRunStats = prior?.stats ? { ...prior.stats, responseModes: { ...prior.stats.responseModes } } : { llmCalls: 0, translationCalls: 0, elapsedMs: 0 };
  const started = Date.now();
  const concurrency = !needsLlm(tier) || tokenBudget !== null ? 1 : normalizeHarnessConcurrency(request.concurrency);
  const orderedDrafts = (): StudyCardDraft[] => selected.flatMap(c => drafts.has(c.id) ? [drafts.get(c.id)!] : []);
  const metadata = () => ({ tier, profileId: needsLlm(tier) ? request.profileId! : null,
    translationProfileId: needsTranslation(tier) ? request.translationProfileId : '', concurrency, sourceHash: options.sourceHash,
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
  const callLlm = async (prompt: { system: string; user: string }, count: number, verify = false): Promise<string> => {
    checkConfig();
    const tool = pipelineTool(verify);
    const inputEstimate = estimatePromptTokens(prompt.system, prompt.user, tool.parameters);
    const outputLimit = Math.max(600, count * (verify ? 240 : tier === 'A4' ? 700 : 500));
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
      return result.text;
    })();
    sentenceRequests.set(key, promise);
    return promise;
  };
  const localDraft = async (input: PipelineInput): Promise<StudyCardDraft> => {
    const { candidate, occurrence, evidence: rows } = input;
    const issues = sourceIssues(candidate, occurrence);
    if (!rows.length) issues.push({ field: 'meaning', code: 'missing', reason: '已启用词典未提供匹配释义；可手动导入词典或补充词义' });
    if (rows.length > 1 || rows.some(e => e.ambiguous || e.truncated)) issues.push({ field: 'meaning', code: 'ambiguous', reason: '词典有多个义项或证据不完整，请确认本句词义' });
    return withIssues({ candidateId: candidate.id, contextRef: occurrence.id, reading: candidate.reading,
      meaning: rows.map(e => e.text).join('\n').slice(0, 1500), sentenceTranslation: tier === 'A0' ? '' : await translateSentence(occurrence.text),
      usage: '', nuance: '', evidenceIds: rows.map(e => e.id), needsReview: false, reviewReason: '', referenceOnly: true }, issues);
  };
  const verifyDrafts = async (batch: PipelineInput[], generated: StudyCardDraft[]): Promise<StudyCardDraft[]> => {
    const verdicts = parsePipelineVerification(await callLlm(pipelineVerifyPrompt(batch, generated), batch.length, true), batch);
    return generated.map(d => {
      const issues = verdicts.get(d.candidateId)!;
      const input = batch.find(i => i.candidate.id === d.candidateId)!;
      // 复核通过不能抹去作者/程序已发现的问题。
      return withIssues({ ...d, ...(issues.some(i => i.field === 'usage') ? { usage: '', nuance: '' } : {}) },
        [...(d.issues ?? []), ...sourceIssues(input.candidate, input.occurrence), ...issues.filter(i => i.field !== 'usage')]);
    });
  };
  const finalize = (input: PipelineInput, draft: StudyCardDraft): StudyCardDraft => {
    const filterDecision = list.workflow?.filterRun?.decisions[input.candidate.id] ?? list.workflow?.pendingFilterRun?.decisions[input.candidate.id];
    const issues = [...(draft.issues ?? [])];
    if (filterDecision?.decision === 'review' && !input.candidate.forceInclude) issues.push({ field: 'meaning', code: 'ambiguous', reason: `选词仍存疑：${filterDecision.reason}` });
    const result = withIssues({ ...draft, reading: input.candidate.reading, contextRef: draft.contextRef ?? input.occurrence.id }, issues, draft.status === 'deferred');
    const one = input.candidate.occurrences.find(o => o.id === result.contextRef);
    if (!result.needsReview && one && result.sentenceTranslation) {
      const key = digest(one.text);
      const shared = state.sentenceTranslations[key];
      if (shared !== undefined) result.sentenceTranslation = shared;
      else state.sentenceTranslations[key] = result.sentenceTranslation;
    }
    return result;
  };
  const processBatch = async (batch: PipelineInput[]): Promise<void> => {
    checkConfig();
    try {
      const local = tier === 'A0' || tier === 'A1' ? batch : tier === 'A2' ? batch.filter(i => !needsSemanticGeneration(i.candidate, i.evidence, i.occurrence)) : [];
      for (const input of local) {
        drafts.set(input.candidate.id, finalize(input, await localDraft(input)));
        persist('词典参考卡已保存');
      }
      const semantic = batch.filter(i => !local.includes(i));
      if (!semantic.length) return;
      let generated = parsePipelineCards(await callLlm(pipelinePrompt(semantic, tier), semantic.length), semantic);
      if (tier !== 'A4') generated = generated.map(d => ({ ...d, usage: '', nuance: '' }));
      let reviewInputs = tier === 'A4' ? semantic : tier === 'A3' ? semantic.filter(i => {
        const d = generated.find(d => d.candidateId === i.candidate.id)!;
        return d.needsReview || needsSemanticGeneration(i.candidate, i.evidence, i.occurrence);
      }) : [];
      if (reviewInputs.length) {
        try {
          const checked = await verifyDrafts(reviewInputs, generated.filter(d => reviewInputs.some(i => i.candidate.id === d.candidateId)));
          generated = generated.map(d => checked.find(c => c.candidateId === d.candidateId) ?? d);
        } catch (error) {
          if (!(error instanceof BudgetStop)) throw error;
          generated = generated.map(d => reviewInputs.some(i => i.candidate.id === d.candidateId)
            ? withIssues(d, [...(d.issues ?? []), { field: 'meaning', code: 'budget', reason: '预算不足，未完成本档位复核' }], true) : d);
        }
      }
      for (let draft of generated) {
        const original = semantic.find(i => i.candidate.id === draft.candidateId)!;
        if (draft.needsReview && draft.status !== 'deferred') {
          const alternate = selectOccurrence(original.candidate, original.occurrence.id);
          const repairInput = alternate && validOccurrence(alternate) ? { ...original, occurrence: alternate } : original;
          try {
            draft = { ...parsePipelineCards(await callLlm(pipelinePrompt([repairInput], tier, [draft]), 1), [repairInput])[0]!, repairs: 1 };
            if (tier !== 'A4') draft = { ...draft, usage: '', nuance: '' };
            if (tier === 'A3' || tier === 'A4') draft = (await verifyDrafts([repairInput], [draft]))[0]!;
          } catch (error) {
            if (!(error instanceof BudgetStop)) throw error;
            draft = withIssues(draft, [...(draft.issues ?? []), { field: 'meaning', code: 'budget', reason: '预算不足，自动修复未完成' }], true);
          }
        }
        drafts.set(draft.candidateId, finalize(original, draft));
        persist('已生成并校验词卡');
      }
    } catch (error) {
      if (error instanceof BudgetStop) {
        // 大批预算不足时先拆小，能完成的卡仍生成；单项不足才暂缓。
        const remaining = batch.filter(i => !drafts.has(i.candidate.id));
        if (remaining.length > 1) {
          const middle = Math.ceil(remaining.length / 2);
          await processBatch(remaining.slice(0, middle)); await processBatch(remaining.slice(middle)); return;
        }
        for (const input of remaining) drafts.set(input.candidate.id, withIssues({ candidateId: input.candidate.id, contextRef: input.occurrence.id,
          meaning: '', sentenceTranslation: '', usage: '', nuance: '', needsReview: true, reviewReason: '' },
          [{ field: 'meaning', code: 'budget', reason: '预算不足，尚未生成；提高预算可续跑' }], true));
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
    if (newCardLimit !== null) for (const input of todo.slice(newCardLimit)) drafts.set(input.candidate.id, withIssues({ candidateId: input.candidate.id,
      contextRef: input.occurrence.id, meaning: '', sentenceTranslation: '', usage: '', nuance: '', needsReview: true, reviewReason: '' },
      [{ field: 'meaning', code: 'limit', reason: '超过本次新增卡数上限，稍后可继续生成' }], true));
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
