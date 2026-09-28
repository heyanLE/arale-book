/** 漫画学习候选审核：JLPT 筛选、出处核对、人工短语和 Anki 导出。 */
import { useEffect, useMemo, useState } from 'react';
import type { LlmSettings, StudyCandidate, StudyCandidatePatch, StudyCardTier, StudyFilterDecision, StudyFilterTier, StudyList, StudyOccurrence, StudyRunProgress, TranslationSettings } from '@shared/types';
import { CARD_TIERS, DEFAULT_STUDY_LEVELS, FILTER_TIERS, directCandidates, estimatedLlmCalls } from '@core/study/harness';
import { api, call, useIpcEvent } from '../lib/api';

type LevelFilter = 'all' | 'n3plus' | 'n2plus' | 'n1' | 'n2' | 'n3' | 'n4' | 'n5' | 'unknown';
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
  const [onlySelected, setOnlySelected] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);
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
  const [filterTier, setFilterTier] = useState<StudyFilterTier>('F1');
  const [cardTier, setCardTier] = useState<StudyCardTier>('R0');
  const [filterProfileId, setFilterProfileId] = useState('');
  const [cardProfileId, setCardProfileId] = useState('');
  const [translationProfileId, setTranslationProfileId] = useState('');
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const [workflowExpanded, setWorkflowExpanded] = useState(true);
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
      setLiveFilterDecisions(value?.workflow?.pendingFilterRun?.decisions ?? {});
      setLevels(value?.workflow?.levels ?? [...DEFAULT_STUDY_LEVELS]);
      setIncludeUnknown(value?.workflow?.includeUnknown ?? false);
      setLlmSettings(llm);
      setTranslationSettings(translation);
      setFilterTier(value?.workflow?.pendingFilterRun?.tier ?? value?.workflow?.filterRun?.tier ?? 'F1');
      setCardTier(value?.workflow?.pendingCardRun?.tier ?? value?.workflow?.cardRun?.tier ?? 'R0');
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

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (list?.candidates ?? []).filter((item) =>
      (showExcluded || !item.excluded) &&
      (!onlySelected || item.selected) &&
      passesLevel(item, level) &&
      (!needle || item.expression.toLowerCase().includes(needle) || item.reading.includes(needle)),
    );
  }, [list, query, level, onlySelected, showExcluded]);
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const active = list?.candidates.find((item) => item.id === activeId) ?? filtered[0] ?? null;
  const selectedCount = list?.candidates.filter((item) => item.selected && !item.excluded).length ?? 0;
  const incompleteCount = list?.workflow?.cardRun
    ? list.workflow.cardRun.drafts.filter((item) => !item.meaning || !item.sentenceTranslation).length
    : list?.candidates.filter((item) => item.selected && !item.excluded && (!item.reading || !item.meaning)).length ?? 0;
  const chosenOccurrence = active?.occurrences.find((one) => one.id === active.contextRef) ?? active?.occurrences[0];
  const stale = list !== null && list.segmentGeneratedAt !== segmentGeneratedAt;
  const directPreview = directCandidates(list?.candidates ?? [], levels, includeUnknown);
  const levelsDirty = JSON.stringify([...levels].sort()) !== JSON.stringify([...(list?.workflow?.levels ?? DEFAULT_STUDY_LEVELS)].sort()) ||
    includeUnknown !== (list?.workflow?.includeUnknown ?? false);
  const cardRun = list?.workflow?.cardRun;
  const pendingCardCount = list?.workflow?.pendingCardRun?.drafts.length ?? 0;
  const currentCard = cardRun?.drafts.find((item) => item.candidateId === active?.id);
  const reviewCount = cardRun?.drafts.filter((item) => item.needsReview).length ?? 0;
  const filterCalls = estimatedLlmCalls(directPreview.length, FILTER_TIERS[filterTier]);
  const cardCalls = estimatedLlmCalls(selectedCount, CARD_TIERS[cardTier]);
  const pendingFilterCount = Object.keys(liveFilterDecisions).length;
  const filterProgress = workflowProgress?.stage === 'filter' ? workflowProgress : null;
  const filterCounts = filterProgress?.filter ?? Object.values(liveFilterDecisions).reduce(
    (counts, row) => ({ ...counts, [row.decision]: counts[row.decision] + 1 }),
    { keep: 0, reject: 0, review: 0, llmCalls: 0, elapsedMs: 0, updates: [] as NonNullable<StudyRunProgress['filter']>['updates'] },
  );
  const filterDone = filterProgress?.done ?? pendingFilterCount;
  const filterTotal = filterProgress?.total ?? directPreview.length;
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

  async function selectFiltered(selected: boolean): Promise<void> {
    const next = await call('批量选择候选词', () => api.study.patchMany(bookId, filtered.map((item) => item.id), { selected }));
    if (next) setList(next);
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
    if (!await saveDraft()) return;
    const next = await call('按 JLPT 直接筛选', () => api.study.directFilter(bookId, levels, includeUnknown));
    if (next) { setList(next); setLevel('all'); setOnlySelected(true); setPage(0); setNotice(`已直接选出 ${next.candidates.filter((item) => item.selected).length} 个候选`); }
  }

  async function runLlmFilter(): Promise<void> {
    if (!filterProfileId || !await saveDraft()) return;
    const prior = list?.workflow?.pendingFilterRun;
    const resume = prior?.tier === filterTier && prior.profileId === filterProfileId;
    const saved = resume ? prior.decisions : {};
    setLiveFilterDecisions(saved);
    setWorkflowBusy(true); setWorkflowProgress({ bookId, stage: 'filter', done: Object.keys(saved).length, total: directPreview.length });
    setNotice('正在逐批筛选；下方会显示临时判断，全部完成后才正式更新选择。');
    const next = await call('运行 LLM 筛选 Harness', () => api.study.runFilter(bookId, { tier: filterTier, profileId: filterProfileId }));
    if (next) {
      setList(next);
      setLiveFilterDecisions({});
      setLevel('all'); setOnlySelected(true); setPage(0);
      const decisions = Object.values(next.workflow?.filterRun?.decisions ?? {});
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
    setLevel('all'); setOnlySelected(true); setPage(0);
    setNotice(`已选用 ${next.candidates.filter((item) => item.selected && !item.excluded).length} 个已处理候选；其余暂不制卡，之后仍可续跑筛选。`);
  }

  async function makeCards(): Promise<void> {
    if (!translationProfileId || (cardTier !== 'R0' && !cardProfileId) || !await saveDraft()) return;
    setWorkflowBusy(true); setWorkflowProgress({ bookId, stage: 'cards', done: 0, total: selectedCount });
    const next = await call('运行制卡 Harness', () => api.study.runCards(bookId, {
      tier: cardTier, translationProfileId, ...(cardTier === 'R0' ? {} : { profileId: cardProfileId }),
    }));
    if (next) { setList(next); setNotice(`已制作 ${next.workflow?.cardRun?.drafts.length ?? 0} 张草稿，存疑项请先审核`); }
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
        <button type="button" className="btn btn-sm" disabled={generating} onClick={() => void generate()}>{list ? '重新生成候选' : '生成候选'}</button>
      </div>
    </div>
    {incompleteCount > 0 && <div className="study-notice">{cardRun ? `有 ${incompleteCount} 张草稿缺词义或句译，需补全后导出。` : `已选词中有 ${incompleteCount} 个缺读音或释义，建议导出前逐一核对。`}</div>}
    {stale && <div className="segment-error">分词结果已更新，请重新生成学习候选。人工选择和短语会保留。</div>}
    {generating && <div className="segment-progress">正在分析漫画文字块 · {progress?.done ?? 0} / {progress?.total ?? '…'}</div>}
    {notice && <div className="study-notice" role="status">{notice}</div>}
    {loading && <div className="segment-empty">正在读取制卡清单…</div>}
    {!loading && !list && <div className="segment-empty">先生成分词，再点“生成候选”。候选来自漫画文字块；可按 JLPT 难度筛选并逐词核对。</div>}
    {list && <>
      <details className="study-workflow" open={workflowExpanded} onToggle={(event) => setWorkflowExpanded(event.currentTarget.open)}>
        <summary>筛选 → 制卡 · 已选 {selectedCount} · 草稿 {cardRun?.drafts.length ?? pendingCardCount}
          {workflowBusy && filterProgress && ` · LLM 正在筛选 ${filterDone}/${filterTotal}`}
          {!workflowBusy && pendingFilterCount > 0 && ` · 待续跑 ${pendingFilterCount}/${filterTotal}`}
        </summary>
        <div className="study-workflow-steps">
          <section className="study-workflow-step">
            <h3>1. 直接筛选</h3>
            <p>分别选 JLPT 参考等级；等级冲突归入“未分级”。当前预计 {directPreview.length} 个。</p>
            <div className="study-level-checks">
              {([5, 4, 3, 2, 1] as const).map((value) => <label key={value}><input type="checkbox" checked={levels.includes(value)} onChange={(event) => setLevels((old) => event.target.checked ? [...old, value] : old.filter((one) => one !== value))} /> N{value}</label>)}
              <label><input type="checkbox" checked={includeUnknown} onChange={(event) => setIncludeUnknown(event.target.checked)} /> 未分级 / 冲突</label>
            </div>
            <button type="button" className="btn btn-sm" disabled={workflowBusy || generating || stale} onClick={() => void applyDirectFilter()}>应用直接筛选</button>
          </section>
          <section className="study-workflow-step">
            <h3>2. LLM 筛选（可选）</h3>
            <p>{FILTER_TIERS[filterTier].description} 正常约 {filterCalls} 次 LLM 调用；输出格式错误时自动缩小批次，次数会增加。</p>
            <div className="study-workflow-controls">
              <select aria-label="LLM 筛选档位" value={filterTier} onChange={(event) => setFilterTier(event.target.value as StudyFilterTier)}>
                {(['F1', 'F2', 'F3'] as const).map((tier) => <option key={tier} value={tier}>{tier} · {FILTER_TIERS[tier].name}</option>)}
              </select>
              <select aria-label="筛选 LLM 配置" value={filterProfileId} onChange={(event) => setFilterProfileId(event.target.value)}>
                <option value="">选择 LLM 配置</option>{llmSettings?.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}
              </select>
              <button type="button" className="btn btn-sm" disabled={!filterProfileId || directPreview.length === 0 || levelsDirty || workflowBusy || stale} onClick={() => void runLlmFilter()}>运行 LLM 筛选</button>
            </div>
            {levelsDirty && <small>勾选项已变更，请先应用直接筛选。</small>}
            {pendingFilterCount > 0 && <small>已有 {pendingFilterCount} 个临时判断；全部完成前不会改动正式选择。保持档位与配置可续跑。</small>}
            {!workflowBusy && list.workflow?.pendingFilterRun?.lastError && <small>上次中断：{list.workflow.pendingFilterRun.lastError}</small>}
            {pendingFilterCount > 0 && !workflowBusy && <button type="button" className="btn btn-sm" onClick={() => void useCompletedFilter()}>只使用已完成的 {pendingFilterCount} 项</button>}
            {list.workflow?.filterRun && <small>上次：{list.workflow.filterRun.tier} · {list.workflow.filterRun.stats?.llmCalls ?? '—'} 次 LLM 调用 · {Math.round((list.workflow.filterRun.stats?.elapsedMs ?? 0) / 1000)} 秒。结果可在下方逐词修改。</small>}
          </section>
          <section className="study-workflow-step">
            <h3>3. 制卡</h3>
            <p>{CARD_TIERS[cardTier].description} 当前已选 {selectedCount} 张，正常约 {cardCalls} 次 LLM 调用；每张另需翻译词与原句。</p>
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
              <button type="button" className="btn btn-sm" disabled={selectedCount === 0 || !translationProfileId || (cardTier !== 'R0' && !cardProfileId) || workflowBusy || stale} onClick={() => void makeCards()}>制作卡片草稿</button>
            </div>
            {cardRun && <small>上次：{cardRun.tier} · {cardRun.stats?.llmCalls ?? '—'} 次 LLM 调用 · {cardRun.stats?.translationCalls ?? '—'} 次翻译服务调用 · {Math.round((cardRun.stats?.elapsedMs ?? 0) / 1000)} 秒。</small>}
            {list.workflow?.pendingCardRun && <small>上次已完成 {pendingCardCount} 张草稿；保持档位与配置可续跑。</small>}
          </section>
          <section className="study-workflow-step">
            <h3>4. 审核与导出</h3>
            <p>草稿 {cardRun?.drafts.length ?? 0} 张，待审 {reviewCount} 张。带图牌组为 .apkg；旧 TSV 仍可导出。</p>
            <div className="study-workflow-controls">
              <button type="button" className="btn btn-sm btn-primary" disabled={!cardRun || reviewCount > 0 || workflowBusy || stale} onClick={() => void exportPackage()}>导出带图 Anki 卡组</button>
              <button type="button" className="btn btn-sm" disabled={selectedCount === 0 || workflowBusy} onClick={() => void exportAnki()}>导出旧版 TSV</button>
            </div>
          </section>
        </div>
        {workflowBusy && <div className="study-workflow-progress" role="status">
          {workflowProgress?.stage === 'filter' ? 'LLM 筛选' : workflowProgress?.stage === 'cards' ? '制作卡片' : '打包漫画裁图'}：{workflowProgress?.done ?? 0} / {workflowProgress?.total ?? '…'}
          {filterProgress && <span>临时判断：保留 {filterCounts.keep} · 排除 {filterCounts.reject} · 待审 {filterCounts.review} · {filterCounts.llmCalls || list.workflow?.pendingFilterRun?.stats?.llmCalls || 0} 次请求
            {remainingMinutes !== null && ` · 按当前速度约剩余 ${remainingMinutes} 分钟`}</span>}
          <button type="button" className="btn btn-sm" onClick={() => void api.study.cancel(bookId)}>取消</button>
        </div>}
      </details>
      <div className="study-filters">
        <input className="segment-search" type="search" placeholder="搜索词语或读音" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
        <select aria-label="JLPT 等级" value={level} onChange={(event) => { setLevel(event.target.value as LevelFilter); setPage(0); }}>
          <option value="n3plus">N3–N1</option><option value="n2plus">N2–N1</option><option value="all">全部等级</option>
          <option value="n1">仅 N1</option><option value="n2">仅 N2</option><option value="n3">仅 N3</option>
          <option value="n4">仅 N4</option><option value="n5">仅 N5</option><option value="unknown">等级未知</option>
        </select>
        <label><input type="checkbox" checked={onlySelected} onChange={(event) => { setOnlySelected(event.target.checked); setPage(0); }} /> 只看已选</label>
        <label><input type="checkbox" checked={showExcluded} onChange={(event) => { setShowExcluded(event.target.checked); setPage(0); }} /> 显示排除项</label>
        <span>{filtered.length} / {list.candidates.length} 个候选</span>
        <button type="button" className="btn btn-sm" disabled={filtered.length === 0} onClick={() => void selectFiltered(true)}>选择筛选结果</button>
        <button type="button" className="btn btn-sm" disabled={filtered.length === 0} onClick={() => void selectFiltered(false)}>取消选择</button>
      </div>
      <div className="study-content">
        <div className="study-list" role="listbox" aria-label="学习候选词">
          {visible.map((item) => {
            const pending = liveFilterDecisions[item.id] ?? list.workflow?.pendingFilterRun?.decisions[item.id];
            const decision = pending ?? list.workflow?.filterRun?.decisions[item.id];
            return <div className={`study-row${active?.id === item.id ? ' active' : ''}`} key={item.id} role="option" aria-selected={active?.id === item.id}>
            <input type="checkbox" aria-label={`选择 ${item.expression}`} checked={item.selected} disabled={item.excluded} onChange={(event) => void patchOne(item.id, { selected: event.target.checked })} />
            <button type="button" onClick={() => void switchCandidate(item.id)}>
              <strong>{item.expression}</strong><span>{item.reading || '读音待确认'}</span>
              <span className="study-level">{item.jlpt ? `N${item.jlpt}${item.jlptConflict ? '?' : ''}` : '未知'}</span>
              <span>×{item.count}</span>
              {pending?.decision === 'keep' && <span className="study-filter-preview" title={pending.reason}>暂保留</span>}
              {decision?.decision === 'review' && <span className={pending ? 'study-filter-preview' : ''} title={decision.reason}>{pending ? '暂待审' : 'LLM 待审'}</span>}
              {decision?.decision === 'reject' && <span className={pending ? 'study-filter-preview' : ''} title={decision.reason}>{pending ? '暂排除' : item.selected ? '人工保留' : 'LLM 排除'}</span>}
              {item.exportedAt && <span>已导出</span>}
            </button>
          </div>; })}
          {filtered.length === 0 && <div className="segment-empty">当前筛选没有候选词；试试“全部等级”或“等级未知”。</div>}
          <div className="study-pages">
            <button type="button" className="btn btn-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
            <span>{Math.min(page * PAGE_SIZE + 1, filtered.length)}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} / {filtered.length}</span>
            <button type="button" className="btn btn-sm" disabled={(page + 1) * PAGE_SIZE >= filtered.length} onClick={() => setPage(page + 1)}>下一页</button>
          </div>
        </div>
        <div className="study-detail">
          {active ? <>
            <h3>{active.expression} <small>{active.reading || '读音未知'}</small></h3>
            <div className="study-detail-meta">{active.partOfSpeech} · {active.jlpt ? `参考 N${active.jlpt}` : 'JLPT 未知'} · 出现 {active.count} 次</div>
            {active.jlptConflict && <p>词表中有多个等级记录，请人工核对。</p>}
            <label>词语 / 辞书形
              <input value={draft.expression} onChange={(event) => setDraft((previous) => ({ ...previous, expression: event.target.value }))} />
            </label>
            <label>读音
              <input value={draft.reading} onChange={(event) => setDraft((previous) => ({ ...previous, reading: event.target.value }))} />
            </label>
            <label>词义 / 卡背备注
              <textarea value={draft.meaning} onChange={(event) => setDraft((previous) => ({ ...previous, meaning: event.target.value }))} />
            </label>
            <button type="button" className="btn btn-sm" onClick={() => void saveDraft()}>保存修改</button>
            <label>代表例句
              <select value={active.contextRef} onChange={(event) => void patchOne(active.id, { contextRef: event.target.value })}>
                {active.occurrences.map((one) => <option key={one.id} value={one.id}>{one.label} · {one.start + 1}</option>)}
              </select>
            </label>
            {chosenOccurrence && <div className="study-context">{highlightedContext(chosenOccurrence)}</div>}
            <div className="study-card-preview"><strong>Anki 预览</strong><div>{draft.expression}{draft.reading ? `（${draft.reading}）` : ''}</div><hr /><div>{draft.meaning || '词义待补充'}</div><div>{chosenOccurrence?.text}</div><small>{bookTitle} · {chosenOccurrence?.label}</small></div>
            {currentCard && <div className="study-card-draft">
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
            <label className="study-exclude"><input type="checkbox" checked={active.excluded} onChange={(event) => void patchOne(active.id, { excluded: event.target.checked, selected: false })} /> 排除误识别或无用词</label>
            {chosenOccurrence && <div className="study-phrase">
              <strong>从这一文字块添加短语</strong>
              <input value={phrase} onChange={(event) => setPhrase(event.target.value)} placeholder="输入原文中的连续短语" />
              <input value={phraseReading} onChange={(event) => setPhraseReading(event.target.value)} placeholder="读音（可稍后补）" />
              <button type="button" className="btn btn-sm" disabled={!phrase.trim()} onClick={() => void addPhrase()}>加入清单</button>
            </div>}
          </> : <div className="segment-empty">选择左侧候选词查看出处和卡片预览。</div>}
        </div>
      </div>
      <div className="study-footer">JLPT 参考来源：{list.jlptSource}（非官方）。带图卡组导出为 .apkg；旧 TSV 导入时请确认正面、背面和标签列。</div>
    </>}
  </div>;
}
