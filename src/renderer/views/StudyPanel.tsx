/** 漫画学习候选审核：JLPT 筛选、出处核对、人工短语和 Anki 导出。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DirectFilterOptions, LlmSettings, StudyCandidate, StudyCandidatePatch, StudyCardTier, StudyFilterDecision, StudyFilterTier, StudyImageMode, StudyList, StudyOccurrence, StudyRunProgress, StudyRunStats, StudyTaskEntry, StudyTaskQueueState, TranslationSettings } from '@shared/types';
import { CARD_TIERS, DEFAULT_STUDY_LEVELS, FILTER_TIERS, defaultDirectOptions, directFilterStages, estimatedLlmCalls, normalizeDirectOptions, studyPriorityScore } from '@core/study/harness';
import { CARD_FIELDS, isPipelineTier, needsLlm, needsTranslation, normalizeCardFields, PIPELINE_TIERS, readyDraft } from '@core/study/pipeline';
import type { StudyPipelinePreview } from '@shared/types';
import { api, call, useIpcEvent } from '../lib/api';
import { DirectFilterPanel } from './DirectFilterPanel';
import { AiModeChoice, ManualAiPanel } from './ManualAiPanel';
import { sanitizeGlossaryHtml } from '@core/dict/glossary';
import { studyResumeStep, type StudyStep } from '@core/study/flow';

type LevelFilter = 'all' | 'n3plus' | 'n2plus' | 'n1' | 'n2' | 'n3' | 'n4' | 'n5' | 'unknown';
type CandidateView = 'included' | 'excluded' | 'review' | 'card_review' | 'ready' | 'deferred' | 'manual' | 'missing' | 'all';
type BulkSnapshot = Array<{ id: string; selected: boolean; excluded: boolean; forceInclude: boolean }>;
const PAGE_SIZE = 100;

function passesLevel(item: StudyCandidate, filter: LevelFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'unknown') return item.jlpt === null;
  if (filter === 'n3plus') return item.jlpt !== null && item.jlpt <= 3;
  if (filter === 'n2plus') return item.jlpt !== null && item.jlpt <= 2;
  return item.jlpt === Number(filter.slice(1));
}

function highlightedContext(occurrence: StudyOccurrence): JSX.Element {
  return <>
    {occurrence.text.slice(0, occurrence.start)}
    <mark>{occurrence.text.slice(occurrence.start, occurrence.end)}</mark>
    {occurrence.text.slice(occurrence.end)}
  </>;
}

function llmStatsText(stats?: StudyRunStats): string {
  if (!stats) return '';
  const requests = stats.llmHttpAttempts !== undefined ? ` · 实际 HTTP ${stats.llmHttpAttempts} 次` : '';
  const fallbacks = stats.llmFallbacks ? ` · 格式回退 ${stats.llmFallbacks} 次` : '';
  const modeNames = { tool: '工具', json_schema: 'JSON Schema', json_object: 'JSON 对象', plain: '提示词 JSON' };
  const modes = Object.entries(stats.responseModes ?? {}).filter(([, count]) => !!count)
    .map(([mode, count]) => `${modeNames[mode as keyof typeof modeNames]}×${count}`).join('、');
  const measured = (stats.cacheHitTokens ?? 0) + (stats.cacheMissTokens ?? 0);
  const cache = stats.cacheReportedCalls && measured > 0
    ? ` · 输入缓存命中 ${Math.round(100 * (stats.cacheHitTokens ?? 0) / measured)}%（${stats.cacheHitTokens ?? 0}/${measured} tokens）`
    : ' · 缓存用量未返回';
  const tokens = stats.promptTokens !== undefined || stats.completionTokens !== undefined
    ? ` · 已报告输入 ${stats.promptTokens ?? '未知'} / 输出 ${stats.completionTokens ?? '未知'} tokens` : '';
  return `${tokens}${stats.estimatedTokens ? ` · 未报告请求预算估算 ${stats.estimatedTokens} tokens` : ''}${modes ? ` · 协议 ${modes}` : ''}${requests}${fallbacks}${cache}`;
}

export function StudyPanel(props: { bookId: string; bookTitle: string; segmentGeneratedAt: number }): JSX.Element {
  const { bookId, bookTitle, segmentGeneratedAt } = props;
  const [list, setList] = useState<StudyList | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<LevelFilter>('all');
  const [sortMode, setSortMode] = useState<'count' | 'priority'>('count');
  const [step, setStep] = useState<StudyStep>('rules');
  const [candidateView, setCandidateView] = useState<CandidateView>('included');
  const [bulkUndo, setBulkUndo] = useState<BulkSnapshot | null>(null);
  const [showRunSettings, setShowRunSettings] = useState(false);
  const [page, setPage] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [phrase, setPhrase] = useState('');
  const [phraseReading, setPhraseReading] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState({ expression: '', reading: '', meaning: '' });
  const [llmSettings, setLlmSettings] = useState<LlmSettings | null>(null);
  const [translationSettings, setTranslationSettings] = useState<TranslationSettings | null>(null);
  const [levels, setLevels] = useState<number[]>([...DEFAULT_STUDY_LEVELS]);
  const [includeUnknown, setIncludeUnknown] = useState(false);
  const [directOptions, setDirectOptions] = useState<DirectFilterOptions>(defaultDirectOptions);
  const [excludedWordsText, setExcludedWordsText] = useState('');
  const [filterTier, setFilterTier] = useState<StudyFilterTier>('F1');
  const [manualFilter, setManualFilter] = useState(false);
  const [manualCards, setManualCards] = useState(false);
  const [cardTier, setCardTier] = useState<StudyCardTier>('A3');
  const [cardFields, setCardFields] = useState<import('@shared/types').StudyCardField[]>([...CARD_FIELDS]);
  const [tokenBudget, setTokenBudget] = useState('');
  const [newCardLimit, setNewCardLimit] = useState('');
  const [pipelinePreview, setPipelinePreview] = useState<StudyPipelinePreview | null>(null);
  const [filterConcurrency, setFilterConcurrency] = useState<1 | 2 | 3>(2);
  const [cardConcurrency, setCardConcurrency] = useState<1 | 2 | 3>(2);
  const [filterProfileId, setFilterProfileId] = useState('');
  const [cardProfileId, setCardProfileId] = useState('');
  const [translationProfileId, setTranslationProfileId] = useState('');
  const [localWorkflowBusy, setLocalWorkflowBusy] = useState(false);
  const [studyQueue, setStudyQueue] = useState<StudyTaskQueueState | null>(null);
  const finishedTaskId = useRef<string | null>(null);
  const [imageSaving, setImageSaving] = useState(false);
  const [workflowProgress, setWorkflowProgress] = useState<StudyRunProgress | null>(null);
  const [liveFilterDecisions, setLiveFilterDecisions] = useState<Record<string, { decision: StudyFilterDecision; reason: string }>>({});
  const [cardEdit, setCardEdit] = useState({ expression: '', lemma: '', reading: '', sentence: '', sourceLabel: '', contextRef: '', meaning: '', sentenceTranslation: '', usage: '', nuance: '' });

  useEffect(() => {
    let live = true;
    setLoading(true);
    setBulkUndo(null);
    void Promise.all([
      call('读取制卡清单', () => api.study.read(bookId)),
      call('读取 LLM 配置', () => api.llm.settings()),
      call('读取翻译配置', () => api.translation.settings()),
      call('读取制卡队列', () => api.study.taskQueue()),
    ]).then(([value, llm, translation, queue]) => {
      if (!live) return;
      setList(value); setLoading(false);
      const task = queue?.active?.bookId === bookId ? queue.active : queue?.pending.find(one => one.bookId === bookId);
      setStep(value?.segmentGeneratedAt !== segmentGeneratedAt ? 'rules' : studyResumeStep(value, task));
      if (queue) setStudyQueue(queue);
      setManualFilter(!!value?.workflow?.manualAi?.filter);
      setManualCards(!!value?.workflow?.manualAi?.cards);
      setCandidateView(value?.workflow?.cardRun
        ? value.workflow.cardRun.drafts.some((draft) => draft.needsReview) ? 'card_review' : 'included'
        : Object.values(value?.workflow?.filterRun?.decisions ?? {}).some((one) => one.decision === 'review') ? 'review' : 'included');
      setLiveFilterDecisions(value?.workflow?.pendingFilterRun?.decisions ?? {});
      setLevels(value?.workflow?.levels ?? [...DEFAULT_STUDY_LEVELS]);
      setIncludeUnknown(value?.workflow?.includeUnknown ?? false);
      setDirectOptions(normalizeDirectOptions(value?.workflow?.direct));
      setExcludedWordsText((value?.workflow?.direct?.excludedWords ?? []).join('\n'));
      setLlmSettings(llm);
      setTranslationSettings(translation);
      setFilterTier(value?.workflow?.pendingFilterRun?.tier ?? value?.workflow?.filterRun?.tier ?? 'F1');
      setCardTier(value?.workflow?.pendingCardRun?.tier ?? value?.workflow?.cardRun?.tier ?? 'A3');
      const savedRun = value?.workflow?.pendingCardRun ?? value?.workflow?.cardRun;
      setCardFields(normalizeCardFields(value?.workflow?.manualAi?.cards?.fields ?? savedRun?.pipeline?.fields, savedRun?.tier ?? 'A3'));
      const savedBudget = value?.workflow?.pendingCardRun?.pipeline?.tokenBudget ?? value?.workflow?.cardRun?.pipeline?.tokenBudget;
      setTokenBudget(savedBudget ? String(savedBudget) : '');
      const savedLimit = value?.workflow?.pendingCardRun?.pipeline?.newCardLimit ?? value?.workflow?.cardRun?.pipeline?.newCardLimit;
      setNewCardLimit(savedLimit ? String(savedLimit) : '');
      setFilterConcurrency(value?.workflow?.pendingFilterRun?.concurrency ?? value?.workflow?.filterRun?.concurrency ?? 2);
      setCardConcurrency(value?.workflow?.pendingCardRun?.concurrency ?? value?.workflow?.cardRun?.concurrency ?? 2);
      const defaultLlm = llm?.activeProfileId ?? llm?.profiles[0]?.id ?? '';
      const filterSaved = value?.workflow?.pendingFilterRun?.profileId ?? value?.workflow?.filterRun?.profileId;
      const cardSaved = value?.workflow?.pendingCardRun?.profileId ?? value?.workflow?.cardRun?.profileId;
      const translationSaved = value?.workflow?.pendingCardRun?.translationProfileId ?? value?.workflow?.cardRun?.translationProfileId;
      setFilterProfileId(llm?.profiles.some((item) => item.id === filterSaved) ? filterSaved! : defaultLlm);
      setCardProfileId(llm?.profiles.some((item) => item.id === cardSaved) ? cardSaved! : defaultLlm);
      setTranslationProfileId(translation?.profiles.some((item) => item.id === translationSaved)
        ? translationSaved! : translation?.activeProfileId ?? translation?.profiles[0]?.id ?? '');
    });
    return () => { live = false; };
  }, [bookId]);

  useEffect(() => {
    finishedTaskId.current = null;
    void api.study.taskQueue().then(setStudyQueue).catch(() => undefined);
  }, [bookId]);

  useIpcEvent('study:progress', (event) => {
    if (event.bookId === bookId) setProgress({ done: event.done, total: event.total });
  });
  useIpcEvent('study:workflow-progress', (event) => {
    if (event.bookId !== bookId) return;
    setWorkflowProgress(event);
    if (event.stage === 'filter' && event.filter?.updates.length) {
      setLiveFilterDecisions((previous) => {
        const next = { ...previous };
        for (const row of event.filter!.updates) next[row.id] = { decision: row.decision, reason: row.reason };
        return next;
      });
    }
  });
  useIpcEvent('study:queue', (state) => setStudyQueue(state));
  async function handleTaskDone(task: StudyTaskEntry): Promise<void> {
    if (task.bookId !== bookId || finishedTaskId.current === task.id) return;
    finishedTaskId.current = task.id;
    try {
      const next = await api.study.read(bookId);
      if (next) setList(next);
      setWorkflowProgress(null);
      if (task.status === 'completed') {
        if (task.kind === 'filter') {
          setLiveFilterDecisions({});
          const decisions = Object.values(next?.workflow?.filterRun?.decisions ?? {});
          setStep('review'); setCandidateView(decisions.some((one) => one.decision === 'review') ? 'review' : 'included');
          setNotice(`AI 筛选完成：保留 ${decisions.filter((one) => one.decision === 'keep').length}，待审 ${decisions.filter((one) => one.decision === 'review').length}，排除 ${decisions.filter((one) => one.decision === 'reject').length}`);
        } else {
          setStep('export');
          if (next?.workflow?.cardRun?.drafts.some((draft) => draft.needsReview)) {
            setCandidateView('card_review'); setQuery(''); setLevel('all'); setPage(0);
          } else setCandidateView('included');
          setNotice(`释义生成完成：${next?.workflow?.cardRun?.drafts.length ?? 0} 张草稿，可逐卡修改后制卡。`);
        }
      } else {
        setLiveFilterDecisions(next?.workflow?.pendingFilterRun?.decisions ?? {});
        setStep(task.kind === 'filter' ? 'ai' : 'meaning');
        setCandidateView('included'); setPage(0);
        setNotice(`${task.kind === 'filter' ? 'AI 筛选' : '释义生成'}${task.status === 'cancelled' ? '已取消' : '失败'}：${task.error ?? task.message ?? '可在原步骤续跑'}`);
      }
    } catch { setNotice('任务结束，读取学习清单失败，请刷新页面。'); }
  }
  useIpcEvent('study:done', (task) => { void handleTaskDone(task); });

  const currentDirectOptions = useMemo(() => normalizeDirectOptions({ ...directOptions, excludedWords: excludedWordsText.split(/[\n,，、]+/u) }), [directOptions, excludedWordsText]);
  const directResult = useMemo(() => directFilterStages(list?.candidates ?? [], levels, includeUnknown, currentDirectOptions), [list?.candidates, levels, includeUnknown, currentDirectOptions]);
  const previewIds = useMemo(() => new Set(directResult.selected.map((item) => item.id)), [directResult]);
  const directPreview = directResult.selected;
  const llmPreviewCount = directPreview.filter((item) => item.forceInclude !== true).length;
  const hasAppliedRules = list?.workflow?.directAppliedAt !== undefined
    ? list.workflow.directAppliedAt > 0
    : (list?.candidates.some((item) => item.selected) || !!list?.workflow?.filterRun || !!list?.workflow?.pendingFilterRun);
  const levelsDirty = !hasAppliedRules || JSON.stringify([...levels].sort()) !== JSON.stringify([...(list?.workflow?.levels ?? DEFAULT_STUDY_LEVELS)].sort()) ||
    includeUnknown !== (list?.workflow?.includeUnknown ?? false) ||
    JSON.stringify(currentDirectOptions) !== JSON.stringify(normalizeDirectOptions(list?.workflow?.direct));
  function inCandidateView(item: StudyCandidate, view: CandidateView): boolean {
    const included = step === 'rules' ? previewIds.has(item.id) : item.selected && !item.excluded;
    const card = list?.workflow?.cardRun?.drafts.find(d => d.candidateId === item.id);
    if (step === 'export' && !included) return false;
    if (view === 'all') return true;
    if (view === 'included') return included;
    if (view === 'excluded') return !included;
    if (view === 'ready') return !!card && readyDraft(card, list!.workflow!.cardRun!.tier);
    if (view === 'deferred') return card?.status === 'deferred';
    if (view === 'card_review') return !!card && card.status !== 'deferred' && !readyDraft(card, list!.workflow!.cardRun!.tier);
    if (view === 'missing') return !card;
    if (view === 'manual') return item.forceInclude === true || item.excluded;
    return included && !item.forceInclude && (list?.workflow?.filterRun?.decisions[item.id]?.decision === 'review' || liveFilterDecisions[item.id]?.decision === 'review');
  }
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (list?.candidates ?? []).filter(item => inCandidateView(item, candidateView) && passesLevel(item, level) &&
      (!needle || item.expression.toLowerCase().includes(needle) || item.reading.includes(needle)));
    if (sortMode === 'priority') matches.sort((a, b) => studyPriorityScore(b) - studyPriorityScore(a) || b.count - a.count || a.expression.localeCompare(b.expression));
    return matches;
  }, [list, query, level, candidateView, sortMode, step, previewIds, liveFilterDecisions]);
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const active = filtered.find((item) => item.id === activeId) ?? filtered[0] ?? null;
  const selectedCount = list?.candidates.filter((item) => item.selected && !item.excluded).length ?? 0;
  const incompleteCount = list?.workflow?.cardRun
    ? list.workflow.cardRun.drafts.filter((item) => item.status !== 'deferred' && !readyDraft(item, list.workflow!.cardRun!.tier) && list.candidates.some(c => c.id === item.candidateId && c.selected && !c.excluded)).length
    : list?.candidates.filter((item) => item.selected && !item.excluded && (!item.reading || !item.meaning)).length ?? 0;
  const chosenOccurrence = active?.occurrences.find((one) => one.id === active.contextRef) ?? active?.occurrences[0];
  const shownOccurrence = step === 'export'
    ? active?.occurrences.find((one) => one.id === cardEdit.contextRef) ?? chosenOccurrence
    : chosenOccurrence;
  const stale = list !== null && list.segmentGeneratedAt !== segmentGeneratedAt;
  const cardRun = list?.workflow?.cardRun;
  const wordReviewCount = list?.candidates.filter((item) => item.selected && !item.excluded && !item.forceInclude &&
    (list.workflow?.filterRun?.decisions[item.id]?.decision === 'review' ||
      (list.workflow?.partialFilterAppliedAt && list.workflow.pendingFilterRun?.decisions[item.id]?.decision === 'review'))).length ?? 0;
  const pendingCardCount = list?.workflow?.pendingCardRun?.drafts.length ?? 0;
  const currentCard = cardRun?.drafts.find((item) => item.candidateId === active?.id);
  const selectedDrafts = cardRun?.drafts.filter(d => list?.candidates.some(c => c.id === d.candidateId && c.selected && !c.excluded)) ?? [];
  const reviewCount = selectedDrafts.filter(item => item.status !== 'deferred' && !readyDraft(item, cardRun!.tier)).length;
  const readyCount = selectedDrafts.filter(item => readyDraft(item, cardRun!.tier)).length;
  const deferredCount = selectedDrafts.filter(item => item.status === 'deferred').length ?? 0;
  const pipelineSelected = isPipelineTier(cardTier);
  const cardNeedsLlm = needsLlm(cardTier, pipelineSelected ? cardFields : undefined);
  const cardNeedsTranslation = needsTranslation(cardTier, pipelineSelected ? cardFields : undefined);
  const cardTranslationRequired = cardNeedsTranslation && (!pipelineSelected || !['A3', 'A4'].includes(cardTier));
  const budgetInvalid = pipelineSelected && cardNeedsLlm && tokenBudget !== '' && (!Number.isSafeInteger(Number(tokenBudget)) || Number(tokenBudget) < 1000);
  const limitInvalid = pipelineSelected && newCardLimit !== '' && (!Number.isSafeInteger(Number(newCardLimit)) || Number(newCardLimit) < 1 || Number(newCardLimit) > 10000);
  const filterCalls = estimatedLlmCalls(llmPreviewCount, FILTER_TIERS[filterTier]);
  const cardCalls = estimatedLlmCalls(selectedCount, CARD_TIERS[cardTier]);
  const pendingFilterCount = Object.keys(liveFilterDecisions).length;
  const pendingFilter = list?.workflow?.pendingFilterRun;
  const bookTask = studyQueue?.active?.bookId === bookId ? studyQueue.active
    : studyQueue?.pending.find((item) => item.bookId === bookId) ?? null;
  const workflowBusy = localWorkflowBusy || bookTask !== null;
  const partialFilterApplied = pendingFilterCount > 0 && !!list?.workflow?.partialFilterAppliedAt;
  const exportBlockReason = workflowBusy ? '当前任务尚未结束，请稍候。'
    : !cardRun ? '请先在第 4 步生成释义草稿。'
      : imageSaving ? '正在保存配图方式，请稍候。'
        : stale ? '原文分词已更新，请重新生成候选和释义草稿。'
          : cardRun && isPipelineTier(cardRun.tier) ? readyCount === 0 ? '没有已通过卡；可审核待审卡，或提高预算继续暂缓项。' : ''
          : reviewCount > 0 ? `还有 ${reviewCount} 张待审词卡。请在右侧“词卡待审”逐张核对并点击“确认并通过审核”。`
            : !partialFilterApplied && wordReviewCount > 0 ? `还有 ${wordReviewCount} 个 AI 筛词待审，请先在第 3 步处理。` : '';
  const pendingFilterMismatch = pendingFilterCount > 0 &&
    (pendingFilter?.tier !== filterTier || pendingFilter.profileId !== filterProfileId);
  const filterProgress = workflowProgress?.stage === 'filter' ? workflowProgress : null;
  const filterCounts = filterProgress?.filter ?? Object.values(liveFilterDecisions).reduce(
    (counts, row) => ({ ...counts, [row.decision]: counts[row.decision] + 1 }),
    { keep: 0, reject: 0, review: 0, llmCalls: 0, elapsedMs: 0, updates: [] as NonNullable<StudyRunProgress['filter']>['updates'] },
  );
  const filterDone = filterProgress?.done ?? pendingFilterCount;
  const filterTotal = filterProgress?.total ?? llmPreviewCount;
  const filterElapsed = filterProgress?.filter?.elapsedMs ?? list?.workflow?.pendingFilterRun?.stats?.elapsedMs ?? 0;
  const remainingMinutes = filterDone >= 8 && filterDone < filterTotal
    ? Math.ceil((filterElapsed / filterDone) * (filterTotal - filterDone) / 60_000) : null;

  useEffect(() => {
    let live = true;
    setPipelinePreview(null);
    if (step === 'meaning' && !manualCards && list && isPipelineTier(cardTier)) {
      void api.study.previewCards(bookId, cardTier, cardFields).then(value => { if (live) setPipelinePreview(value); }).catch(() => undefined);
    }
    return () => { live = false; };
  }, [bookId, cardTier, cardFields, step, list, manualCards]);

  useEffect(() => {
    setDraft({ expression: active?.expression ?? '', reading: active?.reading ?? '', meaning: active?.meaning ?? '' });
  }, [active?.id]);

  useEffect(() => {
    const occurrence = active?.occurrences.find((one) => one.id === currentCard?.contextRef) ?? chosenOccurrence;
    setCardEdit({
      lemma: currentCard?.lemma ?? '',
      expression: currentCard?.expression ?? active?.expression ?? '', reading: currentCard?.reading ?? active?.reading ?? '',
      sentence: currentCard?.sentence ?? occurrence?.text ?? '', sourceLabel: currentCard?.sourceLabel ?? `${bookTitle} · ${occurrence?.label ?? ''}`,
      contextRef: currentCard?.contextRef ?? active?.contextRef ?? '',
      meaning: currentCard?.meaning ?? '', sentenceTranslation: currentCard?.sentenceTranslation ?? '',
      usage: currentCard?.usage ?? '', nuance: currentCard?.nuance ?? '',
    });
  }, [active?.id, cardRun?.completedAt, bookTitle]);

  async function generate(): Promise<void> {
    const savedDrafts = cardRun?.drafts.length ?? pendingCardCount;
    if (list && (savedDrafts > 0 || list.workflow?.filterRun) &&
      !window.confirm(`重新生成候选会清除上次 AI 筛选结果${savedDrafts > 0 ? `和 ${savedDrafts} 张制卡草稿` : ''}，人工词条修改会保留。继续？`)) return;
    setGenerating(true);
    setProgress({ done: 0, total: 0 });
    setNotice('');
    const next = await call('生成学习候选', () => api.study.generate(bookId));
    if (next) {
      setList(next); setActiveId(null); setPage(0); setStep('rules'); setCandidateView('included');
      setQuery(''); setLevel('all'); setBulkUndo(null); setWorkflowProgress(null); setLiveFilterDecisions({});
      setManualFilter(false); setManualCards(false);
      setLevels(next.workflow?.levels ?? [...DEFAULT_STUDY_LEVELS]); setIncludeUnknown(next.workflow?.includeUnknown ?? false);
      setDirectOptions(normalizeDirectOptions(next.workflow?.direct));
      setExcludedWordsText((next.workflow?.direct?.excludedWords ?? []).join('\n'));
      setNotice(`已重新准备 ${next.candidates.length} 个候选词，请从第 1 步应用规则。`);
    }
    setGenerating(false);
    setProgress(null);
  }

  async function patchOne(id: string, patch: StudyCandidatePatch): Promise<boolean> {
    const updated = await call('保存候选词', () => api.study.patch(bookId, id, patch));
    if (updated) setList((previous) => previous && ({ ...previous, candidates: previous.candidates.map((item) => item.id === id ? updated : item) }));
    return updated !== null;
  }

  async function saveDraft(): Promise<boolean> {
    if (!active) return true;
    if (draft.expression !== active.expression || draft.reading !== active.reading || draft.meaning !== active.meaning) {
      return patchOne(active.id, draft);
    }
    return true;
  }

  function manualAiChanged(next: StudyList): void {
    setList(next);
    if (!next.workflow?.pendingFilterRun) setLiveFilterDecisions({});
  }

  async function switchCandidate(id: string): Promise<void> {
    if (!await saveDraft()) return;
    if (step === 'export' && !await saveCardDraft()) return;
    setActiveId(id);
  }

  async function navigateTo(next: StudyStep): Promise<void> {
    if (step === 'rules' && !await saveDraft()) return;
    if (step === 'export' && !await saveCardDraft()) return;
    if (next !== 'review') setBulkUndo(null);
    setStep(next);
    setCandidateView(next === 'export' && reviewCount > 0 ? 'card_review' : 'included');
    if (next === 'export' && reviewCount > 0) { setQuery(''); setLevel('all'); }
    setPage(0);
  }

  async function decideFiltered(decision: 'keep' | 'exclude'): Promise<void> {
    if (filtered.length === 0) return;
    const snapshot: BulkSnapshot = filtered.map((item) => ({
      id: item.id, selected: item.selected, excluded: item.excluded, forceInclude: item.forceInclude === true,
    }));
    const patch = decision === 'keep'
      ? { forceInclude: true, excluded: false, selected: true }
      : { forceInclude: false, excluded: true, selected: false };
    const next = await call('批量修改人工决定', () => api.study.patchMany(bookId, filtered.map((item) => item.id), patch));
    if (next) {
      setList(next); setBulkUndo(snapshot);
      setNotice(`已将当前列表的 ${snapshot.length} 个词全部手动${decision === 'keep' ? '保留' : '排除'}；可在此撤销。`);
    }
  }

  async function undoFiltered(): Promise<void> {
    if (!bulkUndo) return;
    const groups = new Map<string, { ids: string[]; patch: StudyCandidatePatch }>();
    for (const item of bulkUndo) {
      const patch = { selected: item.selected, excluded: item.excluded, forceInclude: item.forceInclude };
      const key = JSON.stringify(patch);
      const group = groups.get(key) ?? { ids: [] as string[], patch };
      group.ids.push(item.id);
      groups.set(key, group);
    }
    let restored: StudyList | null = null;
    for (const group of groups.values()) {
      restored = await call('撤销批量筛词', () => api.study.patchMany(bookId, group.ids, group.patch));
      if (!restored) return;
    }
    if (restored) { setList(restored); setBulkUndo(null); setNotice(`已撤销对 ${bulkUndo.length} 个词的批量决定。`); }
  }

  async function decideOne(item: StudyCandidate, decision: 'auto' | 'keep' | 'exclude'): Promise<void> {
    const llm = list?.workflow?.filterRun?.decisions[item.id];
    const byRules = directFilterStages([{ ...item, excluded: false, forceInclude: false }],
      list?.workflow?.levels ?? DEFAULT_STUDY_LEVELS, list?.workflow?.includeUnknown ?? false,
      list?.workflow?.direct).selected.length > 0;
    const selected = byRules && llm?.decision !== 'reject';
    const patch = decision === 'keep' ? { forceInclude: true, excluded: false, selected: true }
      : decision === 'exclude' ? { forceInclude: false, excluded: true, selected: false }
        : { forceInclude: false, excluded: false, selected };
    if (await patchOne(item.id, patch)) setBulkUndo(null);
  }

  function discardRuleDraft(): void {
    setLevels(list?.workflow?.levels ?? [...DEFAULT_STUDY_LEVELS]);
    setIncludeUnknown(list?.workflow?.includeUnknown ?? false);
    setDirectOptions(normalizeDirectOptions(list?.workflow?.direct));
    setExcludedWordsText((list?.workflow?.direct?.excludedWords ?? []).join('\n'));
  }

  async function addPhrase(): Promise<void> {
    if (!chosenOccurrence) return;
    if (!await saveDraft()) return;
    const next = await call('添加漫画短语', () => api.study.addPhrase(bookId, chosenOccurrence.id, phrase, phraseReading));
    if (next) {
      setList(next);
      setPhrase(''); setPhraseReading('');
      setLevel('all');
      setActiveId(next.candidates[0]?.id ?? null);
      setNotice('短语已加入制卡清单');
    }
  }

  async function exportAnki(): Promise<void> {
    if (!await saveDraft()) return;
    const result = await call('导出 Anki 词表', () => api.study.export(bookId));
    if (result?.path) {
      setNotice(`已导出 ${result.count} 张卡：${result.path}`);
      const updated = await call('刷新制卡清单', () => api.study.read(bookId));
      if (updated) setList(updated);
    }
  }

  async function applyDirectFilter(): Promise<void> {
    const oldDrafts = cardRun?.drafts.length ?? pendingCardCount;
    if ((oldDrafts > 0 || list?.workflow?.filterRun) &&
      !window.confirm(`应用新规则会清除上次 AI 筛选结果${oldDrafts > 0 ? `和 ${oldDrafts} 张制卡草稿` : ''}。继续应用？`)) return;
    if (!await saveDraft()) return;
    const next = await call('应用多层直接筛选', () => api.study.directFilter(bookId, levels, includeUnknown, currentDirectOptions));
    if (next) {
      setList(next); setDirectOptions(normalizeDirectOptions(next.workflow?.direct));
      setExcludedWordsText((next.workflow?.direct?.excludedWords ?? []).join('\n'));
      setLiveFilterDecisions({}); setWorkflowProgress(null);
      setLevel('all'); setCandidateView('included'); setPage(0);
      setNotice(`规则已应用：准备制卡 ${next.candidates.filter((item) => item.selected && !item.excluded).length} 词。`);
    }
  }

  async function runLlmFilter(): Promise<void> {
    if (!filterProfileId || !await saveDraft()) return;
    const prior = list?.workflow?.pendingFilterRun;
    const resume = prior?.tier === filterTier && prior.profileId === filterProfileId;
    const saved = resume ? prior.decisions : {};
    setLiveFilterDecisions(saved);
    const task = await call('加入 AI 筛选队列', () => api.study.runFilter(bookId, { tier: filterTier, profileId: filterProfileId, concurrency: filterConcurrency }));
    if (!task) return;
    setStep('ai'); setCandidateView('included'); setPage(0);
    const queue = await api.study.taskQueue();
    setStudyQueue(queue);
    const finished = queue.recent.find((item) => item.id === task.id);
    if (finished) { await handleTaskDone(finished); return; }
    setWorkflowProgress({ bookId, stage: 'filter', done: task.done, total: task.total });
    setNotice(`AI 筛选已加入任务队列，可先阅读或使用其他功能；进度在右下角查看。`);
  }

  async function useCompletedFilter(): Promise<void> {
    const next = await call('使用已完成的 LLM 筛选', () => api.study.applyCompletedFilter(bookId));
    if (!next) return;
    setList(next);
    setLevel('all'); setCandidateView('included'); setPage(0); setStep('review');
    setNotice(`已选用 ${next.candidates.filter((item) => item.selected && !item.excluded).length} 个已处理候选；其余暂不制卡，之后仍可续跑筛选。`);
  }

  async function discardFilterProgress(): Promise<void> {
    if (!window.confirm(`将放弃 ${pendingFilterCount} 个已完成的 LLM 判断，无法恢复。确认继续？`)) return;
    const next = await call('放弃旧 LLM 检查点', () => api.study.clearFilterProgress(bookId));
    if (!next) return;
    setList(next);
    setLiveFilterDecisions({});
    setWorkflowProgress(null);
    setNotice('旧检查点已清除，现在可应用新规则或选择其他模型。');
  }

  async function makeCards(restart = false): Promise<void> {
    if ((cardTranslationRequired && !translationProfileId) || (cardNeedsLlm && !cardProfileId) || budgetInvalid || limitInvalid || !await saveDraft()) return;
    const task = await call('加入释义生成队列', () => api.study.runCards(bookId, {
      tier: cardTier, translationProfileId: cardNeedsTranslation ? translationProfileId : '', concurrency: cardConcurrency,
      ...(cardNeedsLlm ? { profileId: cardProfileId } : {}),
      ...(pipelineSelected ? { fields: cardFields, tokenBudget: tokenBudget && cardNeedsLlm ? Number(tokenBudget) : null, newCardLimit: newCardLimit ? Number(newCardLimit) : null, restart } : {}),
    }));
    if (!task) return;
    setStep('meaning'); setCandidateView('included'); setPage(0);
    const queue = await api.study.taskQueue();
    setStudyQueue(queue);
    const finished = queue.recent.find((item) => item.id === task.id);
    if (finished) { await handleTaskDone(finished); return; }
    setWorkflowProgress({ bookId, stage: 'cards', done: task.done, total: task.total });
    setNotice('释义生成已加入任务队列，可先进行其他操作；完成后在右下角打开制卡页。');
  }

  async function saveCardDraft(approve = false): Promise<boolean> {
    if (!currentCard || !active) return true;
    const patch = {
      ...cardEdit,
      ...(approve ? { needsReview: false as const } : {}),
    };
    const next = await call('保存 Anki 卡片草稿', () => api.study.patchCard(bookId, active.id, patch));
    if (next) {
      setList(next);
      if (approve) {
        const remaining = next.workflow?.cardRun?.drafts.filter((item) => item.needsReview).length ?? 0;
        const saved = next.workflow?.cardRun?.drafts.find(d => d.candidateId === active.id);
        if (saved && !saved.needsReview) {
          const nextDraft = next.workflow?.cardRun?.drafts.find(d => d.needsReview && d.status !== 'deferred');
          if (nextDraft) { setCandidateView('card_review'); setActiveId(nextDraft.candidateId); setQuery(''); setLevel('all'); }
          else { setCandidateView('ready'); setActiveId(null); }
          setPage(0);
        }
        setNotice(next.workflow?.cardRun?.drafts.find((item) => item.candidateId === active.id)?.needsReview
          ? '词义、所需句译和汉字读音需要补全，才能通过审核。'
          : remaining > 0 ? `已通过审核，剩余 ${remaining} 张待审词卡。` : '待审词卡已全部审核，现在可以导出。');
      }
    }
    return next !== null;
  }

  async function deferCard(): Promise<void> {
    if (!active || !currentCard || !await saveCardDraft()) return;
    const next = await call('暂缓词卡', () => api.study.patchCard(bookId, active.id, { status: 'deferred', needsReview: true }));
    if (!next) return;
    setList(next); setPage(0); setQuery(''); setLevel('all');
    const remaining = next.workflow?.cardRun?.drafts.find(d => d.needsReview && d.status !== 'deferred');
    setCandidateView(remaining ? 'card_review' : 'deferred'); setActiveId(remaining?.candidateId ?? null);
    setNotice('已暂缓，之后可在“暂缓”列表继续核对。');
  }

  async function chooseImageMode(mode: StudyImageMode): Promise<void> {
    setImageSaving(true);
    const next = await call('保存词卡配图方式', () => api.study.setImageMode(bookId, mode));
    if (next) setList(next);
    setImageSaving(false);
  }

  async function exportPackage(): Promise<void> {
    if (!await saveDraft() || !await saveCardDraft()) return;
    setLocalWorkflowBusy(true); setWorkflowProgress({ bookId, stage: 'export', done: 0, total: cardRun?.drafts.length ?? 0 });
    const result = await call('导出带图 Anki 卡组', () => api.study.exportPackage(bookId));
    if (result?.path) {
      setNotice(`已导出 ${result.count} 张 Anki 卡（${list?.workflow?.imageMode === 'none' ? '不带图' : list?.workflow?.imageMode === 'page' ? '整页漫画' : '文字框截图'}）：${result.path}`);
      const next = await call('刷新制卡清单', () => api.study.read(bookId));
      if (next) setList(next);
    }
    setLocalWorkflowBusy(false); setWorkflowProgress(null);
  }

  return <div className="study-panel">
    <div className="study-head">
      <div>
        <strong>Anki 制卡 · {bookTitle}</strong>
        <small>候选等级来自社区 JLPT 参考词表，需按漫画原文审核。</small>
      </div>
      <div className="study-head-actions">
        {generating && <button type="button" className="btn btn-sm" onClick={() => void call('取消候选生成', () => api.study.cancel(bookId))}>取消</button>}
        <button type="button" className="btn btn-sm" disabled={generating || workflowBusy || !!pendingFilter || !!list?.workflow?.pendingCardRun || Object.values(list?.workflow?.manualAi ?? {}).some(s => s && !s.completedAt)} title="重建候选并回到第 1 步；未完成的任务须先续跑或放弃" onClick={() => void generate()}>{list ? '重新生成候选 · 回到第 1 步' : '生成候选'}</button>
      </div>
    </div>
    {step === 'export' && incompleteCount > 0 && <div className="study-notice">{cardRun ? `有 ${incompleteCount} 张草稿待核对；已通过卡仍可导出。` : `准备制卡的词中有 ${incompleteCount} 个缺读音或释义，建议导出前核对。`}</div>}
    {stale && <div className="segment-error">分词结果已更新，请重新生成学习候选。人工选择和短语会保留。</div>}
    {generating && <div className="segment-progress">正在分析漫画文字块 · {progress?.done ?? 0} / {progress?.total ?? '…'}</div>}
    {notice && <div className="study-notice" role="status">{notice}</div>}
    {loading && <div className="segment-empty">正在读取制卡清单…</div>}
    {!loading && !list && <div className="segment-empty">先生成分词，再点“生成候选”。候选来自漫画文字块；可按 JLPT 难度筛选并逐词核对。</div>}
    {list && <>
      <nav className="study-flow-nav" aria-label="制卡步骤">
        {([['rules', hasAppliedRules ? '1 规则筛词 · 已应用' : '1 规则筛词 · 待应用'], ['ai', bookTask?.kind === 'filter' ? `2 AI 语境筛选 · ${bookTask.status === 'queued' ? '排队中' : `${bookTask.done}/${bookTask.total}`}` : pendingFilterCount > 0 ? `2 AI 语境筛选 · 待续跑 ${pendingFilterCount}/${filterTotal}` : '2 AI 语境筛选 · 可跳过'], ['review', `3 手动筛词 · ${wordReviewCount ? wordReviewCount+' 待核对' : selectedCount+' 已选'}`], ['meaning', bookTask?.kind === 'cards' ? `4 词卡内容生成 · ${bookTask.status === 'queued' ? '排队中' : `${bookTask.done}/${bookTask.total}`}` : '4 词卡内容生成'], ['export', `5 审核与导出 · ${readyCount} 可导出`]] as const).map(([value, label]) =>
          <button key={value} type="button" aria-current={step === value ? 'step' : undefined}
            disabled={generating || workflowBusy || (levelsDirty && value !== 'rules') || (value === 'export' && !cardRun) || (value === 'meaning' && selectedCount === 0) ||
              ((value === 'meaning' || value === 'export') && !cardRun && !partialFilterApplied && (pendingFilterCount > 0 || wordReviewCount > 0))}
            onClick={() => void navigateTo(value)}>{label}</button>)}
        <span>已选 {selectedCount} 词 · 可导出 {readyCount} 张 · 待核对 {reviewCount} 张</span>
      </nav>
      <div className="study-flow-body">
      <aside className="study-workflow">
        {step === 'rules' && <section className="study-flow-section">
          <h3>规则筛词</h3>
          <p>修改条件时先预览，点击应用后才改变正式词单。</p>
          <div className="study-preview-total" role="status">{list.candidates.length} 个候选 <strong>→ 预计保留 {directPreview.length}</strong><span>预计排除 {list.candidates.length - directPreview.length}</span></div>
          {levelsDirty && <p className="study-draft-warning">规则草稿尚未应用；当前正式词单为 {selectedCount} 词。</p>}
          {levelsDirty && (list.workflow?.filterRun || cardRun || pendingCardCount > 0) && <small>应用新规则会重置上次 AI 结果和制卡草稿；点击应用时会再次说明。</small>}
          <DirectFilterPanel
            levels={levels} includeUnknown={includeUnknown} options={currentDirectOptions}
            excludedWordsText={excludedWordsText} wordfreqSource={list.wordfreqSource ?? null}
            stages={directResult.stages}
            onLevels={setLevels} onIncludeUnknown={setIncludeUnknown}
            onOptions={setDirectOptions} onExcludedWordsText={setExcludedWordsText}
          />
          <div className="study-rule-impact" aria-label="各组新增排除数">
            {directResult.stages.map((stage) => <span key={stage.name}>{stage.name}：新排 {stage.removed}</span>)}
          </div>
          {levelsDirty && pendingFilterCount > 0 && <div className="study-checkpoint-warning">
            已有 {pendingFilterCount}/{filterTotal} 项 AI 判断。可继续旧任务；若要应用新规则，先明确放弃这些结果。
            <button type="button" className="btn btn-sm" disabled={workflowBusy} onClick={() => void discardFilterProgress()}>放弃 {pendingFilterCount} 项旧判断</button>
          </div>}
          <div className="study-flow-actions">
            {levelsDirty ? <>
              <button type="button" className="btn btn-sm" onClick={discardRuleDraft}>撤销改动</button>
              <button type="button" className="btn btn-sm btn-primary" disabled={workflowBusy || stale || pendingFilterCount > 0} onClick={() => void applyDirectFilter()}>应用规则，保留 {directPreview.length} 词</button>
            </> : <>
              <span>规则已应用</span>
              <button type="button" className="btn btn-sm" onClick={() => void navigateTo('ai')}>{pendingFilterCount > 0 ? `继续旧 AI 任务（${pendingFilterCount}/${filterTotal}）` : '继续：AI 语境筛选'}</button>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => void navigateTo('review')}>跳过 AI，手动筛词</button>
            </>}
          </div>
        </section>}
          {step === 'ai' && <section className="study-flow-section">
            <h3>AI 语境筛选 <small>可跳过</small></h3>
            <AiModeChoice label="筛词执行模式" manual={manualFilter} onChange={setManualFilter} />
            {manualFilter ? <ManualAiPanel bookId={bookId} bookTitle={bookTitle} kind="filter" session={list.workflow?.manualAi?.filter}
              disabled={workflowBusy || stale || levelsDirty || !hasAppliedRules} running={workflowBusy} beforeExport={saveDraft} onChange={manualAiChanged}
              pendingFilter={!!list.workflow?.pendingFilterRun} pendingCards={!!list.workflow?.pendingCardRun}
              onNext={() => { setStep('review'); setCandidateView(Object.values(list.workflow?.filterRun?.decisions ?? {}).some(d => d.decision === 'review') ? 'review' : 'included'); setPage(0); }} /> : <>
            <p>让模型根据原句判断候选是否适合制卡；也可以直接使用规则筛词结果。</p>
            <div className="study-tier-choices" role="group" aria-label="AI 筛选档位">
              {(['F1', 'F2', 'F3'] as const).map((tier) => <label key={tier} className={filterTier === tier ? 'active' : ''}>
                <input type="radio" name="study-filter-tier" checked={filterTier === tier} onChange={() => setFilterTier(tier)} />
                <strong>{tier} · {FILTER_TIERS[tier].name}</strong><small>{FILTER_TIERS[tier].description}</small>
              </label>)}
            </div>
            <p>本次约 {filterCalls} 次模型调用；答案格式异常时可能增加。</p>
            <div className="study-workflow-controls">
              <label>LLM 配置 <select aria-label="筛选 LLM 配置" value={filterProfileId} onChange={(event) => setFilterProfileId(event.target.value)}>
                <option value="">选择 LLM 配置</option>{llmSettings?.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}
              </select></label>
            </div>
            <details className="study-run-settings" open={showRunSettings} onToggle={(event) => setShowRunSettings(event.currentTarget.open)}>
              <summary>运行设置 · 并发 {filterConcurrency}</summary>
              <select aria-label="筛选并发数" value={filterConcurrency} onChange={(event) => setFilterConcurrency(Number(event.target.value) as 1 | 2 | 3)}>
                <option value={1}>并发 1 · 低负载</option><option value={2}>并发 2 · 推荐</option><option value={3}>并发 3 · 较快</option>
              </select>
              <small>默认并发 2；遇到服务限流可降为 1。每批结果独立保存。</small>
            </details>
            <div className="study-flow-actions">
              <button type="button" className="btn btn-sm btn-primary" disabled={!filterProfileId || llmPreviewCount === 0 || levelsDirty || pendingFilterMismatch || workflowBusy || stale} onClick={() => void runLlmFilter()}>{pendingFilterCount > 0 ? `继续剩余 ${Math.max(0, llmPreviewCount - pendingFilterCount)} 词` : `开始筛选 ${llmPreviewCount} 词`}</button>
              <button type="button" className="btn btn-sm" disabled={workflowBusy} onClick={() => void navigateTo('review')}>跳过 AI，手动筛词</button>
            </div>
            {levelsDirty && <small>规则草稿尚未应用，请先返回规则筛词。</small>}
            {pendingFilterCount > 0 && <small>已有 {pendingFilterCount} 个临时判断；全部完成前不会改动正式选择。保持档位与配置可续跑。</small>}
            {pendingFilterMismatch && <small>旧检查点使用 {pendingFilter?.tier} / {pendingFilter?.profileId}，改档或换模型前需先放弃检查点。</small>}
            {!workflowBusy && list.workflow?.pendingFilterRun?.lastError && <small>上次中断：{list.workflow.pendingFilterRun.lastError}</small>}
            {pendingFilterCount > 0 && !workflowBusy && <div className="study-workflow-controls"><button type="button" className="btn btn-sm" onClick={() => void useCompletedFilter()}>只使用已判断的 {pendingFilterCount} 词（未处理词暂不制卡）</button><button type="button" className="btn btn-sm" onClick={() => void discardFilterProgress()}>放弃旧检查点</button></div>}
            {list.workflow?.filterRun && <small>上次：{list.workflow.filterRun.tier} · {list.workflow.filterRun.stats?.llmCalls ?? '—'} 次 Harness 调用{llmStatsText(list.workflow.filterRun.stats)} · {Math.round((list.workflow.filterRun.stats?.elapsedMs ?? 0) / 1000)} 秒。结果可在下方逐词修改。</small>}
            </>}
          </section>}
          {step === 'review' && <section className="study-flow-section">
            <h3>手动筛词</h3>
            <div className="study-preview-total"><strong>准备制卡 {selectedCount} 词</strong><span>AI 待审 {wordReviewCount} · 人工决定 {list.candidates.filter((item) => item.forceInclude || item.excluded).length}</span></div>
            <p>这里只决定词是否进入词单：查看原句后，手动保留或手动排除。再次点击已选决定可撤销，恢复自动结果。词卡内容在第 5 步编辑。</p>
            <div className="study-bulk-decision" role="group" aria-label="批量手动筛词">
              <strong>批量处理当前列表 · {filtered.length} 词</strong>
              <div>
                <button type="button" className="btn btn-sm" disabled={filtered.length === 0 || pendingFilterCount > 0 || workflowBusy} onClick={() => void decideFiltered('keep')}>当前列表全保留</button>
                <button type="button" className="btn btn-sm btn-danger" disabled={filtered.length === 0 || pendingFilterCount > 0 || workflowBusy} onClick={() => void decideFiltered('exclude')}>当前列表全去除</button>
                {bulkUndo && <button type="button" className="btn btn-sm" disabled={workflowBusy} onClick={() => void undoFiltered()}>撤销上次批量操作（{bulkUndo.length}）</button>}
              </div>
              <small>作用于右侧当前视图、搜索和等级条件匹配的全部词，包括未显示的分页；不影响被隐藏的词。</small>
            </div>
            {pendingFilterCount > 0 && <div className="study-checkpoint-warning">
              还有 {pendingFilterCount}/{filterTotal} 项已保存的临时 AI 判断。{partialFilterApplied ? '当前只将已判断的保留／待审词纳入制卡；未处理词暂不制卡。' : '为保证能续跑，人工改词暂时锁定。'}
              <div className="study-workflow-controls"><button type="button" className="btn btn-sm" onClick={() => setStep('ai')}>返回 AI 续跑</button><button type="button" className="btn btn-sm" onClick={() => void discardFilterProgress()}>放弃检查点后人工调整</button></div>
            </div>}
            {wordReviewCount > 0 && <button type="button" className="btn btn-sm" onClick={() => { setCandidateView('review'); setPage(0); }}>查看 {wordReviewCount} 个待审词</button>}
            <div className="study-flow-actions">
              <button type="button" className="btn btn-sm" onClick={() => setStep('rules')}>返回规则</button>
              <button type="button" className="btn btn-sm btn-primary" disabled={selectedCount === 0 || (pendingFilterCount > 0 && !partialFilterApplied) || levelsDirty || stale} onClick={() => { setBulkUndo(null); setStep('meaning'); setCandidateView('included'); }}>继续生成 {selectedCount} 词释义</button>
            </div>
            {wordReviewCount > 0 && <small>{partialFilterApplied
              ? `当前有 ${wordReviewCount} 个已纳入的 AI 待审词；如需逐词人工决定，先放弃旧检查点。`
              : `可先处理 ${wordReviewCount} 个 AI 待审词，或继续生成；新流程会将其保留在词卡待审区。`}</small>}
          </section>}
          {step === 'meaning' && <section className="study-flow-section">
            <h3>词卡生成</h3>
            <AiModeChoice label="词卡执行模式" manual={manualCards} onChange={setManualCards} />
            <p>{manualCards ? '先选择卡片字段，再导出任务文件。原句和辞书形由程序固定，其余勾选内容由外部 AI 生成。' : '先选择卡片字段，再选择生成深度。原文与辞书形由程序提供，词义优先词典，译文优先翻译服务。'}</p>
            {(pipelineSelected || manualCards) && <div role="group" aria-label="词卡生成字段">{CARD_FIELDS.map(field => <label key={field} style={{ display: 'inline-flex', gap: 6, marginRight: 16 }}>
              <input type="checkbox" checked={cardFields.includes(field)} onChange={event => { const checked = event.target.checked;
                setCardFields(previous => checked ? [...previous, field] : previous.filter(f => f !== field)); }} />
              {{ reading: '假名', meaning: '本词含义', sentence: '原句', sentenceTranslation: '句子含义', lemma: '辞书形' }[field]}
            </label>)}</div>}
            {manualCards ? <ManualAiPanel bookId={bookId} bookTitle={bookTitle} kind="cards" fields={cardFields} session={list.workflow?.manualAi?.cards}
              disabled={workflowBusy || stale || levelsDirty || selectedCount === 0 || (pendingFilterCount > 0 && !partialFilterApplied)}
              running={workflowBusy} beforeExport={saveDraft} onChange={manualAiChanged} pendingFilter={!!list.workflow?.pendingFilterRun} pendingCards={!!list.workflow?.pendingCardRun}
              onNext={() => { setStep('export'); setCandidateView(list.workflow?.cardRun?.drafts.some(d => d.needsReview) ? 'card_review' : 'included'); setPage(0); }} /> : <>
            {pipelineSelected && cardFields.length === 0 && <small>请至少选择一个字段。</small>}
            {cardTier === 'A0' && cardFields.includes('sentenceTranslation') && <small>A0 不调用翻译；句子含义需手动补充，或取消选择该字段。</small>}
            <div className="study-tier-choices study-pipeline-choices" role="group" aria-label="释义生成档位">
              {PIPELINE_TIERS.map((tier) => <label key={tier} className={cardTier === tier ? 'active' : ''}>
                <input type="radio" name="study-card-tier" checked={cardTier === tier} onChange={() => setCardTier(tier)} />
                <strong>{tier} · {CARD_TIERS[tier].name}</strong><small>{CARD_TIERS[tier].description}</small>
              </label>)}
            </div>
            <details open={!pipelineSelected}><summary>旧 R0–R3 档位（兼容旧草稿和续跑）</summary><div className="study-tier-choices">
              {(['R0', 'R1', 'R2', 'R3'] as const).map(tier => <label key={tier} className={cardTier === tier ? 'active' : ''}>
                <input type="radio" name="study-card-tier" checked={cardTier === tier} onChange={() => setCardTier(tier)} /><strong>{tier} · {CARD_TIERS[tier].name}</strong><small>{CARD_TIERS[tier].description}</small>
              </label>)}
            </div></details>
            <p>准备处理 {selectedCount} 词，{pipelineSelected ? cardNeedsLlm ? `基础生成约 ${pipelinePreview?.baseCalls ?? cardCalls} 次 LLM 调用，专项修复和格式重试另计。` : '零 LLM 调用。' : `预计 ${cardCalls} 次 LLM 调用；每词另需翻译词与原句。`}</p>
            {pipelinePreview && <details className="study-token-details"><summary>预计本地处理 {Math.max(0, selectedCount - pipelinePreview.aiItems)} 词 · AI {pipelinePreview.aiItems} 词 · 翻译 {pipelinePreview.translationSentences} 个输入</summary><p>预计 AI 生成 {pipelinePreview.aiItems} 词，翻译 {pipelinePreview.translationSentences} 个不同输入（含缺假名时的辞书形）。基础生成输入约 {pipelinePreview.estimatedInputTokens} tokens，输出上限 {pipelinePreview.outputTokenLimit}；修复和重试另计。这是每个请求最大输出的总和，并非预计用量或实际扣费；修复和重试另计。</p></details>}
            {pipelineSelected && <small>同一翻译输入只请求一次；A1/A2 允许多个词义，A3/A4 才按语境选义。未选择字段不因缺失而待审。不会自动下载词典。</small>}
            {pipelineSelected && <label className="study-budget-field">本次新增卡数（留空不限）<input aria-label="本次新增卡数" type="number" min={1} max={10000} value={newCardLimit} onChange={event => setNewCardLimit(event.target.value)} />
              <small>先处理阅读优先度高的词；已完成卡保留，其余下次继续。上方消耗预览为全部已选词。</small>{limitInvalid && <small>请输入 1–10000 的整数。</small>}
            </label>}
            <div className="study-engine-fields">
              {cardNeedsTranslation && <label>翻译引擎 <select aria-label="制卡翻译配置" value={translationProfileId} onChange={(event) => setTranslationProfileId(event.target.value)}>
                <option value="">{cardTranslationRequired ? '选择翻译配置' : '不提供翻译参考（可选）'}</option>{translationSettings?.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · 中文译文{profile.capabilities?.sourceReading === 'romaji' ? '＋原文罗马音（可能缺失）' : profile.capabilities?.sourceReading === 'kana' ? '＋原文假名' : ''}</option>)}
              </select></label>}
              {cardNeedsLlm && <label>LLM 配置 <select aria-label="制卡 LLM 配置" value={cardProfileId} onChange={(event) => setCardProfileId(event.target.value)}>
                <option value="">选择 LLM 配置</option>{llmSettings?.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}
              </select></label>}
            </div>
            {pipelineSelected && cardNeedsLlm && <label className="study-budget-field">生成阶段 token 预算（留空不限）<input aria-label="制卡 token 预算" type="number" min={1000} step={1000} value={tokenBudget} onChange={event => setTokenBudget(event.target.value)} />
              <small>包含修复和重试；预算不足的卡暂缓，之后可提高预算继续。未报告用量时保守估算，实际用量可能超出估算。</small>{budgetInvalid && <small>请输入至少 1000 的整数。</small>}
            </label>}
            {cardNeedsLlm && <details className="study-run-settings"><summary>运行设置 · {pipelineSelected && tokenBudget ? '预算模式并发 1' : `并发 ${cardConcurrency}`}</summary>
              <select aria-label="制卡并发数" value={cardConcurrency} onChange={(event) => setCardConcurrency(Number(event.target.value) as 1 | 2 | 3)}>
                <option value={1}>并发 1 · 低负载</option><option value={2}>并发 2 · 推荐</option><option value={3}>并发 3 · 较快</option>
              </select>
            </details>}
            {cardRun && <small>上次：{cardRun.tier} · {cardRun.stats?.llmCalls ?? '—'} 次 Harness 调用{needsLlm(cardRun.tier) ? llmStatsText(cardRun.stats) : ''} · {cardRun.stats?.translationCalls ?? '—'} 次翻译服务调用 · {Math.round((cardRun.stats?.elapsedMs ?? 0) / 1000)} 秒。{cardRun.pipeline && `预算记账 ${cardRun.pipeline.budgetUsed} / ${cardRun.pipeline.tokenBudget ?? '不限'} tokens。`}</small>}
            {list.workflow?.pendingCardRun && <small>已完成 {pendingCardCount} 张草稿；保持档位与配置可续跑。</small>}
            {list.workflow?.pendingCardRun?.lastError && <p className="study-checkpoint-warning">上次中断：{list.workflow.pendingCardRun.lastError}</p>}
            <div className="study-flow-actions">
              <button type="button" className="btn btn-sm btn-primary" disabled={selectedCount === 0 || (pipelineSelected && cardFields.length === 0) || (!partialFilterApplied && (pendingFilterCount > 0 || (!pipelineSelected && wordReviewCount > 0))) || (cardTranslationRequired && !translationProfileId) || (cardNeedsLlm && !cardProfileId) || budgetInvalid || limitInvalid || workflowBusy || stale || levelsDirty} onClick={() => void makeCards()}>{list.workflow?.pendingCardRun ? '续跑未完成任务' : cardRun ? '继续生成未完成卡' : `生成 ${selectedCount} 张释义草稿`}</button>
              {pipelineSelected && list.workflow?.pendingCardRun && <button type="button" className="btn btn-sm" disabled={workflowBusy} onClick={() => { if (window.confirm('放弃旧释义检查点，并按当前档位和配置重新生成？')) void makeCards(true); }}>放弃旧检查点并重新生成</button>}
              {pipelineSelected && cardRun && !list.workflow?.pendingCardRun && <button type="button" className="btn btn-sm" disabled={workflowBusy} onClick={() => { if (window.confirm('按当前设置重新生成全部已选词卡？将覆盖这些词的已有草稿和人工卡面修改，并重新消耗所需翻译/LLM 用量。')) void makeCards(true); }}>重新生成全部词卡</button>}
              {cardRun && <button type="button" className="btn btn-sm" onClick={() => setStep('export')}>查看已有草稿</button>}
            </div>
            </>}
          </section>}
          {step === 'export' && <section className="study-flow-section">
            <h3>制卡</h3>
            <button type="button" className="btn btn-sm" onClick={() => void navigateTo('meaning')}>返回第 4 步，调整生成设置</button>
            <p>逐张修改卡面、句子、译文与出处。导出只组装已有草稿，不再调用翻译或 LLM。</p>
            <div className="study-preview-total"><strong>释义草稿 {cardRun?.drafts.length ?? pendingCardCount} 张</strong><span>已通过 {readyCount} · 待审 {reviewCount} · 暂缓 {deferredCount}</span></div>
            {cardRun && isPipelineTier(cardRun.tier) && <p>导出 {readyCount} 张已通过卡；待审与暂缓卡保留，可稍后修正或提高预算续跑。A0/A1 和 A2/A3 本地项为词典参考卡，未声称已确认语境义。</p>}
            {deferredCount > 0 && <button type="button" className="btn btn-sm" onClick={() => setStep('meaning')}>返回继续暂缓卡，可提高预算或调整新增数量</button>}
            {reviewCount > 0 && <button type="button" className="btn btn-sm" onClick={() => { setCandidateView('card_review'); setQuery(''); setLevel('all'); setPage(0); }}>查看 {reviewCount} 张待审词卡</button>}
            <h4>漫画配图</h4>
            <div className="study-tier-choices study-image-choices" role="group" aria-label="漫画配图方式">
              {([['none', '不带图', '只导出词语、原句和释义；包体积最小。'], ['crop', '文字框截图', '裁取目标原文所在的 OCR 文字框；当前默认。'], ['page', '整页漫画', '保留整页画面；同页只存一份，包体积可能增加。']] as const).map(([mode, title, detail]) =>
                <label key={mode} className={(list.workflow?.imageMode ?? 'crop') === mode ? 'active' : ''}>
                  <input type="radio" name="study-image-mode" checked={(list.workflow?.imageMode ?? 'crop') === mode} disabled={imageSaving || workflowBusy} onChange={() => void chooseImageMode(mode)} />
                  <strong>{title}</strong><small>{detail}</small>
                </label>)}
            </div>
            <small>配图方式按本书保存；随时切换，不会重新运行第 4 步。</small>
            {!cardRun && <p>要导出 .apkg，请先在第 4 步生成释义草稿；旧版 TSV 可直接导出当前词单。</p>}
            {exportBlockReason && <p className="study-checkpoint-warning" role="status">暂不能导出：{exportBlockReason}</p>}
            <div className="study-flow-actions">
              <button type="button" className="btn btn-sm btn-primary" disabled={!!exportBlockReason} title={exportBlockReason || undefined} onClick={() => void exportPackage()}>制卡并导出{cardRun && isPipelineTier(cardRun.tier) ? ` ${readyCount} 张已通过卡` : ''} · {list.workflow?.imageMode === 'none' ? '不带图' : list.workflow?.imageMode === 'page' ? '整页漫画' : '文字框截图'}</button>
              <button type="button" className="btn btn-sm" disabled={selectedCount === 0 || (!partialFilterApplied && wordReviewCount > 0) || workflowBusy} onClick={() => void exportAnki()}>导出旧版 TSV</button>
            </div>
          </section>}
        {bookTask && <div className="study-workflow-progress" role="status">
          {bookTask.kind === 'filter' ? 'AI 筛选' : '释义生成'}：{bookTask.status === 'queued'
            ? `排队第 ${(studyQueue?.pending.findIndex((item) => item.id === bookTask.id) ?? 0) + 1} 位`
            : `${bookTask.done} / ${bookTask.total} 词`}
          {bookTask.kind === 'filter' && filterProgress && <span>临时判断：保留 {filterCounts.keep} · 排除 {filterCounts.reject} · 待审 {filterCounts.review} · {filterCounts.llmCalls || list.workflow?.pendingFilterRun?.stats?.llmCalls || 0} 次请求
            {filterProgress.filter?.httpAttempts !== undefined && ` · 实际 HTTP ${filterProgress.filter.httpAttempts} 次`}
            {filterProgress.filter?.cacheHitTokens !== undefined && filterProgress.filter.cacheMissTokens !== undefined && filterProgress.filter.cacheHitTokens + filterProgress.filter.cacheMissTokens > 0 &&
              ` · 输入缓存命中 ${Math.round(100 * filterProgress.filter.cacheHitTokens / (filterProgress.filter.cacheHitTokens + filterProgress.filter.cacheMissTokens))}%`}
            {remainingMinutes !== null && ` · 按当前速度约剩余 ${remainingMinutes} 分钟`}</span>}
          <button type="button" className="btn btn-sm" onClick={() => void api.study.cancelTask(bookTask.id)}>{bookTask.status === 'queued' ? '取消排队' : '停止任务'}</button>
          <small>任务在后台继续运行；可返回书库，右下角查看进度。</small>
        </div>}
        {localWorkflowBusy && !bookTask && <div className="study-workflow-progress" role="status">组装 Anki 卡组：{workflowProgress?.done ?? 0} / {workflowProgress?.total ?? '…'}</div>}
      </aside>
      <div className="study-candidate-area">
      <div className="study-filters">
        <strong>{step === 'export' ? '词卡审核' : '候选词列表'}</strong><small>{step === 'export' ? '只显示已选词。待核对需要人工确认；可导出已通过；暂缓保留待处理；未生成尚无卡片。' : step === 'rules' ? '按当前规则预览保留与排除。点击“应用规则”后生效。' : '已选词进入制卡；AI 不确定是其中需要核对的词。切换列表不会改变选择。'}</small>
        <div className="study-view-tabs" role="group" aria-label="词表视图">
          {(step === 'export' ? [['card_review','待核对'],['ready','可导出'],['deferred','暂缓'],['missing','未生成'],['all','全部已选词']]
            : step === 'rules' ? [['included','规则保留'],['excluded','规则排除'],['all','全部候选']]
            : [['included','已选词'],['excluded','未选词'],...(['ai','review'].includes(step) ? [['review','AI 不确定']] : []),['all','全部候选']]).map(([value, label]) =>
            <button type="button" key={value} className={candidateView === value ? 'active' : ''} aria-pressed={candidateView === value} onClick={() => { setCandidateView(value as CandidateView); setPage(0); }}>
              {label} <span>{list.candidates.filter(item => inCandidateView(item, value as CandidateView)).length}</span>
            </button>)}

        </div>
        <input className="segment-search" type="search" placeholder="搜索词语或读音" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
        <select aria-label="仅调整列表显示的 JLPT 等级" value={level} onChange={(event) => { setLevel(event.target.value as LevelFilter); setPage(0); }}>
          <option value="n3plus">N3–N1</option><option value="n2plus">N2–N1</option><option value="all">全部等级</option>
          <option value="n1">仅 N1</option><option value="n2">仅 N2</option><option value="n3">仅 N3</option>
          <option value="n4">仅 N4</option><option value="n5">仅 N5</option><option value="unknown">等级未知</option>
        </select>
        <select aria-label="候选排序" value={sortMode} onChange={(event) => { setSortMode(event.target.value as 'count' | 'priority'); setPage(0); }}>
          <option value="count">按出现次数</option><option value="priority">阅读优先度（重复 / 跨页 / 词频）</option>
        </select>
        <span>当前显示 {filtered.length} / {list.candidates.length} 词</span>
      </div>
      <div className="study-content">
        <div className="study-list" role="listbox" aria-label="学习候选词">
          {visible.map((item) => {
            const pending = liveFilterDecisions[item.id] ?? list.workflow?.pendingFilterRun?.decisions[item.id];
            const decision = pending ?? list.workflow?.filterRun?.decisions[item.id];
            const included = step === 'rules' ? previewIds.has(item.id) : item.selected && !item.excluded;
            const reason = step === 'rules' ? directResult.reasons[item.id]?.join('；') : decision?.reason;
            const card = cardRun?.drafts.find(draft => draft.candidateId === item.id);
            const status = step === 'export' && card?.status === 'deferred' ? '暂缓'
              : step === 'export' && card && readyDraft(card, cardRun!.tier) ? '可导出'
              : step === 'export' && card ? '待核对'
              : step === 'export' ? '未生成'
              : item.excluded ? '手动排除' : item.forceInclude ? '手动保留'
              : step === 'rules' ? included ? '预计保留' : '预计排除'
                : !pending && decision?.decision === 'review' ? 'AI 待审'
                  : !pending && decision?.decision === 'reject' ? 'AI 排除'
                    : included ? '准备制卡' : '未纳入';
            return <div className={`study-row${active?.id === item.id ? ' active' : ''}`} key={item.id} role="option" aria-selected={active?.id === item.id}>
            <button type="button" onClick={() => void switchCandidate(item.id)}>
              <strong>{item.expression}</strong><span>{item.reading || '读音待确认'}</span>
              <span className="study-level">{item.jlpt ? `N${item.jlpt}${item.jlptConflict ? '?' : ''}` : '未知'}</span>
              <span>×{item.count}</span>
              <span className={`study-decision-badge ${included ? 'included' : 'excluded'}`} title={reason}>{status}</span>
              {pending?.decision === 'keep' && <span className="study-filter-preview" title={pending.reason}>暂保留</span>}
              {pending?.decision === 'review' && <span className="study-filter-preview" title={pending.reason}>{partialFilterApplied ? '已纳入待审' : '暂待审'}</span>}
              {pending?.decision === 'reject' && <span className="study-filter-preview" title={pending.reason}>暂排除</span>}
              {item.exportedAt && <span>已导出</span>}
            </button>
          </div>; })}
          {filtered.length === 0 && <div className="segment-empty">当前视图没有词。可切换“全部”或清空搜索条件。</div>}
          <div className="study-pages">
            <button type="button" className="btn btn-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
            <span>{filtered.length === 0 ? 0 : Math.min(page * PAGE_SIZE + 1, filtered.length)}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} / {filtered.length}</span>
            <button type="button" className="btn btn-sm" disabled={(page + 1) * PAGE_SIZE >= filtered.length} onClick={() => setPage(page + 1)}>下一页</button>
          </div>
        </div>
        <div className="study-detail">
          {active ? <>
            <h3>{step === 'export' && currentCard ? cardEdit.expression : active.expression} <small>{step === 'export' && currentCard ? cardEdit.reading : active.reading || '读音未知'}</small></h3>
            {step !== 'export' && <div className="study-detail-meta">{active.partOfSpeech}{active.posDetail && ` / ${active.posDetail}`} · {active.jlpt ? `参考 N${active.jlpt}` : 'JLPT 未知'} · 出现 {active.count} 次
              {active.pageCount !== undefined && ` / ${active.pageCount} 页`}
              {typeof active.zipf === 'number' ? ` · 通用 Zipf ${active.zipf}` : list.wordfreqSource ? ' · 通用词频未收录' : ''}
            </div>}
            {step !== 'export' && active.jlptConflict && <p>词表中有多个等级记录，请人工核对。</p>}
            {step !== 'export' && <div className="study-reasons">
              <strong>{step === 'rules' ? previewIds.has(active.id) ? '按草稿规则：预计保留' : '按草稿规则：预计排除' : active.selected && !active.excluded ? '当前准备制卡' : '当前未纳入词单'}</strong>
              {directResult.reasons[active.id]?.length ? <ul>{(directResult.reasons[active.id] ?? []).map((reason) => <li key={reason}>{reason}</li>)}</ul> : <p>没有命中排除规则。</p>}
              {list.workflow?.filterRun?.decisions[active.id] && <p>AI：{({ keep: '保留', reject: '排除', review: '待审' } as const)[list.workflow.filterRun.decisions[active.id]!.decision]} · {list.workflow.filterRun.decisions[active.id]?.reason}</p>}
              {active.forceInclude && <p>已手动保留，跳过自动规则和 AI 筛选。</p>}
            </div>}
            {step === 'rules' && <label>代表例句
              <select value={active.contextRef} disabled={pendingFilterCount > 0 || workflowBusy} onChange={(event) => void patchOne(active.id, { contextRef: event.target.value })}>
                {active.occurrences.map((one) => <option key={one.id} value={one.id}>{one.label} · {one.start + 1}</option>)}
              </select>
            </label>}
            {step !== 'export' && shownOccurrence && <div className="study-context">{highlightedContext(shownOccurrence)}</div>}
            {step === 'review' && <div className="study-decision-controls" role="group" aria-label={`对 ${active.expression} 的人工决定`}>
              <strong>手动筛词</strong>
              <div>
                <button type="button" className="btn btn-sm" disabled={pendingFilterCount > 0 || workflowBusy} aria-pressed={active.forceInclude === true && !active.excluded} onClick={() => void decideOne(active, active.forceInclude && !active.excluded ? 'auto' : 'keep')}>手动保留</button>
                <button type="button" className="btn btn-sm" disabled={pendingFilterCount > 0 || workflowBusy} aria-pressed={active.excluded} onClick={() => void decideOne(active, active.excluded ? 'auto' : 'exclude')}>手动排除</button>
              </div>
              <small>再点一次已选项会撤销人工决定，恢复已应用的规则或 AI 结果。</small>
              {pendingFilterCount > 0 && <small>已有 AI 检查点。请先在 AI 步骤续跑或明确放弃检查点，再修改词条。</small>}
            </div>}
            {step === 'rules' && <details className="study-edit-term"><summary>修正候选词</summary>
              <fieldset disabled={pendingFilterCount > 0 || workflowBusy}>
                <label>词语 / 辞书形<input value={draft.expression} onChange={(event) => setDraft((previous) => ({ ...previous, expression: event.target.value }))} /></label>
                <label>读音<input value={draft.reading} onChange={(event) => setDraft((previous) => ({ ...previous, reading: event.target.value }))} /></label>
                <label>词义 / 卡背备注<textarea value={draft.meaning} onChange={(event) => setDraft((previous) => ({ ...previous, meaning: event.target.value }))} /></label>
                <button type="button" className="btn btn-sm" onClick={() => void saveDraft()}>保存词条修改</button>
              </fieldset>
            </details>}
            {step === 'export' && currentCard && <details open className="study-card-evidence"><summary>原文、词典证据与卡片预览</summary>
              {cardRun?.pipeline?.evidence[active!.id]?.map(evidence => <div key={evidence.id}><strong>{evidence.dictionary} · {evidence.reading}</strong><div dangerouslySetInnerHTML={{ __html: sanitizeGlossaryHtml(evidence.text) }} /></div>)}
              {shownOccurrence && <div className="study-context">{highlightedContext(shownOccurrence)}</div>}
              <div className="study-card-preview"><strong>当前卡片预览</strong><div>{cardEdit.expression}{cardEdit.reading ? `（${cardEdit.reading}）` : ''}</div><hr />
                {(!currentCard.fields || currentCard.fields.includes('meaning')) && <div>{cardEdit.meaning || '词义待补充'}</div>}
                {(!currentCard.fields || currentCard.fields.includes('sentence')) && <div>{cardEdit.sentence}</div>}
                {(!currentCard.fields || currentCard.fields.includes('sentenceTranslation')) && <div>{cardEdit.sentenceTranslation}</div>}
                {currentCard.fields?.includes('lemma') && <div>辞书形：{cardEdit.lemma}</div>}<small>{cardEdit.sourceLabel}</small></div>
            </details>}
            {step === 'export' && currentCard && <div className="study-card-draft">
              <h4>{cardRun?.tier} 卡片草稿 {currentCard.needsReview && <span>· 待审核</span>}</h4>
              {!currentCard.issues?.length && currentCard.reviewReason && <p className="study-issue">{currentCard.reviewReason}</p>}
              {currentCard.referenceOnly && <small>词典参考卡：词义保留原词典内容，尚未由 AI 核对本句义项。</small>}
              {currentCard.readingSource === 'translation_romaji' && <small>假名由翻译返回的罗马音推导，请留意读音与拼写。</small>}
              {currentCard.readingSource === 'external_ai' && <small>假名由外部 AI 提供。</small>}
              {!!currentCard.repairs && <small>系统已尝试 {currentCard.repairs} 次修复。</small>}
              {currentCard.issues?.map((issue, index) => <p className="study-issue" key={index}>需核对 {({ meaning: '词义', reading: '读音', sentence: '原句', sentenceTranslation: '句译', usage: '提示' })[issue.field]}：{issue.reason}</p>)}
              <fieldset disabled={workflowBusy}>
              <label>词语／正面<input value={cardEdit.expression} onChange={(event) => setCardEdit((old) => ({ ...old, expression: event.target.value }))} /></label>
              {currentCard.fields?.includes('lemma') && <label>辞书形<input value={cardEdit.lemma} onChange={(event) => setCardEdit((old) => ({ ...old, lemma: event.target.value }))} /></label>}
              {(!currentCard.fields || currentCard.fields.includes('reading')) && <label data-card-field="reading" className={currentCard.issues?.some(issue => issue.field === 'reading') ? 'has-issue' : ''}>{currentCard.fields ? '读音（辞书形）' : '读音'}<input value={cardEdit.reading} onChange={(event) => setCardEdit((old) => ({ ...old, reading: event.target.value }))} /></label>}
              {(!currentCard.fields || currentCard.fields.includes('sentence')) && <label>原句／正面<textarea value={cardEdit.sentence} onChange={(event) => setCardEdit((old) => ({ ...old, sentence: event.target.value }))} /></label>}
              {(!currentCard.fields || currentCard.fields.includes('meaning')) && <label data-card-field="meaning" className={currentCard.issues?.some(issue => issue.field === 'meaning') ? 'has-issue' : ''}>本词含义<input value={cardEdit.meaning} onChange={(event) => setCardEdit((old) => ({ ...old, meaning: event.target.value }))} /></label>}
              {(!currentCard.fields || currentCard.fields.includes('sentenceTranslation')) && <label data-card-field="sentenceTranslation" className={currentCard.issues?.some(issue => issue.field === 'sentenceTranslation') ? 'has-issue' : ''}>原句中文译文<textarea value={cardEdit.sentenceTranslation} onChange={(event) => setCardEdit((old) => ({ ...old, sentenceTranslation: event.target.value }))} /></label>}
              <label>用法提示<textarea value={cardEdit.usage} onChange={(event) => setCardEdit((old) => ({ ...old, usage: event.target.value }))} /></label>
              <label>语气／义项差别<textarea value={cardEdit.nuance} onChange={(event) => setCardEdit((old) => ({ ...old, nuance: event.target.value }))} /></label>
              <label>来源文字<input value={cardEdit.sourceLabel} onChange={(event) => setCardEdit((old) => ({ ...old, sourceLabel: event.target.value }))} /></label>
              <label>原图出处<select value={cardEdit.contextRef} onChange={(event) => {
                const occurrence = active.occurrences.find((one) => one.id === event.target.value);
                if (occurrence) setCardEdit((old) => ({ ...old, contextRef: occurrence.id, sentence: occurrence.text, sourceLabel: `${bookTitle} · ${occurrence.label}` }));
              }}>{active.occurrences.map((one) => <option key={one.id} value={one.id}>{one.label} · {one.start + 1}</option>)}</select></label>
              <div className="study-workflow-controls">
                <button type="button" className="btn btn-sm" onClick={() => void saveCardDraft()}>保存卡片草稿</button>
                {currentCard.needsReview && <button type="button" className="btn btn-sm btn-primary" onClick={() => void saveCardDraft(true)}>确认通过，下一张</button>}
                <button type="button" className="btn btn-sm" onClick={() => void deferCard()}>暂缓，下一张</button>
              </div>
              </fieldset>
              <small>改变原图出处会更新默认原句与来源文字；配图方式在左侧独立选择。</small>
            </div>}

            {step === 'rules' && chosenOccurrence && <div className="study-phrase">
              <strong>从这一文字块添加短语</strong>
              <input value={phrase} onChange={(event) => setPhrase(event.target.value)} placeholder="输入原文中的连续短语" />
              <input value={phraseReading} onChange={(event) => setPhraseReading(event.target.value)} placeholder="读音（可稍后补）" />
              <button type="button" className="btn btn-sm" disabled={!phrase.trim() || pendingFilterCount > 0 || workflowBusy} onClick={() => void addPhrase()}>加入清单</button>
            </div>}
          </> : <div className="segment-empty">选择词语查看原句、筛选原因与人工决定。</div>}
        </div>
      </div>
      <div className="study-footer">JLPT 参考来源：{list.jlptSource}（非官方）。Anki 卡组导出为 .apkg；旧 TSV 导入时请确认正面、背面和标签列。</div>
      </div>
      </div>
    </>}
  </div>;
}
