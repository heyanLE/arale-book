/** 漫画学习候选审核：JLPT 筛选、出处核对、人工短语和 Anki 导出。 */
import { useEffect, useMemo, useState } from 'react';
import type { StudyCandidate, StudyCandidatePatch, StudyList, StudyOccurrence } from '@shared/types';
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
  const [level, setLevel] = useState<LevelFilter>('n3plus');
  const [onlySelected, setOnlySelected] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);
  const [page, setPage] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [phrase, setPhrase] = useState('');
  const [phraseReading, setPhraseReading] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState({ expression: '', reading: '', meaning: '' });

  useEffect(() => {
    let live = true;
    setLoading(true);
    void call('读取制卡清单', () => api.study.read(bookId)).then((value) => {
      if (live) { setList(value); setLoading(false); }
    });
    return () => { live = false; };
  }, [bookId]);

  useIpcEvent('study:progress', (event) => {
    if (event.bookId === bookId) setProgress({ done: event.done, total: event.total });
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
  const incompleteCount = list?.candidates.filter((item) => item.selected && !item.excluded && (!item.reading || !item.meaning)).length ?? 0;
  const chosenOccurrence = active?.occurrences.find((one) => one.id === active.contextRef) ?? active?.occurrences[0];
  const stale = list !== null && list.segmentGeneratedAt !== segmentGeneratedAt;

  useEffect(() => {
    setDraft({ expression: active?.expression ?? '', reading: active?.reading ?? '', meaning: active?.meaning ?? '' });
  }, [active?.id]);

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

  return <div className="study-panel">
    <div className="study-head">
      <div>
        <strong>Anki 制卡 · {bookTitle}</strong>
        <small>候选等级来自社区 JLPT 参考词表，需按漫画原文审核。</small>
      </div>
      <div className="study-head-actions">
        {generating && <button type="button" className="btn btn-sm" onClick={() => void call('取消候选生成', () => api.study.cancel(bookId))}>取消</button>}
        <button type="button" className="btn btn-sm" disabled={generating} onClick={() => void generate()}>{list ? '重新生成候选' : '生成候选'}</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={selectedCount === 0 || generating} onClick={() => void exportAnki()}>导出 Anki（{selectedCount}）</button>
      </div>
    </div>
    {incompleteCount > 0 && <div className="study-notice">已选词中有 {incompleteCount} 个缺读音或释义，建议导出前逐一核对。</div>}
    {stale && <div className="segment-error">分词结果已更新，请重新生成学习候选。人工选择和短语会保留。</div>}
    {generating && <div className="segment-progress">正在分析漫画文字块 · {progress?.done ?? 0} / {progress?.total ?? '…'}</div>}
    {notice && <div className="study-notice" role="status">{notice}</div>}
    {loading && <div className="segment-empty">正在读取制卡清单…</div>}
    {!loading && !list && <div className="segment-empty">先生成分词，再点“生成候选”。候选来自漫画文字块；可按 JLPT 难度筛选并逐词核对。</div>}
    {list && <>
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
          {visible.map((item) => <div className={`study-row${active?.id === item.id ? ' active' : ''}`} key={item.id} role="option" aria-selected={active?.id === item.id}>
            <input type="checkbox" aria-label={`选择 ${item.expression}`} checked={item.selected} disabled={item.excluded} onChange={(event) => void patchOne(item.id, { selected: event.target.checked })} />
            <button type="button" onClick={() => void switchCandidate(item.id)}>
              <strong>{item.expression}</strong><span>{item.reading || '读音待确认'}</span>
              <span className="study-level">{item.jlpt ? `N${item.jlpt}${item.jlptConflict ? '?' : ''}` : '未知'}</span>
              <span>×{item.count}</span>{item.exportedAt && <span>已导出</span>}
            </button>
          </div>)}
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
      <div className="study-footer">数据来源：{list.jlptSource}。等级是参考，不是官方词汇清单。导出为 Anki UTF-8 文本，导入时确认正面、背面和标签列。</div>
    </>}
  </div>;
}
