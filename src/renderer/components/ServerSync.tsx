import { useEffect, useRef, useState } from 'react';
import type { ServerConnection, ServerConnections, ServerPoll, ServerSyncStatus } from '@shared/server';
import { api } from '../lib/api';

export function syncLabel(status?: ServerSyncStatus, autoSync = true): string {
  if (status?.phase === 'syncing') return '正在同步…';
  if (status?.conflicts) return `${status.conflicts} 本进度需处理`;
  if (status?.phase === 'auth-error') return '认证失败';
  if (status?.phase === 'offline') return '连接中断';
  if (status?.phase === 'error') return '同步失败';
  if (status?.pending) return `${status.pending} 本进度待同步`;
  if (!autoSync) return '自动同步已关闭';
  return status?.lastSyncedAt ? '已同步' : '等待首次同步';
}
export function SyncConnection({ connection, status }: { connection: ServerConnection; status?: ServerSyncStatus }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(work: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await work(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  const auto = connection.autoSync !== false;
  return <div className="sync-connection-details">
    <p className="sync-state" role="status">{syncLabel(status, auto)}{status?.pending ? ` · ${status.pending} 本的最新位置已保存在本机` : ''}</p>
    <p className="settings-hint">上次成功同步：{status?.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleString() : '尚未同步'}</p>
    <div className="sync-actions">
      <label><input type="checkbox" checked={auto} disabled={busy} onChange={e => void run(() => api.sources.autoSync(connection.id, e.target.checked))} /> 自动同步书架与阅读进度</label>
      <button className="btn btn-primary btn-sm" disabled={busy || status?.phase === 'syncing'} onClick={() => void run(() => api.sources.sync(connection.id))}>{busy || status?.phase === 'syncing' ? '处理中…' : '立即同步'}</button>
    </div>
    {!auto && <p className="settings-hint">翻页继续保存到本机，点击“立即同步”时交换书架与进度。未缓存的页图仍会按需下载。</p>}
    {(error || status?.error) && <p className="sync-error" role="alert">{error || status?.error}{status?.phase === 'auth-error' ? '。请在设置中检查访问令牌。' : '。本机进度已保留，可稍后重试。'}</p>}
  </div>;
}
export function ServerSync({ sources, state, onResolved }: { sources: ServerConnections; state: ServerPoll; onResolved: (bookId: string, choice: 'local' | 'remote' | 'restart') => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const active = state.connections?.find(c => c.connectionId === sources.activeId);
  const selected = sources.connections.find(c => c.id === sources.activeId);
  const pending = state.connections?.reduce((sum,c) => sum+c.pending,0) ?? 0;
  if (!sources.connections.length) return null;
  const label = state.conflicts.length ? `${state.conflicts.length} 本进度需处理` : active && ['offline','auth-error','error','syncing'].includes(active.phase) ? `${syncLabel(active)}${pending ? ` · ${pending} 本待同步` : ''}` : pending ? `${pending} 本进度待同步` : selected ? syncLabel(active, selected.autoSync !== false) : '服务器同步';
  return <><button className="sync-dock" onClick={() => setOpen(true)} title="连接与同步状态" aria-haspopup="dialog">↻ {label}</button>
    {open && <SyncDialog sources={sources} state={state} onClose={() => setOpen(false)} onResolved={onResolved} />}</>;
}
function SyncDialog({ sources, state, onClose, onResolved }: { sources: ServerConnections; state: ServerPoll; onClose: () => void; onResolved: (bookId: string, choice: 'local' | 'remote' | 'restart') => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  useEffect(() => { const previous=document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => previous?.focus(); }, []);
  return <dialog ref={dialog} className="server-sync-dialog" aria-labelledby="sync-title" onCancel={e => { e.preventDefault(); onClose(); }} onKeyDownCapture={e => { if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
    <header className="journal-head"><strong id="sync-title">连接与同步</strong><button className="icon-btn" aria-label="关闭同步状态" onClick={onClose}>×</button></header>
    <div className="sync-dialog-body"><p className="settings-hint">阅读先保存到本机。同步不会跳转正在阅读的页码；其他设备的位置在下次打开时采用。</p>
      {sources.connections.map(c => <section className="sync-card" key={c.id}><h3>{c.name}{sources.activeId === c.id ? ' · 当前书源' : ''}</h3><SyncConnection connection={c} status={state.connections?.find(s=>s.connectionId===c.id)} /></section>)}
      {state.conflicts.map(c => <section className="sync-card sync-conflict" key={c.bookId}><h3>「{c.title}」进度有分歧</h3><p>本机第 {(c.local.pageIndex??0)+1} 页 · 服务器{c.remote ? `第 ${(c.remote.pageIndex??0)+1} 页` : '尚未阅读'}</p>
        {c.contentChanged && <p>书籍内容版本已变化，需要从新版重新定位。</p>}
        <div className="sync-actions">{(c.contentChanged ? ['restart'] as const : ['local','remote'] as const).map(choice => <button className="btn btn-sm" key={choice} disabled={busy} onClick={() => {setBusy(true);setError('');void onResolved(c.bookId,choice).catch(e=>setError(String(e))).finally(()=>setBusy(false));}}>{choice === 'restart' ? '从新版第一页开始' : choice === 'local' ? '采用本机位置' : '采用服务器位置'}</button>)}</div>
      </section>)}{error && <p role="alert">{error}</p>}
      <p className="settings-hint">书签、笔记、批注和制卡资料保存在本机。服务器文件发生变化时，在设置中“扫描服务器文件”。</p>
    </div>
  </dialog>;
}
