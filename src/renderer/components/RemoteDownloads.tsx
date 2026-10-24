import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { RemoteDownload } from '@shared/server';
import type { BookRecord } from '@shared/types';
import { api, call } from '../lib/api';

let state: { jobs: RemoteDownload[]; error: string } = { jobs: [], error: '' };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;
function publish(jobs: RemoteDownload[], error = '') { state = { jobs, error }; for (const notify of listeners) notify(); }
async function refresh() {
  if (polling) return;
  polling = true;
  try { const jobs = await api.sources.downloads(); if (!Array.isArray(jobs)) throw new Error('下载状态读取失败'); publish(jobs); }
  catch (e) { publish(state.jobs, String(e)); }
  finally { polling = false; }
}
function subscribe(notify: () => void) {
  listeners.add(notify);
  if (!timer) { void refresh(); timer = setInterval(() => void refresh(), 1500); }
  return () => { listeners.delete(notify); if (!listeners.size && timer) { clearInterval(timer); timer = null; } };
}
const useDownloads = () => useSyncExternalStore(subscribe, () => state);
async function start(ids: string[]) {
  const jobs = await call('下载整本漫画', () => api.sources.download(ids)); if (jobs) publish(jobs);
}
async function pause(id: string) {
  const jobs = await call('暂停漫画下载', () => api.sources.pauseDownload(id)); if (jobs) publish(jobs);
}
function label(job?: RemoteDownload): string {
  if (!job) return '整本下载后可离线阅读';
  if (job.outdated) return '已下载的版本与当前书架不同';
  if (job.status === 'complete') return `已完整下载 · ${job.total} 页`;
  if (job.status === 'downloading' && job.stage === 'checking') return '校验已缓存页面…';
  if (job.status === 'downloading' && job.stage === 'text') return '原图已就绪，正在缓存文字层…';
  const phase = { queued: '排队中', downloading: '下载中', waiting: '等待连接', paused: '已暂停', failed: '下载失败' }[job.status];
  return `${phase} · ${job.done} / ${job.total} 页`;
}
function Actions({ id, job }: { id: string; job?: RemoteDownload }) {
  const [busy, setBusy] = useState(false);
  const active = job && ['queued', 'downloading', 'waiting'].includes(job.status);
  const run = async (work: () => Promise<void>) => { setBusy(true); try { await work(); } finally { setBusy(false); } };
  return <div className="download-actions">
    {active ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(() => pause(id))}>暂停下载</button>
      : <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(() => start([id]))}>{job?.outdated ? '下载当前版本' : job?.status === 'complete' ? '检查并补齐' : job?.status === 'paused' ? '继续下载' : job?.status === 'failed' ? '重试下载' : '下载整本到本机'}</button>}
    {job?.status === 'waiting' && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(() => start([id]))}>立即重试</button>}
  </div>;
}
function Progress({ job }: { job?: RemoteDownload }) {
  return <><p role="status" className="download-status">{label(job)}</p>
    {job && job.status !== 'complete' && <progress aria-label="整本下载进度" value={job.done} max={Math.max(1, job.total)} />}
    {job?.bytesTotal ? <small>{(job.bytesDone / 1048576).toFixed(1)} / {(job.bytesTotal / 1048576).toFixed(1)} MiB</small> : null}
    {job?.error && <p className="download-error">{job.error}{job.status === 'waiting' ? '；连接恢复后自动重试。' : ''}</p>}
  </>;
}
export function BookDownload({ book }: { book: BookRecord }) {
  const snapshot = useDownloads(); const job = snapshot.jobs.find(item => item.bookId === book.id);
  return <section className="book-download" aria-label="整本离线下载"><Progress job={job} /><Actions id={book.id} job={job} />
    <small>包含全部原图与服务器已有文字层，沿用当前书籍与阅读进度。</small>
    {snapshot.error && <p className="download-error">{snapshot.error}</p>}
  </section>;
}
export function DownloadSelected({ ids }: { ids: string[] }) {
  const remote = ids.filter(id => id.startsWith('rs_'));
  const [busy,setBusy]=useState(false);
  if (!remote.length) return null;
  return <button type="button" className="btn btn-block" disabled={busy} onClick={() => {setBusy(true);void start(remote).finally(()=>setBusy(false));}}>下载所选远程漫画（{remote.length} 本）</button>;
}
export function DownloadDock() {
  const snapshot = useDownloads();const [open,setOpen]=useState(false);
  const active=snapshot.jobs.find(j=>j.status==='downloading') ?? snapshot.jobs.find(j=>j.status==='waiting') ?? snapshot.jobs.find(j=>j.status==='queued');
  const pending=snapshot.jobs.filter(j=>['queued','downloading','waiting'].includes(j.status)).length;
  return <><button type="button" className="sync-dock" aria-haspopup="dialog" title="漫画整本下载队列" onClick={()=>setOpen(true)}>↓ {active ? `${active.status==='waiting'?'等待连接':'下载'} ${active.done}/${active.total} 页${pending>1?` · ${pending} 本`:''}` : '漫画下载'}</button>
    {open && <DownloadDialog jobs={snapshot.jobs} error={snapshot.error} onClose={()=>setOpen(false)}/>}</>;
}
function DownloadDialog({jobs,error,onClose}:{jobs:RemoteDownload[];error:string;onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;dialog.current?.showModal();return()=>previous?.focus();},[]);
  return <dialog ref={dialog} className="server-sync-dialog" aria-labelledby="downloads-title" onCancel={e=>{e.preventDefault();onClose();}} onKeyDownCapture={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();onClose();}}}>
    <header className="journal-head"><strong id="downloads-title">漫画整本下载</strong><button type="button" className="icon-btn" aria-label="关闭下载队列" onClick={onClose}>×</button></header>
    <div className="sync-dialog-body"><p className="settings-hint">切换页面后继续下载。退出应用后保留队列，再次启动时续传；暂停的任务需手动继续。</p>
      {!jobs.length && <p>在 NAS 书架选中漫画，点击右侧“下载整本到本机”。也可多选后批量下载。</p>}
      {jobs.map(job=><section className="sync-card" key={job.bookId}><h3>{job.title}</h3><Progress job={job}/><Actions id={job.bookId} job={job}/></section>)}
      {error && <p role="alert">{error}</p>}
    </div>
  </dialog>;
}
