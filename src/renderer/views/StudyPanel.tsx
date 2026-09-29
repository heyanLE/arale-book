/** 漫画学习候选审核：JLPT 筛选、出处核对、人工短语和 Anki 导出。 */
import { useEffect, useMemo, useState } from 'react';
import type { DirectFilterOptions, LlmSettings, StudyCandidate, StudyCandidatePatch, StudyCardTier, StudyFilterDecision, StudyFilterTier, StudyList, StudyOccurrence, StudyRunProgress, TranslationSettings } from '@shared/types';
import { CARD_TIERS, DEFAULT_STUDY_LEVELS, FILTER_TIERS, defaultDirectOptions, directFilterStages, estimatedLlmCalls, normalizeDirectOptions, studyPriorityScore } from '@core/study/harness';
import { api, call, useIpcEvent } from '../lib/api';
import { DirectFilterPanel } from './DirectFilterPanel';

type LevelFilter = 'all' | 'n3plus' | 'n2plus' | 'n1' | 'n2' | 'n3' | 'n4' | 'n5' | 'unknown';
type StudyStep = 'rules' | 'ai' | 'review' | 'cards';
type CandidateView = 'included' | 'excluded' | 'review' | 'manual' | 'all';
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
  const [cardTier, setCardTier] = useState<StudyCardTier>('R0');
  const [filterConcurrency, setFilterConcurrency] = useState<1 | 2 | 3>(2);
  const [cardConcurrency, setCardConcurrency] = useState<1 | 2 | 3>(2);
  const [filterProfileId, setFilterProfileId] = useState('');
  const [cardProfileId, setCardProfileId] = useState('');
  const [translationProfileId, setTranslationProfileId] = useState('');
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const [workflowProgress, setWorkflowProgress] = useState<StudyRunProgress | null>(null);
  const [liveFilterDecisions, setLiveFilterDecisions] = useState<Record<string, { decision: StudyFilterDecision; reason: string }>>({});
  const [cardEdit, setCardEdit] = useState({ meaning: '', sentenceTranslation: '', usage: '', nuance: '' });

  useEffect(() => {
    let live = true;
    setLoading(true);
    void Promise.all([
      call('读取制卡清单', () => api.study.read(bookId)),
      call('读取 LLM 配置', () => api.llm.settings()),
      call('读取翻译配置', () => api.translation.settings()),
    ]).then(([value, llm, translation]) => {
      if (!live) return;
      setList(value); setLoading(false);
      setStep(value?.workflow?.cardRun ? 'cards' : value?.workflow?.filterRun ? 'review' : 'rules');
      setCandidateView('included');
      setLiveFilterDecisions(value?.workflow?.pendingFilterRun?.decisions ?? {});
      setLevels(value?.workflow?.levels ?? [...DEFAULT_STUDY_LEVELS]);
      setIncludeUnknown(value?.workflow?.includeUnknown ?? false);
      setDirectOptions(normalizeDirectOptions(value?.workflow?.direct));
      setExcludedWordsText((value?.workflow?.direct?.excludedWords ?? []).join('\n'));
      setLlmSettings(llm);
      setTranslationSettings(translation);
      setFilterTier(value?.workflow?.pendingFilterRun?.tier ?? value?.workflow?.filterRun?.tier ?? 'F1');
      setCardTier(value?.workflow?.pendingCardRun?.tier ?? value?.workflow?.cardRun?.tier ?? 'R0');
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
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (list?.candidates ?? []).filter((item) => {
      const included = step === 'rules' ? previewIds.has(item.id) : item.selected && !item.excluded;
      const inView = candidateView === 'all' || (candidateView === 'included' && included) ||
        (candidateView === 'excluded' && !included) || (candidateView === 'manual' && (item.forceInclude === true || item.excluded));
      const review = !item.forceInclude && !item.excluded &&
        (list?.workflow?.filterRun?.decisions[item.id]?.decision === 'review' ||
          liveFilterDecisions[item.id]?.decision === 'review');
      if (candidateView === 'review') return review && passesLevel(item, level) &&
        (!needle || item.expression.toLowerCase().includes(needle) || item.reading.includes(needle));
      return inView && passesLevel(item, level) &&
        (!needle || item.expression.toLowerCase().includes(needle) || item.reading.includes(needle));
    });
    if (sortMode === 'priority') matches.sort((a, b) => studyPriorityScore(b) - studyPriorityScore(a) || b.count - a.count || (a.expression < b.expression ? -1 : a.expression > b.expression ? 1 : 0));
    return matches;
  }, [list, query, level, candidateView, sortMode, step, previewIds, liveFilterDecisions]);
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const active = filtered.find((item) => item.id === activeId) ?? filtered[0] ?? null;
  const selectedCount = list?.candidates.filter((item) => item.selected && !item.excluded).length ?? 0;
  const incompleteCount = list?.workflow?.cardRun
    ? list.workflow.cardRun.drafts.filter((item) => !item.meaning || !item.sentenceTranslation).length
    : list?.candidates.filter((item) => item.selected && !item.excluded && (!item.reading || !item.meaning)).length ?? 0;
  const chosenOccurrence = active?.occurrences.find((one) => one.id === active.contextRef) ?? active?.occurrences[0];
  const stale = list !== null && list.segmentGeneratedAt !== segmentGeneratedAt;
  const cardRun = list?.workflow?.cardRun;
  const wordReviewCount = list?.candidates.filter((item) => item.selected && !item.excluded && !item.forceInclude &&
    (list.workflow?.filterRun?.decisions[item.id]?.decision === 'review' ||
      (list.workflow?.partialFilterAppliedAt && list.workflow.pendingFilterRun?.decisions[item.id]?.decision === 'review'))).length ?? 0;
  const pendingCardCount = list?.workflow?.pendingCardRun?.drafts.length ?? 0;
  const currentCard = cardRun?.drafts.find((item) => item.candidateId === active?.id);
  const reviewCount = cardRun?.drafts.filter((item) => item.needsReview).length ?? 0;
  const filterCalls = estimatedLlmCalls(llmPreviewCount, FILTER_TIERS[filterTier]);
  const cardCalls = estimatedLlmCalls(selectedCount, CARD_TIERS[cardTier]);
  const pendingFilterCount = Object.keys(liveFilterDecisions).length;
  const pendingFilter = list?.workflow?.pendingFilterRun;
  const partialFilterApplied = pendingFilterCount > 0 && !!list?.workflow?.partialFilterAppliedAt;
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
    setDraft({ expression: active?.expression ?? '', reading: active?.reading ?? '', meaning: active?.meaning ?? '' });
  }, [active?.id]);

  useEffect(() => {
    setCardEdit({
      meaning: currentCard?.meaning ?? '', sentenceTranslation: currentCard?.sentenceTranslation ?? '',
      usage: currentCard?.usage ?? '', nuance: currentCard?.nuance ?? '',
    });
  }, [active?.id, cardRun?.completedAt]);

  async function generate(): Promise<void> {
    const savedDrafts = cardRun?.drafts.length ?? pendingCardCount;
    if (list && (savedDrafts > 0 || list.workflow?.filterRun) &&
      !window.confirm(`重新生成候选会清除上次 AI 筛选结果${savedDrafts > 0 ? `和 ${savedDrafts} 张制卡草稿` : ''}，人工词条修改会保留。继续？`)) return;
    setGenerating(true);
    setProgress({ done: 0, total: 0 });
    setNotice('');
    const next = await call('生成学习候选', () => api.study.generate(bookId));
    if (next) { setList(next); setActiveId(null); setPage(0); setNotice(`已生成 ${next.candidates.length} 个候选词`); }
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

  async function switchCandidate(id: string): Promise<void> {
    if (!await saveDraft()) return;
    if (!await saveCardDraft()) return;
    setActiveId(id);
  }

  async function decideFiltered(decision: 'keep' | 'exclude'): Promise<void> {
    if (!window.confirm(`将当前列表中的 ${filtered.length} 个词全部标为“手动${decision === 'keep' ? '保留' : '排除'}”？此操作会修改正式词单。`)) return;
    const patch = decision === 'keep'
      ? { forceInclude: true, excluded: false, selected: true }
      : { forceInclude: false, excluded: true, selected: false };
    const next = await call('批量修改人工决定', () => api.study.patchMany(bookId, filtered.map((item) => item.id), patch));
    if (next) setList(next);
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
    await patchOne(item.id, patch);
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
    setWorkflowBusy(true); setWorkflowProgress({ bookId, stage: 'filter', done: Object.keys(saved).length, total: llmPreviewCount });
    setNotice('正在逐批筛选；下方会显示临时判断，全部完成后才正式更新选择。');
    const next = await call('运行 LLM 筛选 Harness', () => api.study.runFilter(bookId, { tier: filterTier, profileId: filterProfileId, concurrency: filterConcurrency }));
    if (next) {
      setList(next);
      setLiveFilterDecisions({});
      const decisions = Object.values(next.workflow?.filterRun?.decisions ?? {});
      setLevel('all'); setCandidateView(decisions.some((one) => one.decision === 'review') ? 'review' : 'included'); setPage(0); setStep('review');
      setNotice(`筛选完成：保留 ${decisions.filter((one) => one.decision === 'keep').length}，待审 ${decisions.filter((one) => one.decision === 'review').length}，排除 ${decisions.filter((one) => one.decision === 'reject').length}`);
    } else {
      const checkpoint = await call('读取筛选检查点', () => api.study.read(bookId));
      if (checkpoint) {
        setList(checkpoint);
        const pending = checkpoint.workflow?.pendingFilterRun?.decisions ?? {};
        setLiveFilterDecisions(pending);
        const reason = checkpoint.workflow?.pendingFilterRun?.lastError;
        setNotice(`本次筛选已中断：${reason ?? '未知原因'}。已保存 ${Object.keys(pending).length} 个临时判断；保持档位和配置可续跑。`);
      }
    }
    setWorkflowBusy(false); setWorkflowProgress(null);
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

  async function makeCards(): Promise<void> {
    if (!translationProfileId || (cardTier !== 'R0' && !cardProfileId) || !await saveDraft()) return;
    setWorkflowBusy(true); setWorkflowProgress({ bookId, stage: 'cards', done: 0, total: selectedCount });
    const next = await call('运行制卡 Harness', () => api.study.runCards(bookId, {
      tier: cardTier, translationProfileId, concurrency: cardConcurrency,
      ...(cardTier === 'R0' ? {} : { profileId: cardProfileId }),
    }));
    if (next) { setList(next); setStep('cards'); setNotice(`已制作 ${next.workflow?.cardRun?.drafts.length ?? 0} 张草稿，存疑项请先审核`); }
    else {
      const checkpoint = await call('读取制卡检查点', () => api.study.read(bookId));
      if (checkpoint) { setList(checkpoint); setNotice(`已保存 ${checkpoint.workflow?.pendingCardRun?.drafts.length ?? 0} 张草稿，重试可续跑。`); }
    }
    setWorkflowBusy(false); setWorkflowProgress(null);
  }

  async function saveCardDraft(approve = false): Promise<boolean> {
    if (!currentCard || !active) return true;
    const patch = {
      ...cardEdit,
      ...(approve ? { needsReview: false as const } : {}),
    };
    const next = await call('保存 Anki 卡片草稿', () => api.study.patchCard(bookId, active.id, patch));
    if (next) setList(next);
    return next !== null;
  }

  async function exportPackage(): Promise<void> {
    if (!await saveDraft() || !await saveCardDraft()) return;
    setWorkflowBusy(true); setWorkflowProgress({ bookId, stage: 'export', done: 0, total: cardRun?.drafts.length ?? 0 });
    const result = await call('导出带图 Anki 卡组', () => api.study.exportPackage(bookId));
    if (result?.path) {
      setNotice(`已导出 ${result.count} 张带漫画裁图的卡：${result.path}`);
      const next = await call('刷新制卡清单', () => api.study.read(bookId));
      if (next) setList(next);
    }
    setWorkflowBusy(false); setWorkflowProgress(null);
  }

  return <div className="study-panel">
    <div className="study-head">
      <div>
        <strong>Anki 制卡 · {bookTitle}</strong>
        <small>候选等级来自社区 JLPT 参考词表，需按漫画原文审核。</small>
      </div>
      <div className="study-head-actions">
        {generating && <button type="button" className="btn btn-sm" onClick={() => void call('取消候选生成', () => api.study.cancel(bookId))}>取消</button>}
        <button type="button" className="btn btn-sm" disabled={generating || pendingFilterCount > 0} title={pendingFilterCount > 0 ? '先续跑或放弃 AI 检查点' : undefined} onClick={() => void generate()}>{list ? '重新生成候选' : '生成候选'}</button>
      </div>
    </div>
    {step === 'cards' && incompleteCount > 0 && <div className="study-notice">{cardRun ? `有 ${incompleteCount} 张草稿缺词义或句译，需补全后导出。` : `准备制卡的词中有 ${incompleteCount} 个缺读音或释义，建议导出前核对。`}</div>}
    {stale && <div className="segment-error">分词结果已更新，请重新生成学习候选。人工选择和短语会保留。</div>}
    {generating && <div className="segment-progress">正在分析漫画文字块 · {progress?.done ?? 0} / {progress?.total ?? '…'}</div>}
    {notice && <div className="study-notice" role="status">{notice}</div>}
    {loading && <div className="segment-empty">正在读取制卡清单…</div>}
    {!loading && !list && <div className="segment-empty">先生成分词，再点“生成候选”。候选来自漫画文字块；可按 JLPT 难度筛选并逐词核对。</div>}
    {list && <>
      <nav className="study-flow-nav" aria-label="制卡步骤">
        {([['rules', '1 规则筛词'], ['ai', pendingFilterCount > 0 ? `2 AI 语境筛选 · 待续跑 ${pendingFilterCount}/${filterTotal}` : '2 AI 语境筛选 · 可跳过'], ['review', '3 确认词单'], ['cards', '4 制卡与导出']] as const).map(([value, label]) =>
          <button key={value} type="button" aria-current={step === value ? 'step' : undefined}
            disabled={workflowBusy || (levelsDirty && value !== 'rules') ||
              (value === 'cards' && !cardRun && !partialFilterApplied && (pendingFilterCount > 0 || wordReviewCount > 0))}
            onClick={() => { setStep(value); setCandidateView('included'); setPage(0); }}>{label}</button>)}
        <span>准备制卡 {selectedCount} 词</span>
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
              <button type="button" className="btn btn-sm" onClick={() => { setStep('ai'); setCandidateView('included'); }}>{pendingFilterCount > 0 ? `继续旧 AI 任务（${pendingFilterCount}/${filterTotal}）` : '继续：AI 语境筛选'}</button>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => { setStep('review'); setCandidateView('included'); }}>跳过 AI，确认词单</button>
            </>}
          </div>
        </section>}
          {step === 'ai' && <section className="study-flow-section">
            <h3>AI 语境筛选 <small>可跳过</small></h3>
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
              <button type="button" className="btn btn-sm" disabled={workflowBusy} onClick={() => { setStep('review'); setCandidateView('included'); }}>跳过 AI，确认词单</button>
            </div>
            {levelsDirty && <small>规则草稿尚未应用，请先返回规则筛词。</small>}
            {pendingFilterCount > 0 && <small>已有 {pendingFilterCount} 个临时判断；全部完成前不会改动正式选择。保持档位与配置可续跑。</small>}
            {pendingFilterMismatch && <small>旧检查点使用 {pendingFilter?.tier} / {pendingFilter?.profileId}，改档或换模型前需先放弃检查点。</small>}
            {!workflowBusy && list.workflow?.pendingFilterRun?.lastError && <small>上次中断：{list.workflow.pendingFilterRun.lastError}</small>}
            {pendingFilterCount > 0 && !workflowBusy && <div className="study-workflow-controls"><button type="button" className="btn btn-sm" onClick={() => void useCompletedFilter()}>只使用已判断的 {pendingFilterCount} 词（未处理词暂不制卡）</button><button type="button" className="btn btn-sm" onClick={() => void discardFilterProgress()}>放弃旧检查点</button></div>}
            {list.workflow?.filterRun && <small>上次：{list.workflow.filterRun.tier} · {list.workflow.filterRun.stats?.llmCalls ?? '—'} 次 LLM 调用 · {Math.round((list.workflow.filterRun.stats?.elapsedMs ?? 0) / 1000)} 秒。结果可在下方逐词修改。</small>}
          </section>}
          {step === 'review' && <section className="study-flow-section">
            <h3>确认词单</h3>
            <div className="study-preview-total"><strong>准备制卡 {selectedCount} 词</strong><span>AI 待审 {wordReviewCount} · 人工决定 {list.candidates.filter((item) => item.forceInclude || item.excluded).length}</span></div>
            <p>先检查右侧词表的待审项。点开词语可查看原句与筛选原因，并选择“按筛选结果／手动保留／手动排除”。</p>
            {pendingFilterCount > 0 && <div className="study-checkpoint-warning">
              还有 {pendingFilterCount}/{filterTotal} 项已保存的临时 AI 判断。{partialFilterApplied ? '当前只将已判断的保留／待审词纳入制卡；未处理词暂不制卡。' : '为保证能续跑，人工改词暂时锁定。'}
              <div className="study-workflow-controls"><button type="button" className="btn btn-sm" onClick={() => setStep('ai')}>返回 AI 续跑</button><button type="button" className="btn btn-sm" onClick={() => void discardFilterProgress()}>放弃检查点后人工调整</button></div>
            </div>}
            {wordReviewCount > 0 && <button type="button" className="btn btn-sm" onClick={() => { setCandidateView('review'); setPage(0); }}>查看 {wordReviewCount} 个待审词</button>}
            <div className="study-flow-actions">
              <button type="button" className="btn btn-sm" onClick={() => setStep('rules')}>返回规则</button>
              <button type="button" className="btn btn-sm btn-primary" disabled={selectedCount === 0 || ((!partialFilterApplied && wordReviewCount > 0) || (pendingFilterCount > 0 && !partialFilterApplied)) || levelsDirty || stale} onClick={() => { setStep('cards'); setCandidateView('included'); }}>继续制作 {selectedCount} 张卡</button>
            </div>
            {wordReviewCount > 0 && <small>{partialFilterApplied
              ? `当前有 ${wordReviewCount} 个已纳入的 AI 待审词；如需逐词人工决定，先放弃旧检查点。`
              : `先对 ${wordReviewCount} 个 AI 待审词作手动保留或排除。`}</small>}
          </section>}
          {step === 'cards' && <section className="study-flow-section">
            <h3>制卡与导出</h3>
            <p>{CARD_TIERS[cardTier].description} 准备制卡 {selectedCount} 词，正常约 {cardCalls} 次 LLM 调用；每词另需翻译词与原句。</p>
            <div className="study-workflow-controls">
              <select aria-label="制卡档位" value={cardTier} onChange={(event) => setCardTier(event.target.value as StudyCardTier)}>
                {(['R0', 'R1', 'R2', 'R3'] as const).map((tier) => <option key={tier} value={tier}>{tier} · {CARD_TIERS[tier].name}</option>)}
              </select>
              <select aria-label="制卡翻译配置" value={translationProfileId} onChange={(event) => setTranslationProfileId(event.target.value)}>
                <option value="">选择翻译配置</option>{translationSettings?.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
              </select>
              {cardTier !== 'R0' && <select aria-label="制卡 LLM 配置" value={cardProfileId} onChange={(event) => setCardProfileId(event.target.value)}>
                <option value="">选择 LLM 配置</option>{llmSettings?.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}
              </select>}
              {cardTier !== 'R0' && <select aria-label="制卡并发数" value={cardConcurrency} onChange={(event) => setCardConcurrency(Number(event.target.value) as 1 | 2 | 3)}>
                <option value={1}>并发 1 · 低负载</option><option value={2}>并发 2 · 推荐</option><option value={3}>并发 3 · 较快</option>
              </select>}
              <button type="button" className="btn btn-sm" disabled={selectedCount === 0 || (!partialFilterApplied && (wordReviewCount > 0 || pendingFilterCount > 0)) || !translationProfileId || (cardTier !== 'R0' && !cardProfileId) || workflowBusy || stale} onClick={() => void makeCards()}>制作卡片草稿</button>
            </div>
            {cardRun && <small>上次：{cardRun.tier} · {cardRun.stats?.llmCalls ?? '—'} 次 LLM 调用 · {cardRun.stats?.translationCalls ?? '—'} 次翻译服务调用 · {Math.round((cardRun.stats?.elapsedMs ?? 0) / 1000)} 秒。</small>}
            {cardTier !== 'R0' && <small>默认并发 2；R3 的第二轮仍按各批第一轮结果顺序执行。</small>}
            {list.workflow?.pendingCardRun && <small>上次已完成 {pendingCardCount} 张草稿；保持档位与配置可续跑。</small>}
            <h4>审核与导出</h4>
            <p>草稿 {cardRun?.drafts.length ?? 0} 张，待审 {reviewCount} 张。带图牌组为 .apkg；旧 TSV 仍可导出。</p>
            <div className="study-workflow-controls">
              <button type="button" className="btn btn-sm btn-primary" disabled={!cardRun || reviewCount > 0 || (!partialFilterApplied && wordReviewCount > 0) || workflowBusy || stale} onClick={() => void exportPackage()}>导出带图 Anki 卡组</button>
              <button type="button" className="btn btn-sm" disabled={selectedCount === 0 || (!partialFilterApplied && wordReviewCount > 0) || workflowBusy} onClick={() => void exportAnki()}>导出旧版 TSV</button>
            </div>
          </section>}
        {workflowBusy && <div className="study-workflow-progress" role="status">
          {workflowProgress?.stage === 'filter' ? 'LLM 筛选' : workflowProgress?.stage === 'cards' ? '制作卡片' : '打包漫画裁图'}：{workflowProgress?.done ?? 0} / {workflowProgress?.total ?? '…'}
          {filterProgress && <span>临时判断：保留 {filterCounts.keep} · 排除 {filterCounts.reject} · 待审 {filterCounts.review} · {filterCounts.llmCalls || list.workflow?.pendingFilterRun?.stats?.llmCalls || 0} 次请求
            {remainingMinutes !== null && ` · 按当前速度约剩余 ${remainingMinutes} 分钟`}</span>}
          <button type="button" className="btn btn-sm" onClick={() => void api.study.cancel(bookId)}>取消</button>
        </div>}
      </aside>
      <div className="study-candidate-area">
      <div className="study-filters">
        <strong>查看词表</strong><small>搜索和排序只改变显示，不修改准备制卡的词单。</small>
        <div className="study-view-tabs" role="group" aria-label="词表视图">
          {([['included', '预计保留'], ['excluded', '预计排除'], ['review', 'AI 待审'], ['manual', '人工决定'], ['all', '全部']] as const).map(([value, label]) =>
            <button type="button" key={value} className={candidateView === value ? 'active' : ''} aria-pressed={candidateView === value} onClick={() => { setCandidateView(value); setPage(0); }}>{step === 'rules' && value === 'included' ? '预计保留' : step === 'rules' && value === 'excluded' ? '预计排除' : value === 'included' ? '准备制卡' : value === 'excluded' ? '未纳入' : label}</button>)}
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
        {step === 'review' && <details className="study-batch-actions"><summary>批量人工调整</summary>
          <button type="button" className="btn btn-sm" disabled={filtered.length === 0 || pendingFilterCount > 0 || workflowBusy} onClick={() => void decideFiltered('keep')}>将当前 {filtered.length} 词手动保留</button>
          <button type="button" className="btn btn-sm" disabled={filtered.length === 0 || pendingFilterCount > 0 || workflowBusy} onClick={() => void decideFiltered('exclude')}>将当前 {filtered.length} 词手动排除</button>
        </details>}
      </div>
      <div className="study-content">
        <div className="study-list" role="listbox" aria-label="学习候选词">
          {visible.map((item) => {
            const pending = liveFilterDecisions[item.id] ?? list.workflow?.pendingFilterRun?.decisions[item.id];
            const decision = pending ?? list.workflow?.filterRun?.decisions[item.id];
            const included = step === 'rules' ? previewIds.has(item.id) : item.selected && !item.excluded;
            const reason = step === 'rules' ? directResult.reasons[item.id]?.join('；') : decision?.reason;
            const status = item.excluded ? '手动排除' : item.forceInclude ? '手动保留'
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
            <h3>{active.expression} <small>{active.reading || '读音未知'}</small></h3>
            <div className="study-detail-meta">{active.partOfSpeech}{active.posDetail && ` / ${active.posDetail}`} · {active.jlpt ? `参考 N${active.jlpt}` : 'JLPT 未知'} · 出现 {active.count} 次
              {active.pageCount !== undefined && ` / ${active.pageCount} 页`}
              {typeof active.zipf === 'number' ? ` · 通用 Zipf ${active.zipf}` : list.wordfreqSource ? ' · 通用词频未收录' : ''}
            </div>
            {active.jlptConflict && <p>词表中有多个等级记录，请人工核对。</p>}
            <div className="study-reasons">
              <strong>{step === 'rules' ? previewIds.has(active.id) ? '按草稿规则：预计保留' : '按草稿规则：预计排除' : active.selected && !active.excluded ? '当前准备制卡' : '当前未纳入词单'}</strong>
              {directResult.reasons[active.id]?.length ? <ul>{(directResult.reasons[active.id] ?? []).map((reason) => <li key={reason}>{reason}</li>)}</ul> : <p>没有命中排除规则。</p>}
              {list.workflow?.filterRun?.decisions[active.id] && <p>AI：{({ keep: '保留', reject: '排除', review: '待审' } as const)[list.workflow.filterRun.decisions[active.id]!.decision]} · {list.workflow.filterRun.decisions[active.id]?.reason}</p>}
              {active.forceInclude && <p>已手动保留，跳过自动规则和 AI 筛选。</p>}
            </div>
            <label>代表例句
              <select value={active.contextRef} disabled={pendingFilterCount > 0 || workflowBusy} onChange={(event) => void patchOne(active.id, { contextRef: event.target.value })}>
                {active.occurrences.map((one) => <option key={one.id} value={one.id}>{one.label} · {one.start + 1}</option>)}
              </select>
            </label>
            {chosenOccurrence && <div className="study-context">{highlightedContext(chosenOccurrence)}</div>}
            {(step === 'rules' || step === 'review') && <div className="study-decision-controls" role="group" aria-label={`对 ${active.expression} 的人工决定`}>
              <strong>人工决定</strong>
              <div>
                <button type="button" className="btn btn-sm" disabled={pendingFilterCount > 0 || workflowBusy} aria-pressed={!active.forceInclude && !active.excluded} onClick={() => void decideOne(active, 'auto')}>按已应用筛选结果</button>
                <button type="button" className="btn btn-sm" disabled={pendingFilterCount > 0 || workflowBusy} aria-pressed={active.forceInclude === true && !active.excluded} onClick={() => void decideOne(active, 'keep')}>手动保留</button>
                <button type="button" className="btn btn-sm" disabled={pendingFilterCount > 0 || workflowBusy} aria-pressed={active.excluded} onClick={() => void decideOne(active, 'exclude')}>手动排除</button>
              </div>
              {step === 'rules' && levelsDirty && <small>人工决定立即保存；规则草稿仍需单独应用。</small>}
              {pendingFilterCount > 0 && <small>已有 AI 检查点。请先在 AI 步骤续跑或明确放弃检查点，再修改词条。</small>}
            </div>}
            <details className="study-edit-term"><summary>修正词条与释义</summary>
              <fieldset disabled={pendingFilterCount > 0 || workflowBusy}>
                <label>词语 / 辞书形<input value={draft.expression} onChange={(event) => setDraft((previous) => ({ ...previous, expression: event.target.value }))} /></label>
                <label>读音<input value={draft.reading} onChange={(event) => setDraft((previous) => ({ ...previous, reading: event.target.value }))} /></label>
                <label>词义 / 卡背备注<textarea value={draft.meaning} onChange={(event) => setDraft((previous) => ({ ...previous, meaning: event.target.value }))} /></label>
                <button type="button" className="btn btn-sm" onClick={() => void saveDraft()}>保存词条修改</button>
              </fieldset>
            </details>
            {step === 'cards' && <div className="study-card-preview"><strong>Anki 预览</strong><div>{draft.expression}{draft.reading ? `（${draft.reading}）` : ''}</div><hr /><div>{draft.meaning || '词义待补充'}</div><div>{chosenOccurrence?.text}</div><small>{bookTitle} · {chosenOccurrence?.label}</small></div>}
            {step === 'cards' && currentCard && <div className="study-card-draft">
              <h4>{cardRun?.tier} 卡片草稿 {currentCard.needsReview && <span>· 待审核</span>}</h4>
              {currentCard.reviewReason && <p>{currentCard.reviewReason}</p>}
              <label>本句词义<input value={cardEdit.meaning} onChange={(event) => setCardEdit((old) => ({ ...old, meaning: event.target.value }))} /></label>
              <label>原句中文译文<textarea value={cardEdit.sentenceTranslation} onChange={(event) => setCardEdit((old) => ({ ...old, sentenceTranslation: event.target.value }))} /></label>
              {cardRun?.tier !== 'R0' && <>
                <label>用法提示<textarea value={cardEdit.usage} onChange={(event) => setCardEdit((old) => ({ ...old, usage: event.target.value }))} /></label>
                <label>语气 / 义项差别<textarea value={cardEdit.nuance} onChange={(event) => setCardEdit((old) => ({ ...old, nuance: event.target.value }))} /></label>
              </>}
              <div className="study-workflow-controls">
                <button type="button" className="btn btn-sm" onClick={() => void saveCardDraft()}>保存卡片草稿</button>
                {currentCard.needsReview && <button type="button" className="btn btn-sm btn-primary" onClick={() => void saveCardDraft(true)}>确认并通过审核</button>}
              </div>
              <small>导出的配图会按这一出处的 OCR 文字矩形从原页裁取。</small>
            </div>}
            {(step === 'review' || step === 'cards') && chosenOccurrence && <div className="study-phrase">
              <strong>从这一文字块添加短语</strong>
              <input value={phrase} onChange={(event) => setPhrase(event.target.value)} placeholder="输入原文中的连续短语" />
              <input value={phraseReading} onChange={(event) => setPhraseReading(event.target.value)} placeholder="读音（可稍后补）" />
              <button type="button" className="btn btn-sm" disabled={!phrase.trim() || pendingFilterCount > 0 || workflowBusy} onClick={() => void addPhrase()}>加入清单</button>
            </div>}
          </> : <div className="segment-empty">选择词语查看原句、筛选原因与人工决定。</div>}
        </div>
      </div>
      <div className="study-footer">JLPT 参考来源：{list.jlptSource}（非官方）。带图卡组导出为 .apkg；旧 TSV 导入时请确认正面、背面和标签列。</div>
      </div>
      </div>
    </>}
  </div>;
}
