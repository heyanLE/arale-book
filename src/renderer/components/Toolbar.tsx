/**
 * 顶部工具栏。
 *
 * 桌面应用的工具链应该**永远在场**（不像网页那样跟着内容滚动），所以它是 `.app` 的
 * 固定一行，而不是视图内部的一部分。图标全部用文字/符号，不引图标库 —— 一是「不加依赖」
 * 的硬约束，二是 Calibre/Qt 那一挂本来就是这种朴素观感。
 *
 * 唯一的例外是品牌标记：应用图标/头像是**画出来的素材**（`assets/arale-icons-v2`），
 * 用文字拼不出来。它由 `scripts/make-icon.mjs` 从素材包同步成这里的 `brand-mark.png`
 * （64px，显示 22px），改图标改素材包后重跑 `npm run icon`，不要手改这张图。
 */

import type { ViewName } from '../App';
import { APP_NAME_EN, APP_NAME_FULL, APP_NAME_JA } from '@shared/brand';
import type { LibraryViewMode, ThemeMode } from '../lib/reader-settings';
import brandMark from '../assets/brand-mark.png';

export interface ToolbarProps {
  view: ViewName;
  /** 阅读器视图下的书名，其它视图传 null。 */
  bookTitle: string | null;
  libraryDir: string | null;
  viewMode: LibraryViewMode;
  onViewMode: (mode: LibraryViewMode) => void;
  showSidebar: boolean;
  onToggleSidebar: () => void;
  showDetail: boolean;
  onToggleDetail: () => void;
  busy: boolean;
  theme: ThemeMode;
  onCycleTheme: () => void;
  onImport: () => void;
  onOpenSettings: () => void;
  onLeaveReader: () => void;
}

const THEME_LABEL: Record<ThemeMode, string> = {
  system: '主题：跟随系统',
  light: '主题：浅色',
  dark: '主题：深色',
};

export function Toolbar(props: ToolbarProps): JSX.Element {
  const {
    view,
    bookTitle,
    libraryDir,
    viewMode,
    onViewMode,
    showSidebar,
    onToggleSidebar,
    showDetail,
    onToggleDetail,
    busy,
    theme,
    onCycleTheme,
    onImport,
    onOpenSettings,
    onLeaveReader,
  } = props;

  const inLibrary = view === 'library';

  return (
    <header className="toolbar">
      {/* 品牌标记常驻最左：在书库和阅读器里都在，用户任何时候都知道自己在哪个应用里。
          `alt=""` 是刻意的：右边就写着应用名，读屏再念一遍图标只是噪音。 */}
      <div className="brand" title={APP_NAME_FULL}>
        <img className="brand-mark" src={brandMark} alt="" draggable={false} />
        <span className="brand-text">
          <span className="brand-ja">{APP_NAME_JA}</span>
          <span className="brand-en">{APP_NAME_EN}</span>
        </span>
      </div>

      <div className="toolbar-group">
        {!inLibrary && (
          <button type="button" className="tool-btn" onClick={onLeaveReader} title="返回书库 (Esc)">
            ← 书库
          </button>
        )}

        {inLibrary && (
          <button
            type="button"
            className={`tool-btn${showSidebar ? ' is-active' : ''}`}
            onClick={onToggleSidebar}
            title="显示/隐藏左侧栏"
          >
            ▤ 侧栏
          </button>
        )}

        <span className="toolbar-title" title={libraryDir ?? undefined}>
          {view === 'reader'
            ? (bookTitle ?? '阅读器')
            : view === 'settings'
              ? '设置'
              : (libraryDir ?? '书库')}
        </span>

        {busy && <span className="toolbar-spinner" title="处理中" />}
      </div>

      <div className="toolbar-spacer" />

      <div className="toolbar-group">
        {inLibrary && (
          <>
            <div className="seg" role="group" aria-label="视图模式">
              <button
                type="button"
                className={`seg-btn${viewMode === 'grid' ? ' is-active' : ''}`}
                onClick={() => onViewMode('grid')}
                title="封面网格"
              >
                ▦ 网格
              </button>
              <button
                type="button"
                className={`seg-btn${viewMode === 'list' ? ' is-active' : ''}`}
                onClick={() => onViewMode('list')}
                title="详细列表"
              >
                ☰ 列表
              </button>
            </div>

            <span className="toolbar-sep" />

            <button
              type="button"
              className={`tool-btn${showDetail ? ' is-active' : ''}`}
              onClick={onToggleDetail}
              title="显示/隐藏右侧详情"
            >
              ▥ 详情
            </button>

            <button type="button" className="tool-btn" onClick={onImport} title="导入书籍（也可拖放文件）">
              ＋ 导入
            </button>
          </>
        )}

        <span className="toolbar-sep" />

        <button type="button" className="tool-btn" onClick={onCycleTheme} title={THEME_LABEL[theme]}>
          {theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐'}
        </button>

        <button
          type="button"
          className={`tool-btn${view === 'settings' ? ' is-active' : ''}`}
          onClick={onOpenSettings}
          title="设置与词典管理 (Cmd/Ctrl+,)"
        >
          ⚙ 设置
        </button>
      </div>
    </header>
  );
}
