/**
 * IPC 通道名与预加载脚本暴露给渲染进程的 API 形状（冻结文件）。
 *
 * 渲染进程**不允许**碰 Node/Electron 原生模块（`contextIsolation: true` +
 * `nodeIntegration: false` + `sandbox: true`）。它只能 `window.arale.*` 这一组方法。
 */

import type {
  BookFormat,
  BookRecord,
  BookSegments,
  ChapterContent,
  DictionaryStatus,
  ImportOutcome,
  LibraryInfo,
  LibraryPage,
  LibraryQuery,
  LookupResult,
  OcrCapability,
  OcrJobResult,
  OcrProgress,
  OcrProviderId,
  OcrQueueState,
  LlmAnalyzeRequest,
  LlmAnalyzeResult,
  LlmSettings,
  SegmentJobResult,
  SegmentProgress,
  WordCard,
  WordCardDraft,
  OpenBookResult,
  PageText,
  ReadingPosition,
  SegmentToken,
} from './types';
import type { ExtensionProgress, ExtensionStatus, OcrRepository } from './extensions';
import type { AppDefaults } from './defaults';

/** 所有 invoke 通道名。渲染进程与主进程都从这里取，禁止写字面量。 */
export const IPC = {
  libraryInfo: 'library:info',
  libraryList: 'library:list',
  /** 导入用户拖进来/命令行给出的具体路径。 */
  libraryImport: 'library:import',
  /** 弹系统「选文件 / 选文件夹」对话框再导入。 */
  libraryImportDialog: 'library:importDialog',
  libraryRemove: 'library:remove',
  libraryOpen: 'library:open',
  librarySavePosition: 'library:savePosition',
  libraryUpdateMeta: 'library:updateMeta',
  libraryReveal: 'library:reveal',

  chapterContent: 'book:chapter',
  comicPageText: 'comic:pageText',

  dictStatus: 'dict:status',
  dictImport: 'dict:import',
  dictImportDialog: 'dict:importDialog',
  dictRemove: 'dict:remove',
  dictSetEnabled: 'dict:setEnabled',
  dictLookup: 'dict:lookup',
  dictSegment: 'dict:segment',

  defaultsRead: 'defaults:read',
  defaultsWrite: 'defaults:write',

  cardsList: 'cards:list',
  cardsAdd: 'cards:add',
  cardsUpdate: 'cards:update',
  cardsRemove: 'cards:remove',

  llmSettings: 'llm:settings',
  llmUpdate: 'llm:update',
  llmSetApiKey: 'llm:setApiKey',
  llmAnalyze: 'llm:analyze',

  ocrCapability: 'ocr:capability',
  ocrStatus: 'ocr:status',
  ocrStart: 'ocr:start',
  ocrCancel: 'ocr:cancel',
  /** 当前队列快照（正在跑 + 排队中）。 */
  ocrQueue: 'ocr:queue',
  /** 记住用户选的引擎（跨启动）。 */
  ocrSelectProvider: 'ocr:selectProvider',

  extensionsList: 'extensions:list',
  extensionsRefresh: 'extensions:refresh',
  extensionsInstall: 'extensions:install',
  extensionsCancel: 'extensions:cancel',
  extensionsRemove: 'extensions:remove',
  extensionsRepositoryAdd: 'extensions:repositoryAdd',
  extensionsRepositoryRemove: 'extensions:repositoryRemove',

  segmentStatus: 'segment:status',
  segmentStart: 'segment:start',
  segmentCancel: 'segment:cancel',
  /** 读已生成的分词结果（没生成过返回 null）。 */
  segmentRead: 'segment:read',
  /** 删掉分词结果（重新生成前也可以先删）。 */
  segmentClear: 'segment:clear',
} as const;

/** 预加载脚本挂到 `window.arale` 上的完整 API。 */
export interface AraleApi {
  library: {
    info(): Promise<LibraryInfo>;
    list(query: LibraryQuery): Promise<LibraryPage>;
    /** `paths` 可以是文件也可以是目录。 */
    importPaths(paths: string[]): Promise<ImportOutcome[]>;
    /** 弹对话框，取消返回 `[]`。 */
    importViaDialog(): Promise<ImportOutcome[]>;
    remove(bookIds: string[]): Promise<void>;
    open(bookId: string): Promise<OpenBookResult>;
    savePosition(position: ReadingPosition): Promise<void>;
    updateMeta(
      bookId: string,
      patch: Partial<Pick<BookRecord, 'title' | 'author' | 'series' | 'volume' | 'tags' | 'direction'>>,
    ): Promise<BookRecord>;
    reveal(bookId: string): Promise<void>;
  };
  book: {
    chapter(bookId: string, spineIndex: number): Promise<ChapterContent>;
    pageText(bookId: string, pageIndex: number): Promise<PageText>;
    /** `arale://` 下某个资源的可显示 URL。 */
    assetUrl(bookId: string, rel: string): string;
  };
  /**
   * 把一个拖放进来的 `File` 换成它的绝对路径。
   *
   * 为什么需要它：**Electron ≥32 移除了非标准属性 `File.path`**，而渲染进程在
   * `sandbox: true` 下又拿不到 `webUtils`。唯一能拿到真实路径的地方是预加载脚本，
   * 所以只能由它转一手——否则拖放导入会退化成「只知道文件名，不知道在哪」。
   */
  paths: {
    forFile(file: File): string;
  };
  dict: {
    status(): Promise<DictionaryStatus>;
    importPaths(zipPaths: string[]): Promise<DictionaryStatus>;
    importViaDialog(): Promise<DictionaryStatus | null>;
    remove(dictId: string): Promise<DictionaryStatus>;
    setEnabled(dictId: string, enabled: boolean): Promise<DictionaryStatus>;
    lookup(text: string, charOffset?: number): Promise<LookupResult>;
    segment(text: string): Promise<SegmentToken[]>;
  };
  /**
   * 订阅主进程推来的事件，返回一个**订阅号**（用完用 `off` 退订）。
   *
   * 为什么走 `contextBridge` 暴露函数 + 订阅号，而不是在预加载里
   * `window.dispatchEvent(new CustomEvent(...))`：
   * - `contextIsolation` 下预加载与页面是两个 JS 世界，`CustomEvent.detail` 里塞 JS
   *   对象时跨世界读取行为不稳定（有时拿到 null）；
   * - `contextBridge` **不支持**把函数当返回值传回主世界，所以不能返回退订闭包，
   *   只能用可克隆的数字订阅号。React 的 `useEffect` 清理依赖这个。
   */
  on<K extends keyof AraleEvents>(event: K, handler: (payload: AraleEvents[K]) => void): number;
  /** 退订。订阅号无效时静默忽略（组件卸载时序竞态下会走到）。 */
  off(subscriptionId: number): void;
  /** 渲染进程 → 主进程的单向通知（不等待结果）。 */
  notify(channel: 'renderer:ready' | 'reader:opened' | 'reader:closed', payload?: unknown): void;
  /**
   * 本地漫画 OCR。**完全可选**——不跑 OCR 时漫画就是纯图片，能看能翻，
   * 只是点不出词典。
   */
  ocr: {
    /** 各引擎的可用性与就绪状态。 */
    capability(): Promise<OcrCapability>;
    status(bookId: string): Promise<OcrJobResult | null>;
    /** 起一个后台 OCR 任务；已在跑则返回当前状态。 */
    start(
      bookId: string,
      options?: { force?: boolean; provider?: OcrProviderId },
    ): Promise<OcrJobResult>;
    cancel(bookId: string): Promise<void>;
    /**
     * 当前队列快照。识别是**串行**的：同一时刻只有一本在跑，其余排队。
     * 右下角的全局队列弹层靠这个 + `ocr:queue` 事件渲染。
     */
    queue(): Promise<OcrQueueState>;
    /** 记住默认引擎。 */
    selectProvider(provider: OcrProviderId): Promise<OcrCapability>;
  };
  /**
   * 主进程侧的**默认值**（新书的阅读方向等）。
   *
   * 与设置页其余部分分开是因为它们要在**导入时**用到，而导入在主进程里。
   */
  defaults: {
    read(): Promise<AppDefaults>;
    write(patch: Partial<AppDefaults>): Promise<AppDefaults>;
  };
  /**
   * **词卡**：用户保存下来的查询，存在 `<bookDir>/cards.json`。
   *
   * 按书分文件，不走书库索引：词卡是「这本书的阅读产物」，跟 `segments.json` 同类，
   * 而且一本书可能攒几千张，塞进 index.json 会让每次书库刷新都变慢。
   */
  cards: {
    list(bookId: string): Promise<WordCard[]>;
    add(bookId: string, draft: WordCardDraft): Promise<WordCard>;
    update(
      bookId: string,
      id: string,
      patch: Partial<Pick<WordCard, 'word' | 'note' | 'analyses'>>,
    ): Promise<WordCard | null>;
    remove(bookId: string, id: string): Promise<boolean>;
  };
  /**
   * **LLM**：chat completions 兼容的配置与分析。
   *
   * API key 只进不出——`llm.settings()` 永远不返回明文 key，只返回 `hasApiKey`。
   */
  llm: {
    settings(): Promise<LlmSettings>;
    update(patch: {
      profiles?: LlmSettings['profiles'];
      activeProfileId?: string | null;
      prompt?: string;
    }): Promise<LlmSettings>;
    /** 存/删某一套配置的 key（null 或空串 = 删除）。 */
    setApiKey(profileId: string, apiKey: string | null): Promise<LlmSettings>;
    /** 跑一次分析。失败也 resolve，看 `ok`。 */
    analyze(request: LlmAnalyzeRequest): Promise<LlmAnalyzeResult>;
  };
  /**
   * **扩展**：可下载安装的能力包。
   *
   * 装的是几百 MB 的东西（比如 OCR 引擎的运行时与模型），所以每一步都要能看见：
   * `list()` 给出「有什么、多大、装了没」，`install()` 走 `extensions:progress` 事件
   * 报进度，下载完**必须**校验 sha256 才落盘。
   */
  extensions: {
    list(): Promise<{ statuses: ExtensionStatus[]; repositories: OcrRepository[]; source: 'cache' | 'bundled' | 'none'; error: string | null }>;
    /** 从远端拉一份新清单（拉不到就用本地缓存，不抛）。 */
    refresh(): Promise<{ ok: boolean; count: number; error: string | null; source: 'remote' | 'cache' }>;
    install(id: string): Promise<{ ok: boolean; error: string | null }>;
    /** 取消正在进行的下载/安装。 */
    cancel(id: string): Promise<void>;
    remove(id: string): Promise<{ ok: boolean; error: string | null }>;
    addRepository(name: string, url: string): Promise<{ ok: boolean; error: string | null }>;
    removeRepository(url: string): Promise<{ ok: boolean; error: string | null }>;
  };
  /**
   * 分词。同样可选、也能反复重新生成——换词典、改文本层之后都值得重跑一次。
   */
  segment: {
    /** 这本书有没有分词结果、是什么时候、用哪本词典生成的。 */
    status(bookId: string): Promise<SegmentJobResult | null>;
    /** 读完整的分词结果（可能很大，所以按需取）。 */
    read(bookId: string): Promise<BookSegments | null>;
    /** 起一个后台分词任务。 */
    start(bookId: string, options?: { force?: boolean }): Promise<SegmentJobResult>;
    cancel(bookId: string): Promise<void>;
    /** 删掉分词结果。 */
    clear(bookId: string): Promise<void>;
  };
}

/** 主进程推给渲染进程的事件。 */
export interface AraleEvents {
  /** 导入进度 / 结果播报。 */
  'library:changed': { reason: 'import' | 'remove' | 'update' };
  /** 词典索引在后台载入完成。 */
  'dict:changed': DictionaryStatus;
  /** 拖放进入窗口的文件路径（渲染进程自己也有 HTML5 dnd，这个是兜底）。 */
  'shell:openFiles': { paths: string[] };
  /** 主进程菜单触发的命令。 */
  'shell:command': { command: ShellCommand };
  /** OCR 任务进度（每页一次，可能很频繁——UI 侧要节流渲染）。 */
  'ocr:progress': OcrProgress;
  /** OCR 任务结束（成功或失败）。 */
  'ocr:done': OcrJobResult;
  /** 队列发生变化（入队 / 出队开始跑 / 取消排队 / 跑完）。 */
  'ocr:queue': OcrQueueState;
  /** 扩展下载/安装进度。 */
  'extensions:progress': ExtensionProgress;
  /** 扩展安装/卸载完成，需要重新探测依赖它的引擎。 */
  'extensions:changed': Record<string, never>;
  /** 分词任务进度。 */
  'segment:progress': SegmentProgress;
  /** 分词任务结束。 */
  'segment:done': SegmentJobResult;
}

export type ShellCommand =
  | 'import'
  | 'settings'
  | 'toggleSidebar'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'nextPage'
  | 'prevPage'
  | 'toggleDictionary';

/** 主进程 → 渲染进程事件的唯一 IPC 通道。载荷形如 `{ channel, payload }`。 */
export const EVENT_CHANNEL = 'arale:event';

/** 渲染进程 → 主进程单向通知的通道。 */
export const NOTIFY_CHANNEL = 'arale:notify';

/**
 * 拼 `arale://` 资源 URL。
 *
 * 放在 shared 里（而不是主进程）是因为**渲染进程也要用**：漫画页图、封面缩略图都要
 * 直接写进 `<img src>`。而预加载脚本跑在 `sandbox: true` 下，只能用 `electron`/`events`/
 * `timers`/`url` 四个模块，`node:path` 拿不到——所以这里只用字符串操作实现，不依赖
 * 任何 Node 模块。主进程的协议处理器用同一份实现，避免「拼 URL 的规则有两套」。
 */
export function bookAssetUrl(bookId: string, rel: string): string {
  const segments = rel
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment));
  return `arale://${bookId}/${segments.join('/')}`;
}

/**
 * 能导入的扩展名 —— **唯一真相源**。
 *
 * 为什么单独列出来：文件选择对话框的 `filters` 就是按这张表建的，而它曾经漏了
 * `.rar/.cbr/.7z/.cb7/.cbt`（加原生解包时只改了导入器、忘了改对话框），结果是
 * **拖放能导、点「导入」却选不中那几个文件**。这类「两张表各自手写、静默漂移」
 * 正是 Fushi BUG-1121 的成因，所以这里既要收成一处，也要有守卫测试钉住
 * 「对话框覆盖了导入器接受的每一个扩展名」。
 *
 * `.zip`/`.cbz` 走纯 JS；其余压缩包走 Rust sidecar（见 native-protocol.ts）。
 */
export const IMPORTABLE_EXTENSIONS = {
  /**
   * 电子书与漫画：对话框主过滤器的内容 —— **必须覆盖下面每一张表的并集**。
   * 单张图片也算（会被当成 1 页的一卷），所以图片扩展名也在里面。
   */
  all: [
    '.epub',
    '.cbz',
    '.zip',
    '.rar',
    '.cbr',
    '.7z',
    '.cb7',
    '.cbt',
    '.mokuro',
    '.jpg',
    '.jpeg',
    '.png',
    '.webp',
    '.gif',
    '.bmp',
  ],
  /** 漫画压缩包（不含 EPUB / .mokuro）。 */
  comics: ['.cbz', '.zip', '.rar', '.cbr', '.7z', '.cb7', '.cbt'],
  /** 单独一张图片也能当一卷导入。 */
  images: ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'],
  /** mokuro 清单 + 同级页图。 */
  mokuro: ['.mokuro'],
  /** EPUB。 */
  epub: ['.epub'],
} as const;

/** 兼容旧名（主进程/渲染进程已有引用）。 */
export const COMIC_ARCHIVE_EXTENSIONS = IMPORTABLE_EXTENSIONS.comics;
export const EPUB_EXTENSIONS = IMPORTABLE_EXTENSIONS.epub;

export type ImportFormatHint = BookFormat | null;
