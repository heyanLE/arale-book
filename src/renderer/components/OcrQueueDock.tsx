/**
 * 右下角的全局任务队列停靠条：OCR 与 Anki AI/翻译任务共用入口。
 *
 * 为什么放在 App 层：OCR 和 AI 筛词/释义都可能耗时数分钟，用户可以离开当前页面。
 * 入口在所有视图的右下角，展开后能看到运行、排队和最近的任务结果。
 *
 * 三种形态：
 * - 没有运行、排队或最近结果时不渲染。
 * - 折叠：一个带进度的胶囊；展开：OCR 与 AI 任务列表及控制。
 *
 * OCR 与学习任务各有主进程队列，可以同时各运行一条；每条学习任务内部仍有有界 LLM 批次并发。
 */

import { useEffect, useRef, useState } from 'react';
import type { OcrProgress, OcrProviderId, OcrQueueState, StudyTaskEntry, StudyTaskQueueState } from '@shared/types';

export interface OcrQueueDockProps {
  queue: OcrQueueState | null;
  /** 各本书的进度快照（`ocr:progress` 事件累计），只有正在跑的那本有值。 */
  progress: Record<string, OcrProgress>;
  /** 引擎 id → 显示名。 */
  providerLabel: (id: OcrProviderId) => string;
  onCancel: (bookId: string) => void;
  studyQueue?: StudyTaskQueueState | null;
  onCancelStudy?: (id: string) => void;
  onDismissStudy?: (id: string) => void;
  onOpenStudy?: (bookId: string, title: string) => void;
  /** 点书名跳过去看那本书。 */
  onOpenBook?: (bookId: string) => void;
}

export function OcrQueueDock(props: OcrQueueDockProps): JSX.Element | null {
  const { queue, progress, providerLabel, onCancel, onOpenBook, studyQueue, onCancelStudy, onDismissStudy, onOpenStudy } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const active = queue?.active ?? null;
  const pending = queue?.pending ?? [];
  const studyActive = studyQueue?.active ?? null;
  const studyPending = studyQueue?.pending ?? [];
  const studyRecent = studyQueue?.recent ?? [];
  const total = (active ? 1 : 0) + pending.length + (studyActive ? 1 : 0) + studyPending.length + studyRecent.length;

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
              {`${(active ? 1 : 0) + (studyActive ? 1 : 0)} 个运行中`}
              {pending.length + studyPending.length > 0 ? ` · 排队 ${pending.length + studyPending.length}` : ''}
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
                  <span className="ocr-queue-badge is-waiting">{index + 1}</span>
                  <span className="ocr-queue-title cell-ellipsis" title={entry.title}>
                    {entry.title}
                  </span>
                </div>
                <div className="ocr-queue-meta mono">
                  {providerLabel(entry.provider)}
                  {entry.total > 0 ? ` · ${entry.total} 页` : ''}
                  {` · 等待 ${waitingFor(entry.enqueuedAt)}`}
                </div>
                <div className="ocr-queue-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => onCancel(entry.bookId)}
                  >
                    取消排队
                  </button>
                </div>
              </div>
            ))}
            {studyActive && <StudyTaskRow task={studyActive} onCancel={onCancelStudy} onOpen={openStudy} />}
            {studyPending.map((task, index) => <StudyTaskRow key={task.id} task={task} position={index + 1} onCancel={onCancelStudy} onOpen={openStudy} />)}
            {studyRecent.map((task) => <StudyTaskRow key={task.id} task={task} onDismiss={onDismissStudy} onOpen={openStudy} />)}
          </div>
        </div>
      )}

      <button
        type="button"
        className={`ocr-dock-pill${open ? ' is-open' : ''}${!active && !studyActive ? ' is-idle' : ''}`}
        onClick={() => setOpen((value) => !value)}
        title="点击查看任务队列"
        aria-expanded={open}
      >
        <span className="ocr-dock-spinner" aria-hidden="true" />
        <span className="ocr-dock-label">
          {active ? '识别中' : studyActive ? 'AI 任务中' : pending.length + studyPending.length > 0 ? '排队中' : '任务结果'}
          {pages > 0 && active ? (
            <span className="mono ocr-dock-progress">
              {Math.min(done + (activeProgress ? 1 : 0), pages)}/{pages}
            </span>
          ) : null}
          {!active && studyActive && studyActive.total > 0 && <span className="mono ocr-dock-progress">{studyActive.done}/{studyActive.total}</span>}
          {pending.length + studyPending.length + studyRecent.length + (active && studyActive ? 1 : 0) > 0 ? (
            <span className="ocr-dock-pending mono">+{pending.length + studyPending.length + studyRecent.length + (active && studyActive ? 1 : 0)}</span>
          ) : null}
        </span>
        <span className="ocr-dock-caret" aria-hidden="true">
          {open ? '▾' : '▴'}
        </span>
      </button>
    </div>
  );
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
