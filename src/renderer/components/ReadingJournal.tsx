import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReadingEntry, ReadingEntryDraft, ReadingSnapshot } from '@shared/reading';
import { journalMarkdown, localDay, summarizeReading } from '@core/reading/activity';
import { api, call } from '../lib/api';
import { flushReadingActivity } from '../lib/reading-activity';

const KIND = { bookmark: '书签', excerpt: '摘录', note: '笔记' };
export function ReadingJournal({ bookId, initialDraft, onClose, onJump }: {
  bookId?: string; initialDraft?: ReadingEntryDraft;
  onClose: () => void; onJump: (entry: ReadingEntry) => void | Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [snapshot, setSnapshot] = useState<ReadingSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'entries' | 'stats'>('entries');
  const [scope, setScope] = useState(bookId ? 'book' : 'all');
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('all');
  const [range, setRange] = useState('7');
  const [draft, setDraft] = useState<ReadingEntryDraft | null>(initialDraft ?? null);
  const [deleted, setDeleted] = useState<ReadingEntry | null>(null);
  const [notice, setNotice] = useState('');
  async function reload() {
    const data = await call('读取阅读记录', () => api.reading.snapshot());
    if (data) { setSnapshot(data); setError(''); } else setError('读取失败，请重试。');
  }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    if (initialDraft) dialog.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    void flushReadingActivity().then(reload);
    return () => previous?.focus();
  }, []);
  const entries = useMemo(() => (snapshot?.entries ?? []).filter(entry =>
    (scope !== 'book' || entry.bookId === bookId) && (kind === 'all' || entry.kind === kind) &&
    `${entry.title}\n${entry.quote}\n${entry.note}\n${entry.bookTitle}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())
  ), [snapshot, scope, bookId, search, kind]);
  const days = useMemo(() => {
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (Number(range) - 1));
    const from = range === 'all' ? '' : localDay(start.getTime());
    return (snapshot?.days ?? []).filter(row => (scope !== 'book' || row.bookId === bookId) && row.day >= from && row.day <= localDay(Date.now()));
  }, [snapshot, scope, bookId, range]);
  const stats = summarizeReading(days);
  const daily = [...new Set(days.map(row => row.day))].sort().reverse();
  async function save() {
    if (!draft) return;
    setBusy(true);
    const result = await call('保存阅读记录', () => api.reading.save(draft));
    setBusy(false);
    if (!result) { setError('保存失败，草稿已保留。若记录已变更，请复制草稿后刷新。'); return; }
    setDraft(null); setNotice('已保存'); await reload();
  }
  function close() {
    if (busy) return;
    if (draft && !window.confirm('放弃当前未保存的阅读记录修改？')) return;
    onClose();
  }
  const copy = async () => {
    const copied = await call('复制阅读记录', async () => { await navigator.clipboard.writeText(journalMarkdown(entries)); return true; });
    if (copied) setNotice(`已复制 ${entries.length} 条 Markdown 记录`);
  };
  return <dialog ref={dialog} className="reading-journal" aria-labelledby="reading-journal-title"
    onCancel={event => { event.preventDefault(); close(); }}
    onKeyDownCapture={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <header className="journal-head"><strong id="reading-journal-title">阅读记录</strong>
      <button className="icon-btn" aria-label="关闭阅读记录" disabled={busy} onClick={close}>×</button></header>
    <div className="journal-toolbar">
      <div className="seg" role="tablist" aria-label="阅读记录分类">
        <button className={`seg-btn${tab === 'entries' ? ' is-active' : ''}`} role="tab" aria-selected={tab === 'entries'} onClick={() => setTab('entries')}>书签、摘录与笔记</button>
        <button className={`seg-btn${tab === 'stats' ? ' is-active' : ''}`} role="tab" aria-selected={tab === 'stats'} onClick={() => setTab('stats')}>阅读与学习统计</button>
      </div>
      {bookId && <select aria-label="记录范围" value={scope} onChange={event => setScope(event.target.value)}><option value="book">当前书籍</option><option value="all">全部书籍</option></select>}
      <button className="btn btn-sm" onClick={() => void flushReadingActivity().then(reload)} disabled={busy}>刷新</button>
    </div>
    {error && <p role="alert" className="journal-error">{error}</p>}
    {notice && <p role="status" className="journal-notice">{notice}</p>}
    {!snapshot && !error && <p>正在读取…</p>}
    {draft && <section className="journal-editor" aria-label="编辑阅读记录">
      <strong>{draft.id ? '编辑' : '添加'}{KIND[draft.kind]}</strong>
      <label>标题<input maxLength={200} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
      {draft.quote && <blockquote>{draft.quote}</blockquote>}
      <label>笔记<textarea autoFocus rows={5} maxLength={50000} value={draft.note} onChange={event => setDraft({ ...draft, note: event.target.value })} placeholder="写下感想、语法理解或待查问题…" /></label>
      <div className="journal-actions"><button className="btn btn-primary" disabled={busy || (draft.kind === 'note' && !draft.note.trim())} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button>
        <button className="btn" disabled={busy} onClick={() => { if (window.confirm('放弃当前未保存的修改？')) setDraft(null); }}>取消编辑</button></div>
    </section>}
    {tab === 'entries' ? <>
      <div className="journal-toolbar"><input aria-label="搜索阅读记录" type="search" placeholder="搜索标题、摘录、笔记或书名…" value={search} onChange={event => setSearch(event.target.value)} />
        <select aria-label="记录类型" value={kind} onChange={event => setKind(event.target.value)}><option value="all">全部类型</option>{Object.entries(KIND).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        <button className="btn btn-sm" disabled={!entries.length || busy} onClick={() => void copy()}>复制 Markdown</button>
        <button className="btn btn-sm" disabled={!entries.length || busy} onClick={() => {
          setBusy(true); void call('导出阅读记录', () => api.reading.export(entries.map(entry => entry.id))).then(result => {
            setBusy(false); if (result) setNotice(`已导出 ${result.count} 条记录：${result.path}`);
          });
        }}>导出 Markdown</button></div>
      {deleted && <div role="status" className="journal-notice">已删除“{deleted.title}” <button className="btn btn-sm" disabled={busy} onClick={() => {
        setBusy(true); const { id: _id, updatedAt: _revision, ...rest } = deleted;
        void call('撤销删除', () => api.reading.save(rest)).then(result => { setBusy(false); if (result) { setDeleted(null); void reload(); } });
      }}>撤销删除</button></div>}
      <div className="journal-entries">{snapshot && entries.length === 0 && <p className="journal-empty">没有符合条件的记录。阅读时可添加书签、写笔记，或选中文字后摘录。</p>}
      {entries.map(entry => <article className="journal-entry" key={entry.id}>
        <div className="journal-entry-title"><strong>{entry.title || KIND[entry.kind]}</strong><span>{KIND[entry.kind]}</span></div>
        <small>{entry.bookTitle} · {entry.position.pageIndex !== undefined ? `第 ${entry.position.pageIndex + 1} 页` : `第 ${(entry.position.spineIndex ?? 0) + 1} 章 · 字符 ${entry.position.charOffset ?? 0}`} · {new Date(entry.createdAt).toLocaleDateString()}</small>
        {entry.quote && <blockquote>{entry.quote}</blockquote>}{entry.note && <p className="journal-note">{entry.note}</p>}
        <div className="journal-actions"><button className="btn btn-sm" disabled={entry.available === false || !!draft || busy} onClick={() => {
            setBusy(true); void call('跳到原文', async () => { await onJump(entry); return true; }).then(ok => {
              setBusy(false); if (!ok) setError('无法定位原文，请核对原书是否仍存在、页图或章节是否已更换。');
            });
          }}>{entry.available === false ? '原书已移除' : '跳到原文'}</button>
          <button className="btn btn-sm" disabled={entry.available === false || !!draft || busy} onClick={() => setDraft(entry)}>编辑</button>
          <button className="btn btn-sm" disabled={!!draft || busy} onClick={() => {
            setBusy(true); void call('删除阅读记录', () => api.reading.remove(entry.id, entry.updatedAt)).then(result => { setBusy(false); if (result) { setDeleted(result); void reload(); } });
          }}>删除</button></div>
      </article>)}</div>
    </> : <section className="journal-stats" aria-label="阅读与学习统计">
      <label>统计周期 <select value={range} onChange={event => setRange(event.target.value)}><option value="1">今天</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="all">全部时间</option></select></label>
      <div className="journal-metrics">{[['有效阅读', `${Math.floor(stats.activeMs / 60000)} 分 ${Math.floor(stats.activeMs / 1000) % 60} 秒`], ['阅读书籍', stats.books], ['阅读天数', stats.days], ['浏览漫画页', stats.pages], ['浏览小说章节', stats.chapters], ['查词次数', stats.lookups], ['不同查询词', stats.words]].map(([label, value]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>
      <p className="journal-notice">仅统计此功能启用后的记录。窗口失焦、隐藏或 2 分钟无操作时暂停计时；页／章为停留至少 2 秒后记录的位置，同一周期内去重，不代表已读完或已掌握。查词记录按实际查询词归一化，不等于新学词数。</p>
      <h3>每日记录</h3><div className="journal-table-wrap"><table><thead><tr><th>日期</th><th>阅读时长</th><th>漫画页／小说章</th><th>查词</th></tr></thead><tbody>{daily.map(day => { const row = summarizeReading(days.filter(item => item.day === day)); return <tr key={day}><td>{day}</td><td>{(row.activeMs / 60000).toFixed(1)} 分钟</td><td>{row.pages}／{row.chapters}</td><td>{row.lookups}</td></tr>; })}</tbody></table></div>
      {daily.length === 0 && <p className="journal-empty">这个周期还没有阅读或查词记录。</p>}
      <h3>反复查询的词</h3><div className="journal-word-list">{stats.repeated.map(([word, count]) => <span key={word}>{word} <b>{count} 次</b></span>)}{stats.repeated.length === 0 && <p>暂时没有重复查询。</p>}</div>
    </section>}
  </dialog>;
}
