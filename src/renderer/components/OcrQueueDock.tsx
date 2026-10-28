/**
 * 右下角的全局任务队列停靠条：导入、OCR 与 Anki AI/翻译任务共用入口。
 *
 * 为什么放在 App 层：OCR 和 AI 筛词/释义都可能耗时数分钟，用户可以离开当前页面。
 * 入口在所有视图的右下角，展开后能看到运行、排队和最近的任务结果。
 *
 * 三种形态：
 * - 没有运行、排队或最近结果时不渲染。
 * - 折叠：一个带进度的胶囊；展开：导入、OCR 与 AI 任务列表及结果。
 *
 * OCR/学习任务各有主进程队列，导入使用 Worker 会话 FIFO；各类任务可以同时运行。
 */

import { useEffect, useRef, useState } from 'react';
import type { OcrProgress, OcrProviderId, OcrQueueState, StudyTaskEntry, StudyTaskQueueState } from '@shared/types';
import type { ImportQueueState, ImportTaskEntry } from '@shared/imports';
import type { DictionaryImportQueueState, DictionaryImportTask } from '@shared/dictionary-imports';

export interface OcrQueueDockProps {
  queue: OcrQueueState | null;
  /** 各本书的进度快照（`ocr:progress` 事件累计），只有正在跑的那本有值。 */
  progress: Record<string, OcrProgress>;
  /** 引擎 id → 显示名。 */
  providerLabel: (id: OcrProviderId) => string;
  onCancel: (bookId: string) => void;
  studyQueue?: StudyTaskQueueState | null;
  importQueue?: ImportQueueState | null;
  dictionaryImportQueue?: DictionaryImportQueueState | null;
  onCancelDictionaryImport?: (id: string) => void;
  onDismissDictionaryImport?: (id: string) => void;
  openRequest?: number;
  onCancelImport?: (id: string) => void;
  onDismissImport?: (id: string) => void;
  onCancelStudy?: (id: string) => void;
  onDismissStudy?: (id: string) => void;
  onOpenStudy?: (bookId: string, title: string) => void;
  /** 点书名跳过去看那本书。 */
  onOpenBook?: (bookId: string) => void;
}

export function OcrQueueDock(props: OcrQueueDockProps): JSX.Element | null {
  const { queue, progress, providerLabel, onCancel, onOpenBook, studyQueue, onCancelStudy, onDismissStudy, onOpenStudy, importQueue, onCancelImport, onDismissImport } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const active = queue?.active ?? null;
  const pending = queue?.pending ?? [];
  const studyActive = studyQueue?.active ?? null;
  const studyPending = studyQueue?.pending ?? [];
  const studyRecent = studyQueue?.recent ?? [];
  const importActive = importQueue?.active;
  const dictionaryActive = props.dictionaryImportQueue?.active;
  const dictionaryPending = props.dictionaryImportQueue?.pending ?? [];
  const dictionaryRecent = props.dictionaryImportQueue?.recent ?? [];
  const importPending = importQueue?.pending ?? [], importRecent = importQueue?.recent ?? [];
  const waiting = pending.filter(entry=>!entry.running).length + studyPending.length + importPending.length + dictionaryPending.length;
  const running = pending.filter(entry=>entry.running).length + (active ? 1 : 0) + (studyActive ? 1 : 0) + (importActive ? 1 : 0) + (dictionaryActive ? 1 : 0);
  const total = running + waiting + studyRecent.length + importRecent.length + dictionaryRecent.length;
  useEffect(() => { if (props.openRequest) setOpen(true); }, [props.openRequest]);

  // 点外面收起弹层。队列**跑空**时也收起：任务都没了，留一个空弹层没有意义。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (total === 0) setOpen(false);
  }, [total]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  // 队列空 → 什么都不显示。这是「不打扰」的默认状态。
  if (total === 0) return null;

  const activeProgress = active ? progress[active.bookId] : undefined;
  const done = activeProgress?.done ?? 0;
  const pages = activeProgress?.total ?? active?.total ?? 0;
  const stageText = activeProgress ? stageLabel(activeProgress) : '准备中…';
  const openStudy = onOpenStudy ? (bookId: string, title: string): void => { setOpen(false); onOpenStudy(bookId, title); } : undefined;

  return (
    <div className="ocr-dock" ref={rootRef}>
      {open && (
        <div className="ocr-dock-panel" role="dialog" aria-label="任务队列">
          <div className="ocr-dock-head">
            <span className="ocr-dock-title">任务队列</span>
            <span className="ocr-dock-count mono">
              {`${running} 个运行中`}
              {waiting > 0 ? ` · 排队 ${waiting}` : ''}
            </span>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setOpen(false)}
              title="收起"
            >
              ×
            </button>
          </div>

          <div className="ocr-dock-list">
            {dictionaryActive && <DictionaryTaskRow task={dictionaryActive} />}
            {dictionaryPending.map((task, index) => <DictionaryTaskRow key={task.id} task={task} position={index + 1} onCancel={props.onCancelDictionaryImport} />)}
            {importActive && <ImportTaskRow task={importActive} />}
            {importPending.map((task, index) => <ImportTaskRow key={task.id} task={task} position={index + 1} onCancel={onCancelImport} />)}
            {active && (
              <div className="ocr-queue-item is-active">
                <div className="ocr-queue-row">
                  <span className="ocr-queue-badge">识别中</span>
                  <span className="ocr-queue-title cell-ellipsis" title={active.title}>
                    {active.title}
                  </span>
                </div>
                <div className="ocr-queue-meta mono">
                  {providerLabel(active.provider)}
                  {pages > 0 ? ` · ${Math.min(done + (activeProgress ? 1 : 0), pages)} / ${pages} 页` : ''}
                  {` · ${stageText}`}
                </div>
                <div className="ocr-queue-bar" aria-hidden="true">
                  <div
                    className="ocr-queue-bar-fill"
                    style={{ width: pages > 0 ? `${Math.round((done / pages) * 100)}%` : '0%' }}
                  />
                </div>
                <div className="ocr-queue-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => onCancel(active.bookId)}
                  >
                    停止识别
                  </button>
                  {onOpenBook && (
                    <button
                      type="button"
                      className="btn btn-sm"
                    onClick={() => { setOpen(false); onOpenBook(active.bookId); }}
                    >
                      打开这本书
                    </button>
                  )}
                </div>
              </div>
            )}

            {pending.map((entry, index) => (
              <div className="ocr-queue-item" key={entry.bookId}>
                <div className="ocr-queue-row">
                  <span className={`ocr-queue-badge${entry.running ? '' : ' is-waiting'}`}>{entry.running ? '识别中' : index + 1}</span>
                  <span className="ocr-queue-title cell-ellipsis" title={entry.title}>
                    {entry.title}
                  </span>
                </div>
                <div className="ocr-queue-meta mono">
                  {providerLabel(entry.provider)}
                  {entry.total > 0 ? ` · ${entry.total} 页` : ''}
                  {entry.running ? ` · ${progress[entry.bookId]?.done??0} / ${entry.total} 页` : ` · 等待 ${waitingFor(entry.enqueuedAt)}`}
                </div>
                <div className="ocr-queue-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => onCancel(entry.bookId)}
                  >
                    {entry.running ? '停止识别' : '取消排队'}
                  </button>
                </div>
              </div>
            ))}
            {studyActive && <StudyTaskRow task={studyActive} onCancel={onCancelStudy} onOpen={openStudy} />}
            {studyPending.map((task, index) => <StudyTaskRow key={task.id} task={task} position={index + 1} onCancel={onCancelStudy} onOpen={openStudy} />)}
            {studyRecent.map((task) => <StudyTaskRow key={task.id} task={task} onDismiss={onDismissStudy} onOpen={openStudy} />)}
            {importRecent.map(task => <ImportTaskRow key={task.id} task={task} onDismiss={onDismissImport} onOpen={onOpenBook ? id => { setOpen(false); onOpenBook(id); } : undefined} />)}
            {dictionaryRecent.map(task => <DictionaryTaskRow key={task.id} task={task} onDismiss={props.onDismissDictionaryImport} />)}
          </div>
        </div>
      )}

      <button
        type="button"
        className={`ocr-dock-pill${open ? ' is-open' : ''}${running === 0 ? ' is-idle' : ''}`}
        onClick={() => setOpen((value) => !value)}
        title="点击查看任务队列"
        aria-expanded={open}
      >
        <span className="ocr-dock-spinner" aria-hidden="true" />
        <span className="ocr-dock-label" role="status" aria-live="polite">
          {dictionaryActive ? '词典导入' : importActive ? '导入中' : active ? '识别中' : studyActive ? 'AI 任务中' : waiting > 0 ? '排队中' : '任务结果'}
          {dictionaryActive && <span className="ocr-dock-progress cell-ellipsis" title={dictionaryActive.title}>{dictionaryActive.progress.message}</span>}
          {pages > 0 && active && !importActive && !dictionaryActive ? (
            <span className="mono ocr-dock-progress">
              {Math.min(done + (activeProgress ? 1 : 0), pages)}/{pages}
            </span>
          ) : null}
          {!active && !importActive && !dictionaryActive && studyActive && studyActive.total > 0 && <span className="mono ocr-dock-progress">{studyActive.done}/{studyActive.total}</span>}
          {importActive && !dictionaryActive && <span className="ocr-dock-progress cell-ellipsis" title={importActive.title}>{importActive.progress.message}</span>}
          {total > 1 ? (
            <span className="ocr-dock-pending mono">+{total - 1}</span>
          ) : null}
        </span>
        <span className="ocr-dock-caret" aria-hidden="true">
          {open ? '▾' : '▴'}
        </span>
      </button>
    </div>
  );
}

function DictionaryTaskRow({ task, position, onCancel, onDismiss }: {
  task: DictionaryImportTask; position?: number; onCancel?: (id: string) => void; onDismiss?: (id: string) => void;
}): JSX.Element {
  const label = task.status === 'queued' ? `排队 ${position ?? ''}` : task.status === 'running' ? '导入中'
    : task.status === 'completed' ? '已完成' : task.status === 'partial' ? '索引待加载' : task.status === 'cancelled' ? '已取消' : '导入失败';
  const { done, total, message, unit } = task.progress;
  const unitLabel = unit === 'files' ? '个数据文件' : unit === 'entries' ? '条' : '部词典';
  return <div className={`ocr-queue-item import-task-item${task.status === 'running' ? ' is-active' : ''}`} data-testid="dictionary-import-task" data-status={task.status}>
    <div className="ocr-queue-row"><span className="ocr-queue-badge">词典 · {label}</span><span className="ocr-queue-title cell-ellipsis" title={task.source}>{task.title}</span></div>
    <div className="ocr-queue-meta" role="status">{message}{task.status === 'running' && total > 0 ? ` · ${done}/${total} ${unitLabel}` : ''}</div>
    {task.status === 'running' && <div className={`ocr-queue-bar${total === 0 ? ' is-indeterminate' : ''}`} aria-hidden="true"><div className="ocr-queue-bar-fill" style={{ width: total > 0 ? `${Math.min(100, Math.round(done / total * 100))}%` : '35%' }} /></div>}
    {task.result && <p className="ocr-queue-meta">已保存 {task.result.dictionary.termCount} 个词条、{task.result.dictionary.freqCount} 项词频</p>}
    {task.error && <p className="ocr-queue-meta" role="alert">{task.error}</p>}
    {task.result?.warnings.map((warning, index) => <p className="ocr-queue-meta" key={index}>{warning}</p>)}
    <div className="ocr-queue-actions">
      {task.status === 'queued' && onCancel && <button type="button" className="btn btn-sm" onClick={() => onCancel(task.id)}>取消排队</button>}
      {task.finishedAt && onDismiss && <button type="button" className="btn btn-sm" onClick={() => onDismiss(task.id)}>清除</button>}
    </div>
  </div>;
}

function ImportTaskRow({ task, position, onCancel, onDismiss, onOpen }: {
  task: ImportTaskEntry; position?: number; onCancel?: (id: string) => void; onDismiss?: (id: string) => void; onOpen?: (id: string) => void;
}): JSX.Element {
  const label = task.status === 'queued' ? `等待导入 ${position ?? ''}` : task.status === 'running' ? '导入中'
    : task.status === 'completed' ? '导入完成' : task.status === 'partial' ? '部分失败' : task.status === 'cancelled' ? '已取消' : '导入失败';
  const { done, total, message } = task.progress;
  return <div className={`ocr-queue-item import-task-item${task.status === 'running' ? ' is-active' : ''}`} data-testid="import-task" data-status={task.status}>
    <div className="ocr-queue-row"><span className={`ocr-queue-badge${task.status === 'queued' ? ' is-waiting' : ''}`}>{label}</span>
      <span className="ocr-queue-title cell-ellipsis" title={task.source}>{task.title}</span></div>
    <div className="ocr-queue-meta" role="status">{message}{task.status === 'running' && total > 0 ? ` · ${done}/${total} 页` : ''}</div>
    {task.status === 'running' && <div className={`ocr-queue-bar${total === 0 ? ' is-indeterminate' : ''}`} aria-hidden="true"><div className="ocr-queue-bar-fill" style={{ width: total > 0 ? `${Math.min(100, Math.round(100 * done / total))}%` : '35%' }} /></div>}
    {task.results.length > 0 && <details className="import-task-results" open={task.status === 'failed' || task.status === 'partial'}><summary>导入结果（{task.results.length} 项）</summary>
      {task.results.map((result, index) => <div key={index}><span>{result.ok ? '已导入' : '失败'} · {result.source.replace(/\\/g, '/').split('/').at(-1)}{result.error ? `：${result.error}` : ''}</span>
        {result.ok && result.bookId && onOpen && <button type="button" className="btn btn-sm" onClick={() => onOpen(result.bookId!)}>打开书籍</button>}</div>)}
    </details>}
    <div className="ocr-queue-actions">
      {task.status === 'queued' && onCancel && <button type="button" className="btn btn-sm" onClick={() => onCancel(task.id)}>取消排队</button>}
      {task.finishedAt && onDismiss && <button type="button" className="btn btn-sm" onClick={() => onDismiss(task.id)}>清除</button>}
    </div>
  </div>;
}

function StudyTaskRow(props: {
  task: StudyTaskEntry;
  position?: number;
  onCancel?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onOpen?: (bookId: string, title: string) => void;
}): JSX.Element {
  const { task, position, onCancel, onDismiss, onOpen } = props;
  const label = task.kind === 'filter' ? 'AI 筛词' : '释义生成';
  const status = task.status === 'queued' ? `排队 ${position ?? ''}`.trim()
    : task.status === 'running' ? '运行中' : task.status === 'completed' ? '已完成'
      : task.status === 'cancelled' ? '已取消' : '失败';
  return <div className={`ocr-queue-item study-task-item${task.status === 'running' ? ' is-active' : ''}`}>
    <div className="ocr-queue-row">
      <span className={`ocr-queue-badge${task.status === 'queued' ? ' is-waiting' : ''}`}>{status}</span>
      <span className="ocr-queue-title cell-ellipsis" title={task.title}>{task.title}</span>
    </div>
    <div className="ocr-queue-meta mono">{label} · {task.tier} · {task.done}/{task.total} 词{task.error ? ` · ${task.error}` : task.message ? ` · ${task.message}` : ''}</div>
    {task.status === 'running' && <div className="ocr-queue-bar" aria-hidden="true"><div className="ocr-queue-bar-fill" style={{ width: task.total > 0 ? `${Math.round(100 * task.done / task.total)}%` : '0%' }} /></div>}
    <div className="ocr-queue-actions">
      {(task.status === 'running' || task.status === 'queued') && onCancel && <button type="button" className="btn btn-sm" onClick={() => onCancel(task.id)}>{task.status === 'queued' ? '取消排队' : '停止任务'}</button>}
      {onOpen && <button type="button" className="btn btn-sm" onClick={() => onOpen(task.bookId, task.title)}>打开制卡页</button>}
      {task.finishedAt && onDismiss && <button type="button" className="btn btn-sm" onClick={() => onDismiss(task.id)}>清除</button>}
    </div>
  </div>;
}

function stageLabel(progress: OcrProgress): string {
  switch (progress.stage) {
    case 'downloading':
      return '缓存原图';
    case 'loading-model':
      return '准备模型';
    case 'detecting':
      return '检测文字块';
    case 'recognizing':
      return '识别中';
    case 'writing':
      return '写入文字层';
    case 'done':
      return '完成';
    default:
      return '失败';
  }
}

/** 「等待 3 分钟」这类相对时间。入队时间在未来（时钟回拨）时按 0 处理。 */
function waitingFor(enqueuedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - enqueuedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时`;
}
