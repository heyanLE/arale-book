/**
 * 左侧栏：书库视图 + 分面（格式 / 标签 / 系列 / 作者）。
 *
 * ⚠️ 契约限制：`LibraryQuery` 只有 `search / format / tags / sort` 四个筛选项，没有独立的
 * series / author 字段（见 shared/types.ts）。而 `search` 的语义是「匹配标题/作者/系列/标签」，
 * 所以系列与作者分面走的是**把名字填进 search**这条等价路径。真要做精确的 series 过滤，
 * 得先扩冻结契约 —— 这里不擅自改。
 */

import type { LibraryQuery } from '@shared/types';

export interface SidebarProps {
  query: LibraryQuery;
  onQueryChange: (patch: Partial<LibraryQuery>) => void;
  total: number;
  formatCounts: { epub: number; comic: number };
  allTags: string[];
  allSeries: string[];
  /** 契约里没有 allAuthors，由 LibraryView 从当前这一页的书里现算（见该文件注释）。 */
  allAuthors: string[];
  /** 标签 → 当前结果里的本数。契约没给，也是现算的。 */
  tagCounts: Record<string, number>;
  onImport: () => void;
}

/** 侧栏最多列多少条分面项，免得一个上万标签的书库把侧栏撑成无限长。 */
const FACET_LIMIT = 200;

export function Sidebar(props: SidebarProps): JSX.Element {
  const { query, onQueryChange, total, formatCounts, allTags, allSeries, allAuthors, tagCounts } =
    props;

  const activeTags = query.tags ?? [];
  const search = query.search ?? '';
  const format = query.format ?? null;
  const sort = query.sort ?? 'title';
  const hasFilter = activeTags.length > 0 || search.trim() !== '' || format !== null;

  const toggleTag = (tag: string) => {
    const next = activeTags.includes(tag)
      ? activeTags.filter((t) => t !== tag)
      : [...activeTags, tag];
    onQueryChange({ tags: next });
  };

  return (
    <nav className="sidebar" aria-label="书库导航">
      <div className="sidebar-scroll">
        <section className="sidebar-section">
          <div className="sidebar-section-title">书库</div>
          <ul className="sidebar-list">
            <SidebarItem
              label="全部书籍"
              count={total}
              active={!hasFilter && sort === 'title'}
              onClick={() => onQueryChange({ search: '', tags: [], format: null, sort: 'title' })}
            />
            <SidebarItem
              label="最近添加"
              active={sort === 'addedDesc'}
              onClick={() => onQueryChange({ sort: 'addedDesc' })}
            />
            <SidebarItem
              label="最近阅读"
              active={sort === 'lastOpened'}
              onClick={() => onQueryChange({ sort: 'lastOpened' })}
            />
            <SidebarItem
              label="按作者排序"
              active={sort === 'author'}
              onClick={() => onQueryChange({ sort: 'author' })}
            />
            <SidebarItem
              label="按系列排序"
              active={sort === 'series'}
              onClick={() => onQueryChange({ sort: 'series' })}
            />
          </ul>
        </section>

        <section className="sidebar-section">
          <div className="sidebar-section-title">格式</div>
          <ul className="sidebar-list">
            <SidebarItem
              label="全部格式"
              active={format === null}
              onClick={() => onQueryChange({ format: null })}
            />
            <SidebarItem
              label="EPUB 小说"
              count={formatCounts.epub}
              active={format === 'epub'}
              onClick={() => onQueryChange({ format: 'epub' })}
            />
            <SidebarItem
              label="漫画"
              count={formatCounts.comic}
              active={format === 'comic'}
              onClick={() => onQueryChange({ format: 'comic' })}
            />
          </ul>
        </section>

        {allTags.length > 0 && (
          <section className="sidebar-section">
            <div className="sidebar-section-title">
              标签
              {activeTags.length > 0 && (
                <button
                  type="button"
                  className="sidebar-clear"
                  onClick={() => onQueryChange({ tags: [] })}
                  title="清除标签筛选"
                >
                  清除
                </button>
              )}
            </div>
            <ul className="sidebar-list">
              {allTags.slice(0, FACET_LIMIT).map((tag) => (
                <SidebarItem
                  key={tag}
                  label={tag}
                  count={tagCounts[tag]}
                  active={activeTags.includes(tag)}
                  onClick={() => toggleTag(tag)}
                />
              ))}
            </ul>
          </section>
        )}

        {allSeries.length > 0 && (
          <section className="sidebar-section">
            <div className="sidebar-section-title">系列</div>
            <ul className="sidebar-list">
              {allSeries.slice(0, FACET_LIMIT).map((series) => (
                <SidebarItem
                  key={series}
                  label={series}
                  active={search === series}
                  onClick={() =>
                    onQueryChange({ search: search === series ? '' : series, tags: [] })
                  }
                />
              ))}
            </ul>
          </section>
        )}

        {allAuthors.length > 0 && (
          <section className="sidebar-section">
            <div className="sidebar-section-title">作者</div>
            <ul className="sidebar-list">
              {allAuthors.slice(0, FACET_LIMIT).map((author) => (
                <SidebarItem
                  key={author}
                  label={author}
                  active={search === author}
                  onClick={() =>
                    onQueryChange({ search: search === author ? '' : author, tags: [] })
                  }
                />
              ))}
            </ul>
          </section>
        )}
      </div>

      <div className="sidebar-footer">
        <button type="button" className="btn btn-sm btn-block" onClick={props.onImport}>
          ＋ 导入书籍…
        </button>
      </div>
    </nav>
  );
}

interface SidebarItemProps {
  label: string;
  count?: number | undefined;
  active: boolean;
  onClick: () => void;
}

function SidebarItem({ label, count, active, onClick }: SidebarItemProps): JSX.Element {
  return (
    <li>
      <button
        type="button"
        className={`sidebar-item${active ? ' is-active' : ''}`}
        onClick={onClick}
        title={label}
      >
        <span className="sidebar-item-label">{label}</span>
        {typeof count === 'number' && <span className="sidebar-item-count">{count}</span>}
      </button>
    </li>
  );
}
