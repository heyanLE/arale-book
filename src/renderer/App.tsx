/**
 * 顶层组件：持有「视图 / 书库信息 / 选择 / 查询 / 主题」五样全局状态，其余全部向下传。
 *
 * 为什么把状态提到这一层：主进程菜单命令（`shell:command`）与文件拖放
 * （`shell:openFiles`）都从窗口级事件进来，必须有一个比视图更长寿的地方接住它们；
 * 同时阅读器与书库视图会来回切换，选中项与查询条件要在切回来时原样保留（Calibre 的
 * 手感就是这样：进阅读器再出来，列表还停在原处）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExtensionProgress, ExtensionStatus } from '@shared/extensions';
import type { LlmSettings } from '@shared/types';
import type { AppDefaults } from '@shared/defaults';
import { DEFAULT_APP_DEFAULTS } from '@shared/defaults';
import type {
  BookSegments,
  LibraryInfo,
  LibraryQuery,
  OcrCapability,
  OcrJobResult,
  OcrProgress,
  OcrProviderId,
  OcrQueueState,
  OpenBookResult,
  SegmentJobResult,
  SegmentProgress,
} from '@shared/types';
import {
  api,
  call,
  notifyMain,
  subscribeApiErrors,
  summarizeImportOutcome,
  useAsync,
  useIpcEvent,
  useShellCommand,
} from './lib/api';
import { updateSettings, useApplyTheme, useSettings } from './lib/reader-settings';
import { Toolbar } from './components/Toolbar';
import { StatusBar } from './components/StatusBar';
import { OcrQueueDock } from './components/OcrQueueDock';
import { SettingsPanel } from './components/SettingsPanel';
import { LibraryView } from './views/LibraryView';
import { ReaderView } from './views/ReaderView';
import { SegmentView } from './views/SegmentView';

export type ViewName = 'library' | 'reader' | 'settings' | 'segments';

/**
 * 沉浸模式下**按了也不弹工具栏**的键。
 *
 * 只改变阅读位置（翻页 / 跳转）或只关掉浮层的键，动作本身就有即时反馈——画面翻了、
 * 卡片关了。工具栏跟着一起冒出来纯属打扰：用户报的正是「沉浸模式下按 ← / → 翻页，
 * 工具栏每翻一页闪一次」。而翻页恰恰是阅读器里按得最多的键，所以这个「露一下」的
 * 待遇只能留给真正会改状态的命令键（缩放、竖排、双页、字号…）。
 *
 * `Space` 与 `Spacebar` 都要列：不同环境给的名字不一样。
 */
const QUIET_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
  'Spacebar',
  'Escape',
]);

export function App(): JSX.Element {
  const settings = useSettings();
  useApplyTheme(settings.theme);

  const [view, setView] = useState<ViewName>('library');
  const [reloadToken, setReloadToken] = useState(0);
  const [query, setQuery] = useState<LibraryQuery>(() => ({ sort: settings.sort }));
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [open, setOpen] = useState<OpenBookResult | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [status, setStatus] = useState('就绪');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState({ shown: 0, total: 0 });

  /**
   * OCR 状态。
   *
   * 为什么放在 App 而不是 ComicReader：OCR 是**跨视图**的长任务——用户完全可以开着
   * 识别回到书架去干别的，进度必须还在。任务本身在主进程跑，这里只缓存进度快照。
   */
  const [ocrProgress, setOcrProgress] = useState<Record<string, OcrProgress>>({});
  const [ocrResult, setOcrResult] = useState<Record<string, OcrJobResult>>({});
  const [ocrCapability, setOcrCapability] = useState<OcrCapability | null>(null);
  /**
   * 全局识别队列快照。
   *
   * 只靠 `ocr:queue` 事件不够：渲染进程可能在中途重载（改完样式刷新、崩溃恢复），
   * 而队列是**主进程**的状态，跨渲染进程存活。所以挂载时先主动拉一次快照。
   */
  const [ocrQueue, setOcrQueue] = useState<OcrQueueState | null>(null);

  /**
   * 扩展状态。
   *
   * `progress` 按扩展 id 存：同一时刻只会有一个在装（服务层保证），但按 id 存让
   * 「哪一条在装」不必再同步一次——那是上一版把进度条留在界面上的原因。
   */
  const [extensions, setExtensions] = useState<{
    statuses: ExtensionStatus[];
    source: 'cache' | 'bundled' | 'none';
    error: string | null;
  }>({ statuses: [], source: 'none', error: null });
  const [extensionProgress, setExtensionProgress] = useState<Record<string, ExtensionProgress>>({});
  const [extensionsLoading, setExtensionsLoading] = useState(false);

  /** LLM 配置（含 API key 的存在性，不含 key 本身）。 */
  const [llmSettings, setLlmSettings] = useState<LlmSettings | null>(null);
  const [llmLoading, setLlmLoading] = useState(false);
  /** 主进程侧默认值（新书阅读方向）。 */
  const [appDefaults, setAppDefaults] = useState<AppDefaults>(DEFAULT_APP_DEFAULTS);

  /**
   * 沉浸模式：鼠标停在上/下哪条边缘带上。
   *
   * 只在阅读器里生效——书库里工具栏是导航（切视图、导入、搜索），藏起来就没法用了。
   *
   * 两个刻意的决定：
   * 1. **按边缘带触发，不按"鼠标一动就显形"**。后者的结果是一边拖动画布一边工具栏
   *    在眼前反复闪，比一直显示还烦。现在只有指针进到上下各 72px 的带子里才出现，
   *    离开就收 —— 和视频播放器一致，用户想点工具栏时自然会把鼠标挪到边上。
   * 2. **工具栏是浮层，不占布局**。所以阅读区在沉浸模式下是**满窗**的，而且是恒定的：
   *    显示/隐藏工具栏不会让画面跳一下（这一点比"藏起来"重要得多）。
   */
  const EDGE_ZONE_PX = 72;
  const [chromeZone, setChromeZone] = useState<'none' | 'top' | 'bottom'>('none');
  const immersiveActive = settings.autoHideChrome && view === 'reader';

  useEffect(() => {
    if (!immersiveActive) {
      setChromeZone('none');
      return;
    }
    const onMove = (event: MouseEvent) => {
      const zone =
        event.clientY <= EDGE_ZONE_PX
          ? 'top'
          : event.clientY >= window.innerHeight - EDGE_ZONE_PX
            ? 'bottom'
            : 'none';
      // 只在跨带时 setState：mousemove 一次拖动能触发几百次，无条件 setState 会让
      // 整个应用跟着重渲染。
      setChromeZone((current) => (current === zone ? current : zone));
    };
    // 键盘操作时把上边那条露出来（纯键盘用户不该摸黑按快捷键）。
    // **翻页键与关闭键除外**（`QUIET_KEYS`）：翻页本身就在眼前发生，工具栏跟着每翻
    // 一页闪一次才是真打扰。
    const onKey = (event: KeyboardEvent) => {
      if (QUIET_KEYS.has(event.key)) return;
      setChromeZone((current) => (current === 'none' ? 'top' : current));
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('keydown', onKey);
    };
  }, [immersiveActive]);

  const showTop = !immersiveActive || chromeZone === 'top';
  const showBottom = !immersiveActive || chromeZone === 'bottom';

  /**
   * 分词状态。
   *
   * `segmentData` 只在分词视图被打开时按需读盘——一本书的词表可能几万个词，
   * 没必要在书架加载时就全读进来。
   */
  const [segmentBookId, setSegmentBookId] = useState<string | null>(null);
  const [segmentBookTitle, setSegmentBookTitle] = useState('');
  const [segmentStatus, setSegmentStatus] = useState<Record<string, SegmentJobResult>>({});
  const [segmentProgress, setSegmentProgress] = useState<Record<string, SegmentProgress>>({});
  const [segmentData, setSegmentData] = useState<BookSegments | null>(null);
  const [segmentLoading, setSegmentLoading] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);

  // ------------------------------------------------------------------
  // 书库信息 / 全局事件
  // ------------------------------------------------------------------

  const info = useAsync<LibraryInfo>(() => api.library.info(), [reloadToken]);

  const bumpLibrary = useCallback(() => setReloadToken((t) => t + 1), []);

  useEffect(() => subscribeApiErrors(setBanner), []);

  useIpcEvent('library:changed', (payload) => {
    bumpLibrary();
    setStatus(payload?.reason === 'remove' ? '已从书库移除' : '书库已更新');
  });

  useIpcEvent('dict:changed', (dict) => {
    setStatus(`词典索引已载入：${dict.dictionaries.length} 部 / ${dict.termCount} 条`);
  });

  useIpcEvent('ocr:progress', (progress) => {
    // 同一本书只留最新一帧。OCR 每页发一次事件，200 页的卷会有 200 次事件——
    // 覆盖式更新，map 不会无限长大。
    setOcrProgress((prev) => ({ ...prev, [progress.bookId]: progress }));
  });

  useIpcEvent('ocr:queue', (state) => {
    setOcrQueue(state);
  });

  useIpcEvent('ocr:done', (result) => {
    setOcrResult((prev) => ({ ...prev, [result.bookId]: result }));
    setOcrProgress((prev) => {
      const next = { ...prev };
      delete next[result.bookId];
      return next;
    });
    setStatus(
      result.ok
        ? result.skipped
          ? '这本已经有文字层了'
          : `文字识别完成：${result.pages} 页 / ${result.blocks} 个文字块`
        : `文字识别失败：${result.error ?? '未知原因'}`,
    );
  });

  const reloadSegments = useCallback(async (bookId: string) => {
    setSegmentLoading(true);
    const data = await call('读取分词结果', () => api.segment.read(bookId));
    setSegmentLoading(false);
    setSegmentData(data);
  }, []);

  useIpcEvent('segment:progress', (progress) => {
    setSegmentProgress((prev) => ({ ...prev, [progress.bookId]: progress }));
  });

  useIpcEvent('segment:done', (result) => {
    setSegmentStatus((prev) => ({ ...prev, [result.bookId]: result }));
    setSegmentProgress((prev) => {
      const next = { ...prev };
      delete next[result.bookId];
      return next;
    });
    setStatus(
      result.ok
        ? `分词完成：${result.uniqueWords} 个词 / ${result.tokens} 次出现`
        : `分词失败：${result.error ?? '未知原因'}`,
    );
    // 跑完自动把新结果读进来（用户此刻多半正看着分词视图）。
    setSegmentBookId((current) => {
      if (current === result.bookId && result.ok) void reloadSegments(result.bookId);
      return current;
    });
  });

  const openSegments = useCallback(
    async (bookId: string, title: string) => {
      setSegmentBookId(bookId);
      setSegmentBookTitle(title);
      setView('segments');
      setSegmentData(null);
      await reloadSegments(bookId);
    },
    [reloadSegments],
  );

  const startSegment = useCallback(
    async (force: boolean) => {
      if (!segmentBookId) return;
      const outcome = await call('生成分词', () => api.segment.start(segmentBookId, { force }));
      if (!outcome) return;
      setSegmentStatus((prev) => ({ ...prev, [outcome.bookId]: outcome }));
      if (outcome.error) setStatus(`分词：${outcome.error}`);
      else setStatus('开始分词…');
    },
    [segmentBookId],
  );

  const clearSegment = useCallback(async () => {
    if (!segmentBookId) return;
    await call('删除分词', () => api.segment.clear(segmentBookId));
    setSegmentData(null);
    setStatus('已删除分词结果');
  }, [segmentBookId]);

  const loadOcrCapability = useCallback(async () => {
    const capability = await call('探测 OCR 引擎', () => api.ocr.capability());
    if (capability) setOcrCapability(capability);
  }, []);

  // 启动时探一次，设置页/阅读器就不必各自再探。
  useEffect(() => {
    void loadOcrCapability();
  }, [loadOcrCapability]);

  // 队列表现在主进程，渲染进程重载后要主动要一次（见 ocrQueue 的注释）。
  useEffect(() => {
    void api.ocr.queue().then(setOcrQueue).catch(() => undefined);
  }, []);

  const loadExtensions = useCallback(async () => {
    setExtensionsLoading(true);
    const result = await call('读取扩展清单', () => api.extensions.list());
    setExtensionsLoading(false);
    if (result) setExtensions({ statuses: result.statuses, source: result.source, error: result.error });
  }, []);

  useEffect(() => {
    void loadExtensions();
  }, [loadExtensions]);

  useIpcEvent('extensions:progress', (progress) => {
    setExtensionProgress((prev) => ({ ...prev, [progress.id]: progress }));
  });

  // 装完/卸完要**重新探测 OCR 引擎**：扩展的存在与否直接决定 arale_onnx_v1 可不可用。
  useIpcEvent('extensions:changed', () => {
    void loadExtensions();
    void loadOcrCapability();
  });

  useEffect(() => {
    void api.defaults
      .read()
      .then(setAppDefaults)
      .catch(() => undefined);
  }, []);

  const writeDefaults = useCallback(async (patch: Partial<AppDefaults>) => {
    const next = await call('保存默认值', () => api.defaults.write(patch));
    if (next) setAppDefaults(next);
  }, []);

  const loadLlm = useCallback(async () => {
    setLlmLoading(true);
    const result = await call('读取 LLM 配置', () => api.llm.settings());
    setLlmLoading(false);
    if (result) setLlmSettings(result);
  }, []);

  useEffect(() => {
    void loadLlm();
  }, [loadLlm]);

  const updateLlm = useCallback(
    async (patch: Parameters<typeof api.llm.update>[0]) => {
      const next = await call('保存 LLM 配置', () => api.llm.update(patch));
      if (next) setLlmSettings(next);
    },
    [],
  );

  const setLlmApiKey = useCallback(async (profileId: string, apiKey: string | null) => {
    const next = await call('保存 API key', () => api.llm.setApiKey(profileId, apiKey));
    if (next) {
      setLlmSettings(next);
      setStatus(apiKey === null ? '已清除 API key' : 'API key 已保存');
    }
  }, []);

  const refreshExtensions = useCallback(async () => {
    setExtensionsLoading(true);
    const result = await call('刷新扩展清单', () => api.extensions.refresh());
    setExtensionsLoading(false);
    if (result) {
      setStatus(
        result.ok
          ? `扩展清单已更新：${result.count} 个`
          : `扩展清单没更新（用本地缓存）：${result.error ?? '未知原因'}`,
      );
    }
    await loadExtensions();
  }, [loadExtensions]);

  const installExtension = useCallback(
    async (id: string) => {
      setStatus(`正在安装扩展 ${id}…`);
      const result = await call('安装扩展', () => api.extensions.install(id));
      // 失败的详情已经在进度事件里给过（含 HTTP 状态与 sha256 对比），
      // 这里只补一句收尾。
      if (result && !result.ok) setStatus(`扩展安装失败：${result.error ?? '未知原因'}`);
      else if (result) setStatus('扩展安装完成');
      await loadExtensions();
    },
    [loadExtensions],
  );

  const cancelExtension = useCallback((id: string) => {
    void call('取消安装扩展', () => api.extensions.cancel(id));
  }, []);

  const removeExtension = useCallback(
    async (id: string) => {
      const result = await call('卸载扩展', () => api.extensions.remove(id));
      setStatus(result?.ok ? '扩展已卸载' : `卸载失败：${result?.error ?? '未知原因'}`);
      await loadExtensions();
    },
    [loadExtensions],
  );

  const selectOcrProvider = useCallback(async (provider: OcrProviderId) => {
    const next = await call('切换 OCR 引擎', () => api.ocr.selectProvider(provider));
    if (next) setOcrCapability(next);
  }, []);

  const startOcr = useCallback(async (bookId: string, force = false, provider?: OcrProviderId) => {
    const outcome = await call('文字识别', () => api.ocr.start(bookId, { force, provider }));
    if (!outcome) return;
    if (outcome.skipped) setStatus('这本已经有文字层了');
    else if (outcome.error) setStatus(`文字识别：${outcome.error}`);
    else if (outcome.queued && (outcome.queuePosition ?? 1) > 1) {
      // 队列里已经有活 → 明确告诉用户排在第几位，否则「点了没反应」很像卡住了。
      setStatus(`已加入识别队列：第 ${outcome.queuePosition} 位`);
    } else setStatus('开始识别文字…');
  }, []);

  const cancelOcr = useCallback((bookId: string) => {
    void call('取消识别', () => api.ocr.cancel(bookId));
  }, []);

  // ------------------------------------------------------------------
  // 操作
  // ------------------------------------------------------------------

  const importViaDialog = useCallback(async () => {
    setBusy(true);
    const outcomes = await call('导入', () => api.library.importViaDialog());
    setBusy(false);
    if (!outcomes) return;
    setStatus(summarizeImportOutcome(outcomes));
    if (outcomes.some((o) => o.ok)) bumpLibrary();
  }, [bumpLibrary]);

  const openBook = useCallback(async (bookId: string) => {
    setBusy(true);
    const result = await call('打开书籍', () => api.library.open(bookId));
    setBusy(false);
    if (!result) return;
    setOpen(result);
    setView('reader');
    setStatus(`正在阅读《${result.book.title}》`);
    notifyMain('reader:opened', { bookId });
  }, []);

  const leaveReader = useCallback(() => {
    setOpen(null);
    setView('library');
    notifyMain('reader:closed');
    // 阅读会刷新 lastOpenedAt / 进度，回列表要重新拉。
    bumpLibrary();
  }, [bumpLibrary]);

  const openSettings = useCallback(() => setView('settings'), []);

  const cycleTheme = useCallback(() => {
    const next = settings.theme === 'system' ? 'light' : settings.theme === 'light' ? 'dark' : 'system';
    updateSettings({ theme: next });
  }, [settings.theme]);

  const setViewMode = useCallback((mode: 'grid' | 'list') => {
    updateSettings({ libraryView: mode });
  }, []);

  const patchQuery = useCallback((patch: Partial<LibraryQuery>) => {
    setQuery((prev) => ({ ...prev, ...patch }));
  }, []);

  // ------------------------------------------------------------------
  // 主进程菜单命令
  // ------------------------------------------------------------------

  useShellCommand((command) => {
    switch (command) {
      case 'import':
        void importViaDialog();
        break;
      case 'settings':
        openSettings();
        break;
      case 'toggleSidebar':
        updateSettings({ showSidebar: !settings.showSidebar });
        break;
      case 'nextPage':
      case 'prevPage':
      case 'zoomIn':
      case 'zoomOut':
      case 'zoomReset':
        // 翻页/缩放是「当前这本书」的事，由 EpubReader / ComicReader 自己订阅处理
        // （它们才知道自己是章节制还是页码制）。App 在这里刻意不插手。
        break;
      case 'toggleDictionary':
        setStatus('词典管理在「设置」里：右键菜单 → 设置，或点工具栏的齿轮。');
        break;
      default:
        break;
    }
  });

  // ------------------------------------------------------------------
  // 全局快捷键（列表内的方向键导航在 BookGrid 里）
  // ------------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === 'f') {
        // Cmd/Ctrl+F 只该在书库视图抢焦点；在阅读器里留给书内搜索的未来实现。
        if (view !== 'library') return;
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (mod && event.key === ',') {
        event.preventDefault();
        openSettings();
      } else if (event.key === 'Escape') {
        if (view === 'settings') {
          event.preventDefault();
          setView('library');
        } else if (view === 'reader') {
          // 词典弹窗在**捕获阶段**处理 Esc 并 stopPropagation，所以走到这里说明
          // 没有弹窗——退到书库才是此时用户的意思。
          event.preventDefault();
          leaveReader();
        } else if (view === 'library' && settings.showDetail && selectedIds.length === 0) {
          // Esc 的两段语义：先清空选择（在 BookGrid 里处理），没有选择可清时才收起详情面板，
          // 这样「Esc 关详情」不会顺手把用户的选择也吃掉。
          event.preventDefault();
          updateSettings({ showDetail: false });
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [view, openSettings, leaveReader, settings.showDetail, selectedIds.length]);

  // ------------------------------------------------------------------

  /** 引擎 id → 显示名。队列弹层要显示「用什么引擎跑的」。 */
  const providerLabel = useCallback(
    (id: OcrProviderId): string =>
      ocrCapability?.providers.find((item) => item.id === id)?.label ?? id,
    [ocrCapability],
  );

  const counts = useMemo(
    () => ({
      shown: shown.shown,
      total: shown.total,
      selected: selectedIds.length,
    }),
    [shown, selectedIds.length],
  );

  return (
    <div
      className={[
        'app',
        immersiveActive ? 'is-immersive' : '',
        showTop ? 'chrome-top' : '',
        showBottom ? 'chrome-bottom' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {banner !== null && (
        <div className="error-banner" role="alert">
          <span className="error-banner-icon" aria-hidden="true">
            !
          </span>
          <span className="error-banner-msg">{banner}</span>
          <button
            type="button"
            className="error-banner-close"
            onClick={() => setBanner(null)}
            title="关闭"
          >
            ×
          </button>
        </div>
      )}

      <Toolbar
        view={view}
        bookTitle={open?.book.title ?? null}
        libraryDir={info.data?.dir ?? null}
        viewMode={settings.libraryView}
        onViewMode={setViewMode}
        showSidebar={settings.showSidebar}
        onToggleSidebar={() => updateSettings({ showSidebar: !settings.showSidebar })}
        showDetail={settings.showDetail}
        onToggleDetail={() => updateSettings({ showDetail: !settings.showDetail })}
        busy={busy}
        theme={settings.theme}
        onCycleTheme={cycleTheme}
        onImport={() => void importViaDialog()}
        onOpenSettings={openSettings}
        onLeaveReader={leaveReader}
      />

      <div className="app-main">
        {view === 'library' && (
          <LibraryView
            query={query}
            onQueryChange={patchQuery}
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
            reloadToken={reloadToken}
            onOpenBook={(id) => void openBook(id)}
            onLibraryChanged={bumpLibrary}
            onStatus={setStatus}
            onStats={setShown}
            searchRef={searchRef}
            info={info.data}
          />
        )}

        {view === 'reader' &&
          (open ? (
            <ReaderView
              open={open}
              onBack={leaveReader}
              onStatus={setStatus}
              ocrProgress={ocrProgress[open.book.id] ?? null}
              ocrResult={ocrResult[open.book.id] ?? null}
              onStartOcr={startOcr}
              onCancelOcr={cancelOcr}
              ocrCapability={ocrCapability}
              ocrQueue={ocrQueue}
              onOpenSegments={(bookId) =>
                void openSegments(bookId, open.book.title)
              }
            />
          ) : (
            <div className="placeholder">未打开任何书籍。</div>
          ))}

        {view === 'settings' && (
          <SettingsPanel
            info={info.data}
            onClose={() => setView('library')}
            onStatus={setStatus}
            ocrCapability={ocrCapability}
            onRefreshOcrCapability={() => void loadOcrCapability()}
            onSelectOcrProvider={(provider) => void selectOcrProvider(provider)}
            defaults={{ value: appDefaults, onChange: (patch) => void writeDefaults(patch) }}
            llm={{
              settings: llmSettings,
              loading: llmLoading,
              onReload: () => void loadLlm(),
              onUpdate: (patch) => void updateLlm(patch),
              onSetApiKey: (profileId, apiKey) => void setLlmApiKey(profileId, apiKey),
            }}
            extensions={{
              statuses: extensions.statuses,
              source: extensions.source,
              error: extensions.error,
              progress: extensionProgress,
              loading: extensionsLoading,
              onRefresh: () => void refreshExtensions(),
              onInstall: (id) => void installExtension(id),
              onCancel: cancelExtension,
              onRemove: (id) => void removeExtension(id),
            }}
          />
        )}

        {view === 'segments' && segmentBookId !== null && (
          <SegmentView
            bookId={segmentBookId}
            bookTitle={segmentBookTitle}
            status={segmentStatus[segmentBookId] ?? null}
            progress={segmentProgress[segmentBookId] ?? null}
            segments={segmentData}
            loading={segmentLoading}
            onBack={() => {
              setView(open !== null ? 'reader' : 'library');
              setSegmentBookId(null);
              setSegmentData(null);
            }}
            onGenerate={(force) => void startSegment(force)}
            onClear={() => void clearSegment()}
            onReload={() => void reloadSegments(segmentBookId)}
          />
        )}
      </div>

      <StatusBar
        info={info.data}
        shown={counts.shown}
        total={counts.total}
        selectionCount={counts.selected}
        ocrSlot={
          <OcrQueueDock
            queue={ocrQueue}
            progress={ocrProgress}
            providerLabel={providerLabel}
            onCancel={cancelOcr}
            onOpenBook={(bookId) => void openBook(bookId)}
          />
        }
        statusMessage={status}
        busy={busy || info.loading}
        theme={settings.theme}
        readerLabel={view === 'reader' ? (open?.book.title ?? null) : null}
      />
    </div>
  );
}
