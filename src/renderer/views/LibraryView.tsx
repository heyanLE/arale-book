/**
 * 书库视图：左（分面侧栏）+ 中（书列表）+ 右（详情）三栏，栏间是可拖的分隔条。
 *
 * 该文件负责的事情：查询与筛选、拖放/导入、右键菜单、多选动作、面板宽度的拖动持久化。
 * 列表本身的键盘与选择手势在 BookGrid 里。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import type { BookFormat, BookRecord, LibraryInfo, LibraryPage, LibraryQuery, LibrarySort } from '@shared/types';
import { api, call, run, summarizeImportOutcome, useAsync, useIpcEvent } from '../lib/api';
import { updateSettings, useSettings } from '../lib/reader-settings';
import { Sidebar } from '../components/Sidebar';
import { BookGrid } from '../components/BookGrid';
import { BookDetail, type BookMetaPatch } from '../components/BookDetail';
import { capturePointer } from '../lib/pointer';

export interface LibraryViewProps {
  query: LibraryQuery;
  onQueryChange: (patch: Partial<LibraryQuery>) => void;
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  /** 变化时重拉列表（导入/移除/更新元数据之后 App 会 +1）。 */
  reloadToken: number;
  onOpenBook: (bookId: string) => void;
  onLibraryChanged: () => void;
  onStatus: (message: string) => void;
  onStats: (stats: { shown: number; total: number }) => void;
  searchRef: React.RefObject<HTMLInputElement>;
  info: LibraryInfo | null;
}

/**
 * 一次拉多少本。
 * `LibraryQuery` 有 offset/limit，说明主进程那边是分页的；但 Calibre 式的封面墙滚动体验
 * 依赖「一次拿够」。这里先取一个大页，真正上万本的书库再补虚拟滚动/增量加载。
 */
const LIST_LIMIT = 5000;

const SORT_OPTIONS: { value: LibrarySort; label: string }[] = [
  { value: 'title', label: '标题 ↑' },
  { value: 'titleDesc', label: '标题 ↓' },
  { value: 'author', label: '作者' },
  { value: 'series', label: '系列' },
  { value: 'added', label: '添加时间 ↑' },
  { value: 'addedDesc', label: '添加时间 ↓' },
  { value: 'lastOpened', label: '最近阅读' },
];

export function LibraryView(props: LibraryViewProps): JSX.Element {
  const {
    query,
    onQueryChange,
    selectedIds,
    onSelectionChange,
    reloadToken,
    onOpenBook,
    onLibraryChanged,
    onStatus,
    onStats,
    searchRef,
    info,
  } = props;

  const settings = useSettings();

  const page = useAsync<LibraryPage>(() => api.library.list({ ...query, limit: LIST_LIMIT }), [
    query,
    reloadToken,
  ]);
  const books = useMemo(() => page.data?.books ?? [], [page.data]);

  // ------------------------------------------------------------------
  // 状态上报 / 分面派生
  // ------------------------------------------------------------------

  useEffect(() => {
    if (!page.data) return;
    onStats({ shown: page.data.books.length, total: page.data.total });
  }, [page.data, onStats]);

  /*
   * `allTags` / `allSeries` / `allAuthors` 都来自主进程，且是**整库**算的。
   * 作者清单以前在渲染进程从「当前这一页」现算 —— 那种写法在选中一个作者之后
   * 会把其余作者从侧栏里抹掉（筛选结果里只剩他，现算出来自然只剩他）。
   * 只有 `tagCounts` 随筛选变，那才是分面该有的语义（每个选项当前有几本）。
   */

  const tagCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const book of books) {
      for (const tag of book.tags) counts[tag] = (counts[tag] ?? 0) + 1;
    }
    return counts;
  }, [books]);

  const formatCounts = useMemo(
    () => ({ epub: info?.epubCount ?? 0, comic: info?.comicCount ?? 0 }),
    [info],
  );

  // ------------------------------------------------------------------
  // 导入
  // ------------------------------------------------------------------

  const importPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) {
        onStatus('没有拿到可导入的路径');
        return;
      }
      onStatus(`正在导入 ${paths.length} 个路径…`);
      const outcomes = await call('导入', () => api.library.importPaths(paths));
      if (!outcomes) return;
      onStatus(summarizeImportOutcome(outcomes));
      if (outcomes.some((o) => o.ok)) onLibraryChanged();
    },
    [onLibraryChanged, onStatus],
  );

  /**
   * 拖放导入的两条路径：
   *
   * 1. **HTML5 dnd（主路径）**：`onDrop` 拿到 `File` 对象，经 `api.paths.forFile`
   *    （预加载里的 `webUtils.getPathForFile`）换成绝对路径。这是必须的——Electron ≥32
   *    移除了 `File.path`，而渲染进程在 sandbox 下拿不到 webUtils。
   * 2. **`shell:openFiles`（旁路）**：主进程在「用本应用打开文件」（macOS `open-file`、
   *    命令行参数）时派发，路径本来就是绝对的，不需要转换。
   */
  useIpcEvent('shell:openFiles', (payload) => {
    if (!payload || !Array.isArray(payload.paths)) return;
    void importPaths(payload.paths);
  });

  const onDragOver = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files ?? []);
      const paths: string[] = [];
      for (const file of files) {
        let resolved = '';
        try {
          resolved = api.paths.forFile(file) ?? '';
        } catch {
          resolved = '';
        }
        // 兜底：更老的 Electron 上 `File.path` 还在（forFile 返回空串时用它）。
        if (resolved === '') {
          const legacy = (file as File & { path?: unknown }).path;
          if (typeof legacy === 'string') resolved = legacy;
        }
        if (resolved !== '') paths.push(resolved);
      }
      if (paths.length === 0) {
        // 连一个路径都解不出来（例如从浏览器拖来的虚拟文件）——给明确出路，别静默吞。
        onStatus('拖进来的不是本地文件（拿不到路径），请用「＋ 导入」按钮选择');
        return;
      }
      void importPaths(paths);
    },
    [importPaths, onStatus],
  );

  const importViaDialog = useCallback(async () => {
    const outcomes = await call('导入', () => api.library.importViaDialog());
    if (!outcomes) return;
    onStatus(summarizeImportOutcome(outcomes));
    if (outcomes.some((o) => o.ok)) onLibraryChanged();
  }, [onLibraryChanged, onStatus]);

  // ------------------------------------------------------------------
  // 书籍操作
  // ------------------------------------------------------------------

  const removeBooks = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      // window.confirm 是同步原生弹窗：对「从书库移除」这种不可撤销操作，简单可靠优先。
      if (!window.confirm(`确定从书库中移除这 ${ids.length} 本书吗？此操作不可撤销。`)) return;
      const ok = await call('移除书籍', async () => {
        await api.library.remove(ids);
        return true;
      });
      if (!ok) return;
      onSelectionChange([]);
      onLibraryChanged();
      onStatus(`已移除 ${ids.length} 本`);
    },
    [onLibraryChanged, onSelectionChange, onStatus],
  );

  const updateMeta = useCallback(
    async (bookId: string, patch: BookMetaPatch) => {
      const updated = await call('更新元数据', () => api.library.updateMeta(bookId, patch));
      if (!updated) return;
      onStatus(`已更新《${updated.title}》`);
      onLibraryChanged();
    },
    [onLibraryChanged, onStatus],
  );

  const revealBook = useCallback((bookId: string) => {
    run('在文件夹中显示', () => api.library.reveal(bookId));
  }, []);

  const filterByTag = useCallback(
    (tag: string) => {
      const current = query.tags ?? [];
      if (current.includes(tag)) return;
      onQueryChange({ tags: [...current, tag] });
    },
    [onQueryChange, query.tags],
  );

  // ------------------------------------------------------------------
  // 三栏宽度（拖动中只改本地 state，松手才写 localStorage）
  // ------------------------------------------------------------------

  const [sidebarWidth, setSidebarWidth] = useState(settings.sidebarWidth);
  const [detailWidth, setDetailWidth] = useState(settings.detailWidth);
  const sidebarRef = useRef(sidebarWidth);
  const detailRef = useRef(detailWidth);
  sidebarRef.current = sidebarWidth;
  detailRef.current = detailWidth;

  const startResize = useCallback(
    (which: 'sidebar' | 'detail') => (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const handle = event.currentTarget;
      const startX = event.clientX;
      const startWidth = which === 'sidebar' ? sidebarRef.current : detailRef.current;
      capturePointer(handle, event.pointerId);

      const onMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - startX;
        // 右侧栏是「从右边拖进来」，方向与左侧相反。
        const next =
          which === 'sidebar'
            ? clamp(startWidth + delta, 120, 520)
            : clamp(startWidth - delta, 200, 640);
        if (which === 'sidebar') setSidebarWidth(next);
        else setDetailWidth(next);
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        updateSettings(
          which === 'sidebar' ? { sidebarWidth: sidebarRef.current } : { detailWidth: detailRef.current },
        );
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    },
    [],
  );

  // ------------------------------------------------------------------
  // 右键菜单
  // ------------------------------------------------------------------

  const [menu, setMenu] = useState<{ x: number; y: number; book: BookRecord } | null>(null);

  const openMenu = useCallback(
    (book: BookRecord, x: number, y: number) => {
      // Calibre 的行为：右键一本没被选中的书 → 先把选择切到它，右键已选中的书 → 保留多选。
      if (!selectedIds.includes(book.id)) onSelectionChange([book.id]);
      setMenu({ x, y, book });
    },
    [onSelectionChange, selectedIds],
  );

  const menuTargets = menu ? (selectedIds.includes(menu.book.id) ? selectedIds : [menu.book.id]) : [];

  // ------------------------------------------------------------------

  const activeTags = query.tags ?? [];
  const hasFilter = activeTags.length > 0 || (query.search ?? '') !== '' || (query.format ?? null) !== null;

  return (
    <div className="library" onDragOver={onDragOver} onDrop={onDrop}>
      {settings.showSidebar && (
        <>
          <div className="library-side" style={{ width: sidebarWidth }}>
            <Sidebar
              query={query}
              onQueryChange={onQueryChange}
              total={page.data?.total ?? 0}
              formatCounts={formatCounts}
              allTags={page.data?.allTags ?? []}
              allSeries={page.data?.allSeries ?? []}
              allAuthors={page.data?.allAuthors ?? []}
              tagCounts={tagCounts}
              onImport={() => void importViaDialog()}
            />
          </div>
          <div
            className="splitter splitter-v"
            role="separator"
            aria-orientation="vertical"
            onPointerDown={startResize('sidebar')}
            title="拖动调整宽度"
          />
        </>
      )}

      <div className="library-center">
        <div className="filterbar">
          <input
            ref={searchRef}
            className="input search-input"
            type="search"
            placeholder="搜索标题 / 作者 / 系列 / 标签…  (Cmd/Ctrl+F)"
            value={query.search ?? ''}
            onChange={(e) => onQueryChange({ search: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onQueryChange({ search: '' });
                e.currentTarget.blur();
              }
            }}
          />

          <select
            className="select"
            value={query.format ?? ''}
            onChange={(e) =>
              onQueryChange({ format: e.target.value === '' ? null : (e.target.value as BookFormat) })
            }
            title="格式筛选"
          >
            <option value="">全部格式</option>
            <option value="epub">EPUB 小说</option>
            <option value="comic">漫画</option>
          </select>

          <select
            className="select"
            value={query.sort ?? 'title'}
            onChange={(e) => onQueryChange({ sort: e.target.value as LibrarySort })}
            title="排序"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          {hasFilter && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onQueryChange({ search: '', tags: [], format: null })}
              title="清除全部筛选"
            >
              清除筛选
            </button>
          )}
        </div>

        <div className="library-list">
          {page.loading && page.data === null ? (
            <div className="placeholder">正在读取书库…</div>
          ) : page.error !== null && page.data === null ? (
            <div className="placeholder placeholder-error">
              读取书库失败：{page.error.message}
            </div>
          ) : (
            <BookGrid
              books={books}
              mode={settings.libraryView}
              selectedIds={selectedIds}
              onSelectionChange={onSelectionChange}
              onOpen={(book) => onOpenBook(book.id)}
              onContextMenu={openMenu}
              onDeleteSelection={() => void removeBooks(selectedIds)}
              emptyHint={hasFilter ? '没有符合条件的书' : '书库还是空的'}
            />
          )}
        </div>
      </div>

      {settings.showDetail && (
        <>
          <div
            className="splitter splitter-v"
            role="separator"
            aria-orientation="vertical"
            onPointerDown={startResize('detail')}
            title="拖动调整宽度"
          />
          <div className="library-detail" style={{ width: detailWidth }}>
            <BookDetail
              book={lastOf(books, selectedIds)}
              selectedIds={selectedIds}
              onOpen={onOpenBook}
              onRemove={(ids) => void removeBooks(ids)}
              onReveal={revealBook}
              onUpdateMeta={(id, patch) => void updateMeta(id, patch)}
              onFilterTag={filterByTag}
              onClose={() => updateSettings({ showDetail: false })}
            />
          </div>
        </>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            {
              label: '打开阅读',
              disabled: menuTargets.length !== 1,
              onSelect: () => onOpenBook(menu.book.id),
            },
            {
              label: '在文件夹中显示',
              disabled: menuTargets.length !== 1,
              onSelect: () => revealBook(menu.book.id),
            },
            { separator: true },
            {
              label: '在详情面板中编辑',
              onSelect: () => updateSettings({ showDetail: true }),
            },
            {
              label: `切换阅读方向（${menu.book.direction === 'rtl' ? 'RTL → LTR' : 'LTR → RTL'}）`,
              onSelect: () => {
                for (const id of menuTargets) {
                  void updateMeta(id, {
                    direction: menu.book.direction === 'rtl' ? 'ltr' : 'rtl',
                  });
                }
              },
            },
            { separator: true },
            {
              label: menuTargets.length > 1 ? `从书库移除这 ${menuTargets.length} 本…` : '从书库移除…',
              danger: true,
              onSelect: () => void removeBooks(menuTargets),
            },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/** 详情面板展示「最后一个被选中的书」，与 BookGrid 的光标语义一致。 */
function lastOf(books: BookRecord[], selectedIds: string[]): BookRecord | null {
  for (let i = selectedIds.length - 1; i >= 0; i -= 1) {
    const id = selectedIds[i];
    if (id === undefined) continue;
    const hit = books.find((b) => b.id === id);
    if (hit) return hit;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// 自定义右键菜单
// ---------------------------------------------------------------------------

interface MenuItem {
  label?: string;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
}

/**
 * 自己画的右键菜单（**不用** Electron 原生 Menu）。
 * 原因：原生菜单要跨进程往返、拿不到渲染进程的实时选择状态、也无法做主题适配；
 * 而这里需要的只是「几个按钮 + 键盘可用」。
 */
function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // 贴边翻转：先渲染在点击处，量到实际尺寸后再夹进视口。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
    });
  }, [x, y, items.length]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    window.addEventListener('wheel', onClose, { passive: true });
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('wheel', onClose);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="ctxmenu" style={{ left: pos.left, top: pos.top }} role="menu">
      {items.map((item, index) =>
        item.separator === true ? (
          <div key={`sep-${index}`} className="ctxmenu-sep" role="separator" />
        ) : (
          <button
            key={item.label ?? index}
            type="button"
            role="menuitem"
            className={`ctxmenu-item${item.danger === true ? ' is-danger' : ''}`}
            disabled={item.disabled === true}
            onClick={() => {
              onClose();
              item.onSelect?.();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
