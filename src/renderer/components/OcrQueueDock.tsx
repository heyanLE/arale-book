/**
 * 右下角的**全局 OCR 队列**停靠条 + 弹层。
 *
 * 为什么放在 App 层而不是阅读器里：识别是分钟级的长任务，用户完全可以点完就去书架
 * 翻别的、或者去设置里逛一圈。所以入口必须在**所有视图**都在同一个位置（右下角），
 * 而且点开就能看到「现在在识别哪一本、后面还排着几本」。
 *
 * 三种形态：
 * - 队列为空：整个组件不渲染（不留一个「0 个任务」的噪音）。
 * - 折叠：一个胶囊，`识别中 12/171 · 还有 2 本`，点击展开。
 * - 展开：弹层列出正在跑的那条（带进度条 + 停止按钮）与排队中的条目（带「取消排队」）。
 *
 * 队列是**串行**的（见 `main/ocr/service.ts`），所以弹层里最多只有一条「识别中」——
 * 这不是 UI 偷懒，而是主进程的真实状态。
 */

import { useEffect, useRef, useState } from 'react';
import type { OcrProgress, OcrProviderId, OcrQueueState } from '@shared/types';

export interface OcrQueueDockProps {
  queue: OcrQueueState | null;
  /** 各本书的进度快照（`ocr:progress` 事件累计），只有正在跑的那本有值。 */
  progress: Record<string, OcrProgress>;
  /** 引擎 id → 显示名。 */
  providerLabel: (id: OcrProviderId) => string;
  onCancel: (bookId: string) => void;
  /** 点书名跳过去看那本书。 */
  onOpenBook?: (bookId: string) => void;
}

export function OcrQueueDock(props: OcrQueueDockProps): JSX.Element | null {
  const { queue, progress, providerLabel, onCancel, onOpenBook } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const active = queue?.active ?? null;
  const pending = queue?.pending ?? [];
  const total = (active ? 1 : 0) + pending.length;

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

  return (
    <div className="ocr-dock" ref={rootRef}>
      {open && (
        <div className="ocr-dock-panel" role="dialog" aria-label="识别队列">
          <div className="ocr-dock-head">
            <span className="ocr-dock-title">识别队列</span>
            <span className="ocr-dock-count mono">
              {active ? `识别中 1` : '空闲'}
              {pending.length > 0 ? ` · 排队 ${pending.length}` : ''}
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
                      onClick={() => onOpenBook(active.bookId)}
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
          </div>
        </div>
      )}

      <button
        type="button"
        className={`ocr-dock-pill${open ? ' is-open' : ''}`}
        onClick={() => setOpen((value) => !value)}
        title="点击查看识别队列"
        aria-expanded={open}
      >
        <span className="ocr-dock-spinner" aria-hidden="true" />
        <span className="ocr-dock-label">
          {active ? '识别中' : '排队中'}
          {pages > 0 && active ? (
            <span className="mono ocr-dock-progress">
              {Math.min(done + (activeProgress ? 1 : 0), pages)}/{pages}
            </span>
          ) : null}
          {pending.length > 0 ? (
            <span className="ocr-dock-pending mono">+{pending.length}</span>
          ) : null}
        </span>
        <span className="ocr-dock-caret" aria-hidden="true">
          {open ? '▾' : '▴'}
        </span>
      </button>
    </div>
  );
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
