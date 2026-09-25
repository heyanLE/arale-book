/**
 * 渲染进程的持久化偏好设置（localStorage）。
 *
 * 为什么不放主进程：这些值全是**纯 UI 状态**（面板宽度、字号、视图模式），不需要参与
 * 书库索引，也没有跨窗口共享需求；走 localStorage 少一条 IPC 往返。真正的书籍元数据
 * 与阅读进度仍然在主进程（见 shared/types.ts）。
 *
 * 用 `useSyncExternalStore` 做订阅：React 18 内置，读的是稳定快照，多个组件同时读写
 * 不会撕裂（书库视图与阅读器会同时改 fontScale）。
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { LibrarySort, OcrProviderId } from '@shared/types';
import type { ReaderAppearance } from '@shared/reader-bridge';
import { clampSpreadOffset } from '@core/comic/spread';

export type ThemeMode = 'system' | 'light' | 'dark';
export type LibraryViewMode = 'grid' | 'list';
export type ComicFitMode = 'width' | 'height' | 'actual';

export interface AppSettings {
  /** system = 跟随 prefers-color-scheme。 */
  theme: ThemeMode;

  /**
   * 沉浸模式：阅读时自动隐藏上下两条工具栏，鼠标一动再出现。
   *
   * 是**应用级**偏好而不是按书覆盖：它是「我怎么用这个阅读器」的习惯，
   * 不会因为换一本书就变（和字号/双页那种「这本书怎么排」不同）。
   */
  autoHideChrome: boolean;

  // --- 书库视图 ---
  libraryView: LibraryViewMode;
  sort: LibrarySort;
  showSidebar: boolean;
  showDetail: boolean;
  /** 左侧栏宽度（px），由分隔条拖动写回。 */
  sidebarWidth: number;
  /** 右侧详情栏宽度（px）。 */
  detailWidth: number;

  // --- 阅读器外观 ---
  /** EPUB 字号倍率，透传给 iframe 的 `--arale-font-scale`。 */
  fontScale: number;
  /** 竖排（日文小说默认开）。 */
  vertical: boolean;
  /** 空串 = 跟随书籍自身字体。 */
  fontFamily: string;
  lineHeight: number;
  /** 版心边距（px）。 */
  margin: number;

  // --- 漫画阅读器 ---
  comicFit: ComicFitMode;
  /** 双页跨页模式。 */
  comicSpread: boolean;
  /**
   * 双页配对偏移：前几页各自单独成页（0..4）。
   *
   * 存在的理由是**封面**：日漫单行本第 1 页就是表紙，offset=0 会把封面和扉页并排。
   * 规则见 `core/comic/spread.ts`。
   */
  comicSpreadOffset: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  autoHideChrome: false,
  libraryView: 'grid',
  sort: 'title',
  showSidebar: true,
  showDetail: true,
  sidebarWidth: 200,
  detailWidth: 300,
  fontScale: 1,
  // 竖排默认开：这是日文小说的常态（Fushi 的 ReaderSettings.writingMode 默认
  // 'vertical-rl'，见 docs/analysis/02 §5.7），横向书也能一键 'v' 切回来。
  vertical: true,
  fontFamily: '',
  lineHeight: 1.8,
  margin: 28,
  comicFit: 'height',
  comicSpread: false,
  comicSpreadOffset: 0,
};

const STORAGE_KEY = 'aralebook.settings.v1';

/** 按书覆盖的部分。 */
const BOOK_STORAGE_KEY = 'aralebook.book-settings.v1';

/**
 * 阅读时**按书**可以覆盖的字段。
 *
 * 为什么要有这一层：设置里的值是**默认值**——「新开一本书应该长什么样」。但同一本书
 * 每次打开都得是上次调好的样子（这本是竖排、那本要双页、第三本用另一个 OCR 引擎），
 * 而且调它**不该改掉默认值**。所以阅读器里改的写进这里，设置页改的写 `settings`。
 *
 * 刻意不含 theme / 侧栏宽度 / 排序这类「应用级」偏好：它们跨书共享才对。
 */
export type BookSettingsKey =
  | 'comicFit'
  | 'comicSpread'
  | 'comicSpreadOffset'
  | 'fontScale'
  | 'vertical'
  | 'fontFamily'
  | 'lineHeight'
  | 'margin'
  | 'ocrProvider';

export type BookSettingsPatch = Partial<Pick<AppSettings, Exclude<BookSettingsKey, 'ocrProvider'>>> & {
  ocrProvider?: OcrProviderId;
};

type BookSettingsMap = Record<string, BookSettingsPatch>;

function readBookSettings(): BookSettingsMap {
  try {
    const raw = window.localStorage.getItem(BOOK_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: BookSettingsMap = {};
    for (const [bookId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'object' && value !== null) out[bookId] = value as BookSettingsPatch;
    }
    return out;
  } catch {
    return {};
  }
}

let bookSnapshot: BookSettingsMap | null = null;

function getBookSettings(): BookSettingsMap {
  if (!bookSnapshot) bookSnapshot = readBookSettings();
  return bookSnapshot;
}

/** 写某本书的覆盖值（阅读器里调设置走这里）。 */
export function patchBookSettings(bookId: string, patch: BookSettingsPatch): void {
  const map = getBookSettings();
  bookSnapshot = { ...map, [bookId]: { ...map[bookId], ...patch } };
  try {
    window.localStorage.setItem(BOOK_STORAGE_KEY, JSON.stringify(bookSnapshot));
  } catch {
    /* 写不进去不影响当前会话 */
  }
  for (const listener of listeners) listener();
}

/** 清掉某本书的覆盖值（回到「设置里的默认」）。 */
export function resetBookSettings(bookId: string): void {
  const map = { ...getBookSettings() };
  delete map[bookId];
  bookSnapshot = map;
  try {
    window.localStorage.setItem(BOOK_STORAGE_KEY, JSON.stringify(bookSnapshot));
  } catch {
    /* 同上 */
  }
  for (const listener of listeners) listener();
}

const SORTS: readonly LibrarySort[] = [
  'title',
  'titleDesc',
  'author',
  'added',
  'addedDesc',
  'lastOpened',
  'series',
];

function num(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 反序列化时逐字段校验并夹紧。
 * 为什么值得写：localStorage 里的东西可能来自旧版本、手改、或者干脆是别的应用写的；
 * 一个 `sidebarWidth: "abc"` 就能让整个布局 NaN 化。
 */
function sanitize(raw: unknown): AppSettings {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    theme: oneOf(source['theme'], ['system', 'light', 'dark'] as const, d.theme),
    autoHideChrome: bool(source['autoHideChrome'], d.autoHideChrome),
    libraryView: oneOf(source['libraryView'], ['grid', 'list'] as const, d.libraryView),
    sort: oneOf(source['sort'], SORTS, d.sort),
    showSidebar: bool(source['showSidebar'], d.showSidebar),
    showDetail: bool(source['showDetail'], d.showDetail),
    sidebarWidth: num(source['sidebarWidth'], d.sidebarWidth, 120, 520),
    detailWidth: num(source['detailWidth'], d.detailWidth, 200, 640),
    fontScale: num(source['fontScale'], d.fontScale, 0.5, 3),
    vertical: bool(source['vertical'], d.vertical),
    fontFamily: typeof source['fontFamily'] === 'string' ? source['fontFamily'] : d.fontFamily,
    lineHeight: num(source['lineHeight'], d.lineHeight, 1, 3),
    margin: num(source['margin'], d.margin, 0, 160),
    comicFit: oneOf(source['comicFit'], ['width', 'height', 'actual'] as const, d.comicFit),
    comicSpread: bool(source['comicSpread'], d.comicSpread),
    // 走 clampSpreadOffset 而不是自己写一遍：偏移量的合法范围定义在 core 里，
    // 这里再写一份 `0..4` 就有两个真相源了。
    comicSpreadOffset: clampSpreadOffset(source['comicSpreadOffset']),
  };
}

let snapshot: AppSettings | null = null;
const listeners = new Set<() => void>();

function readFromStorage(): AppSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return sanitize(JSON.parse(raw) as unknown);
  } catch {
    // file:// 或隐私模式下 localStorage 可能直接抛，退回默认值而不是白屏。
    return { ...DEFAULT_SETTINGS };
  }
}

/** 稳定快照（useSyncExternalStore 要求 getSnapshot 返回同一引用直到真的变了）。 */
export function getSettings(): AppSettings {
  if (!snapshot) snapshot = readFromStorage();
  return snapshot;
}

export function updateSettings(patch: Partial<AppSettings>): void {
  snapshot = { ...getSettings(), ...patch };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // 写不进去也不影响当前会话的使用。
  }
  for (const listener of listeners) listener();
}

export function resetSettings(): void {
  snapshot = { ...DEFAULT_SETTINGS };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* 同上 */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSettings(): AppSettings {
  return useSyncExternalStore(subscribe, getSettings, getSettings);
}

/**
 * 阅读器用的设置：**默认值 + 本书覆盖**。
 *
 * 返回的对象形状与 `AppSettings` 完全一致，所以阅读器里的 `settings.comicFit` 这类
 * 读取一行都不用改；只有**写入**要区分：改本书用 `patch`，改默认去设置页。
 */
export function useBookSettings(bookId: string): {
  settings: AppSettings;
  overrides: BookSettingsPatch;
  patch: (next: BookSettingsPatch) => void;
  reset: () => void;
} {
  const global = useSettings();
  const map = useSyncExternalStore(subscribe, getBookSettings, getBookSettings);
  const overrides = map[bookId] ?? EMPTY_OVERRIDES;
  // 合并出一个新的 AppSettings 对象：阅读器里 `settings.comicFit` 这类读取一行都不用改。
  // 每次渲染都是新对象，所以**不要**把它放进任何 effect 的依赖数组里。
  const settings = { ...global, ...overrides } as AppSettings;
  // patch/reset 必须 memo：它们是新函数的话，阅读器的键盘监听 effect 每次渲染都会
  // 解绑重绑（`[patchBook]` 依赖），白白丢掉一次事件的风险也更大。
  const patch = useCallback((next: BookSettingsPatch) => patchBookSettings(bookId, next), [bookId]);
  const reset = useCallback(() => resetBookSettings(bookId), [bookId]);
  return { settings, overrides, patch, reset };
}

/** 稳定引用：`useSyncExternalStore` 的快照必须是稳定值，每次 `{}` 会无限重渲染。 */
const EMPTY_OVERRIDES: BookSettingsPatch = {};

/**
 * 把主题写到 `<html data-theme>` 上。
 * 即便是 'system' 也解析成 light/dark 再写属性，这样 CSS 只需要一套 `[data-theme=...]`
 * 规则；同时保留 `@media (prefers-color-scheme: dark)` 作为 JS 缺失时的兜底。
 */
export function useApplyTheme(theme: ThemeMode): void {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      document.documentElement.setAttribute('data-theme', resolved);
      document.documentElement.style.colorScheme = resolved;
    };
    apply();
    if (theme !== 'system') return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
}

/**
 * 组装冻结协议里的 `ReaderAppearance`。
 *
 * ⚠️ 桥接协议 v1（shared/reader-bridge.ts 的 `HostToBridge`）只定义了 `fontScale` 与
 * `mode` 两条消息，所以 `fontFamily`/`lineHeight`/`margin` 目前**传不进 iframe** ——
 * 章节 HTML 的阅读样式由 `arale://` 协议处理器在服务端注入。这里仍然把它们算进
 * `ReaderAppearance`，一是让默认值有一个明确归属，二是主进程哪天扩展注入时不用改渲染层。
 */
export function readerAppearance(settings: AppSettings): ReaderAppearance {
  return {
    fontScale: settings.fontScale,
    vertical: settings.vertical,
    fontFamily: settings.fontFamily,
    lineHeight: settings.lineHeight,
    margin: settings.margin,
  };
}

export const FONT_SCALE_MIN = 0.5;
export const FONT_SCALE_MAX = 3;

export function clampFontScale(value: number): number {
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(value * 100) / 100));
}
