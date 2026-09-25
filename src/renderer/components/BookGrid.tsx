/**
 * 中央书列表。同一个组件承担两种模式：
 * - `grid`：封面缩略图（默认，Calibre 的封面墙）；
 * - `list`：表格列 Title / Author / Series / Format / Pages / Added。
 *
 * 键盘与选择模型都放在这里，因为它们是「列表」的属性而不是外层视图的：
 * ↑↓/Home/End/PageUp/PageDown 移动光标，Shift+方向键扩选，Enter 打开，Delete 移除，
 * Cmd/Ctrl+A 全选，Esc 清空选择。鼠标侧：单击选中、Cmd/Ctrl+单击切换、Shift+单击范围选、
 * 双击打开、右键出上下文菜单。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// React 的命名空间只用于类型（React.MouseEvent 等）；`import type` 保证运行时零残留。
import type * as React from 'react';
import type { BookRecord } from '@shared/types';
import { assetUrl } from '../lib/api';
import type { LibraryViewMode } from '../lib/reader-settings';

export interface BookGridProps {
  books: BookRecord[];
  mode: LibraryViewMode;
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  onOpen: (book: BookRecord) => void;
  onContextMenu: (book: BookRecord, x: number, y: number) => void;
  /** Delete 键：由外层做确认与 IPC（选择状态在 App，移除逻辑不该在列表里）。 */
  onDeleteSelection: () => void;
  emptyHint: string;
}

export function BookGrid(props: BookGridProps): JSX.Element {
  const { books, mode, selectedIds, onSelectionChange, onOpen, onContextMenu, emptyHint } = props;

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const [cursor, setCursor] = useState<string | null>(null);
  /** Shift 扩选的锚点。和「当前光标」分开记：扩选后再按方向键是移动活动端，锚点不动。 */
  const anchorRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const cursorId = useMemo(() => {
    if (cursor && books.some((b) => b.id === cursor)) return cursor;
    const last = selectedIds[selectedIds.length - 1];
    if (last && books.some((b) => b.id === last)) return last;
    return null;
  }, [cursor, books, selectedIds]);

  // 让光标始终可见（键盘导航时列表要跟着滚）。
  useEffect(() => {
    if (!cursorId) return;
    const root = scrollRef.current;
    if (!root) return;
    const node = root.querySelector<HTMLElement>(`[data-book-id="${CSS.escape(cursorId)}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [cursorId, mode]);

  const selectOnly = useCallback(
    (id: string) => {
      anchorRef.current = id;
      setCursor(id);
      onSelectionChange([id]);
    },
    [onSelectionChange],
  );

  const toggle = useCallback(
    (id: string) => {
      const next = new Set(selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      anchorRef.current = id;
      setCursor(id);
      // 按书库顺序输出，保证「最后一本选中的书」语义稳定（详情面板取末位）。
      onSelectionChange(books.filter((b) => next.has(b.id)).map((b) => b.id));
    },
    [books, onSelectionChange, selectedIds],
  );

  const selectRange = useCallback(
    (id: string) => {
      const anchor = anchorRef.current ?? cursorId ?? id;
      const from = books.findIndex((b) => b.id === anchor);
      const to = books.findIndex((b) => b.id === id);
      if (from < 0 || to < 0) {
        selectOnly(id);
        return;
      }
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      setCursor(id);
      onSelectionChange(books.slice(lo, hi + 1).map((b) => b.id));
    },
    [books, cursorId, onSelectionChange, selectOnly],
  );

  const moveTo = useCallback(
    (index: number, extend: boolean) => {
      const target = books[index];
      if (!target) return;
      if (extend) {
        if (!anchorRef.current) anchorRef.current = cursorId ?? target.id;
        selectRange(target.id);
      } else {
        selectOnly(target.id);
      }
    },
    [books, cursorId, selectRange, selectOnly],
  );

  const onRowClick = useCallback(
    (event: React.MouseEvent, book: BookRecord) => {
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        toggle(book.id);
      } else if (event.shiftKey) {
        event.preventDefault();
        selectRange(book.id);
      } else {
        selectOnly(book.id);
      }
    },
    [selectOnly, selectRange, toggle],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const index = books.findIndex((b) => b.id === cursorId);
      const current = index < 0 ? 0 : index;
      const mod = event.metaKey || event.ctrlKey;

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          moveTo(Math.min(books.length - 1, current + 1), event.shiftKey);
          break;
        case 'ArrowUp':
          event.preventDefault();
          moveTo(Math.max(0, current - 1), event.shiftKey);
          break;
        case 'PageDown':
          event.preventDefault();
          moveTo(Math.min(books.length - 1, current + 10), event.shiftKey);
          break;
        case 'PageUp':
          event.preventDefault();
          moveTo(Math.max(0, current - 10), event.shiftKey);
          break;
        case 'Home':
          event.preventDefault();
          moveTo(0, event.shiftKey);
          break;
        case 'End':
          event.preventDefault();
          moveTo(books.length - 1, event.shiftKey);
          break;
        case 'Enter': {
          event.preventDefault();
          const book = books[current];
          if (book) onOpen(book);
          break;
        }
        case ' ': {
          event.preventDefault();
          if (cursorId) toggle(cursorId);
          break;
        }
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          props.onDeleteSelection();
          break;
        case 'Escape':
          event.preventDefault();
          onSelectionChange([]);
          break;
        case 'a':
        case 'A':
          if (mod) {
            event.preventDefault();
            onSelectionChange(books.map((b) => b.id));
          }
          break;
        default:
          break;
      }
    },
    [books, cursorId, moveTo, onOpen, onSelectionChange, props, toggle],
  );

  if (books.length === 0) {
    return (
      <div className="bookgrid-empty">
        <div className="bookgrid-empty-title">{emptyHint}</div>
        <div className="bookgrid-empty-hint">把 EPUB / CBZ / 图片文件夹拖到窗口里，或点工具栏的「＋ 导入」。</div>
      </div>
    );
  }

  return (
    <div
      className={`bookgrid bookgrid-${mode}`}
      ref={scrollRef}
      tabIndex={0}
      role="listbox"
      aria-multiselectable
      onKeyDown={onKeyDown}
    >
      {mode === 'list' && (
        <div className="book-list-head" role="presentation">
          <span className="col col-title">标题</span>
          <span className="col col-author">作者</span>
          <span className="col col-series">系列</span>
          <span className="col col-format">格式</span>
          <span className="col col-pages">页数</span>
          <span className="col col-added">添加时间</span>
        </div>
      )}

      {mode === 'list'
        ? books.map((book) => (
            <div
              key={book.id}
              data-book-id={book.id}
              role="option"
              aria-selected={selected.has(book.id)}
              className={`book-row${selected.has(book.id) ? ' is-selected' : ''}${
                cursorId === book.id ? ' is-cursor' : ''
              }`}
              onClick={(event) => onRowClick(event, book)}
              onDoubleClick={() => onOpen(book)}
              onContextMenu={(event) => {
                event.preventDefault();
                onContextMenu(book, event.clientX, event.clientY);
              }}
              title={book.dir}
            >
              <span className="col col-title">
                {book.coverRel !== null && <RowThumb book={book} />}
                <span className="cell-ellipsis">{book.title}</span>
                {book.volume !== null && <span className="vol-chip">第 {book.volume} 卷</span>}
              </span>
              <span className="col col-author cell-ellipsis">{book.author}</span>
              <span className="col col-series cell-ellipsis">{book.series ?? '—'}</span>
              <span className="col col-format">
                <span className={`format-chip format-${book.format}`}>{formatLabel(book)}</span>
              </span>
              <span className="col col-pages mono">{book.pageCount}</span>
              <span className="col col-added mono">{formatDate(book.addedAt)}</span>
            </div>
          ))
        : books.map((book) => (
            <div
              key={book.id}
              data-book-id={book.id}
              role="option"
              aria-selected={selected.has(book.id)}
              className={`book-tile${selected.has(book.id) ? ' is-selected' : ''}${
                cursorId === book.id ? ' is-cursor' : ''
              }`}
              onClick={(event) => onRowClick(event, book)}
              onDoubleClick={() => onOpen(book)}
              onContextMenu={(event) => {
                event.preventDefault();
                onContextMenu(book, event.clientX, event.clientY);
              }}
              title={`${book.title}${book.author ? ` — ${book.author}` : ''}`}
            >
              <div className="book-tile-cover">
                <Cover book={book} />
              </div>
              <div className="book-tile-title cell-ellipsis">{book.title}</div>
              <div className="book-tile-sub cell-ellipsis">
                {book.author || '未知作者'}
                {book.volume !== null ? ` · 第 ${book.volume} 卷` : ''}
              </div>
            </div>
          ))}
    </div>
  );
}

function RowThumb({ book }: { book: BookRecord }): JSX.Element | null {
  const src = assetUrl(book.id, book.coverRel);
  if (!src) return null;
  return <img className="row-thumb" src={src} alt="" loading="lazy" decoding="async" />;
}

function Cover({ book }: { book: BookRecord }): JSX.Element {
  const src = assetUrl(book.id, book.coverRel);
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    // 没有封面时用首字做占位 —— 比一个灰色空框信息量大。
    return (
      <div className={`cover-placeholder cover-${book.format}`}>
        <span>{book.title.slice(0, 1) || '书'}</span>
      </div>
    );
  }
  return (
    <img
      className="cover-img"
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
    />
  );
}

function formatLabel(book: BookRecord): string {
  return book.format === 'epub' ? 'EPUB' : '漫画';
}

function formatDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
  const date = new Date(timestamp);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
