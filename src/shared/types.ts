/**
 * aralebook —— 跨进程共享契约（冻结文件）。
 *
 * 主进程（Node）、预加载脚本、渲染进程（浏览器）三边都 import 本文件。它是**唯一的**
 * 数据形状真相源；任何一边想加字段，先改这里。
 *
 * 设计约束（与 Fushi 的对照，见 docs/analysis/）：
 * - 漫画与小说是**同一种书**的两种 `format`，共用一个书库目录与一条记录，这与 Fushi 把
 *   EPUB/PDF/manga 全塞进 `EpubBooks` 一张表是同一个取舍（analysis 04 §E）。
 * - 文本偏移一律是 **UTF-16 code unit 偏移**，因为渲染进程那边对应的是 DOM `Range`
 *   的 `startOffset`/`endOffset`（analysis 02 §6、03 §C）。不要用码点偏移。
 * - 磁盘路径分两种：`dir` 是绝对路径（主进程用），`coverRel`/`page.url`/`page.href`
 *   是相对书目录的**正斜杠**路径（渲染进程用）。规则同 Fushi 的 `normalizeMangaUrl`。
 */

// ---------------------------------------------------------------------------
// 书
// ---------------------------------------------------------------------------

/** 一本书的载体类型。aralebook 只有这两种——不要加第三种。 */
export type BookFormat = 'epub' | 'comic';

/** 阅读方向。漫画默认 `rtl`（日漫），小说默认 `ltr`。 */
export type ReadingDirection = 'ltr' | 'rtl';

/**
 * 用哪个阅读器打开这本书。
 *
 * **刻意与 [BookRecord.format] 分开**：`format` 回答「这本书是什么」，`readerMode`
 * 回答「怎么读它」。两者在绝大多数情况下一致，但有一种书需要分开——
 *
 * > **图片型小说**：一整本扫描/插图页的 EPUB。它**是**一本小说（书库里该归到小说、
 * > 筛选器里该出现在 EPUB 里），但**没有任何可读文本**，用小说阅读器打开是一片空白。
 * > 这种书要以漫画方式翻页，才谈得上阅读和 OCR。
 *
 * 所以：`format: 'epub'` + `readerMode: 'comic'` = 「显示为小说、用漫画阅读器」。
 */
export type ReaderMode = 'epub' | 'comic';

/** 书库里的一本书（= `<libraryDir>/<id>/book.json` 的内容）。 */
export interface BookRecord {
  /** 稳定主键，`bk_` + 16 位随机十六进制。同时也是书目录名与 `arale://` 的 host 段。 */
  id: string;
  format: BookFormat;

  title: string;
  /** 用于排序的标题（已小写化、去标点；由 core/util/sort-key.ts 生成）。 */
  titleSort: string;
  author: string;
  series: string | null;
  /** 卷号，从标题或元数据里解析出来的整数；没有就是 null。 */
  volume: number | null;
  language: string | null;
  publisher: string | null;
  description: string | null;
  /** 用户可编辑的标签。 */
  tags: string[];

  /** 封面在书目录内的相对路径（正斜杠），没有封面就是 null。 */
  coverRel: string | null;
  /** 书目录绝对路径。 */
  dir: string;

  addedAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;

  direction: ReadingDirection;

  /**
   * 阅读方式。**缺省 = 跟随 [format]**。
   *
   * 只在「载体格式 ≠ 阅读方式」时才需要写；写 `format` 一样的值是冗余，但合法
   * （用户手动切回去时就是这么表达的）。
   */
  readerMode?: ReaderMode;

  // --- format === 'epub' ---
  /** spine 顺序的章节表；comic 时为 null。 */
  spine: SpineItem[] | null;
  /** 目录（nav.xhtml / NCX 解析结果）；comic 时为 null。 */
  toc: TocEntry[] | null;
  /** EPUB 的 OPF 在书目录内的相对路径；comic 时为 null。 */
  opfRel: string | null;

  // --- format === 'comic' ---
  /**
   * 按自然序排好的页。
   *
   * 通常只有漫画才有；但**图片型小说也有**（`format: 'epub'` + `readerMode: 'comic'`），
   * 页图来自 EPUB 各章节里的图片。所以判「能不能用漫画阅读器」要看这个字段
   * （或直接用 [readerModeOf]），**不要**看 `format`。
   */
  pages: ComicPage[] | null;
  /** 页数（epub 时等于 spine.length）。 */
  pageCount: number;
}

/**
 * 这本书该用哪个阅读器打开。
 *
 * 所有分发点（阅读器视图、OCR 服务、页文字层读取）都必须走这一个函数，
 * 不要各自写 `book.format === 'comic'` —— 「图片型小说」那条特例会在某个分支里漏掉，
 * 而症状是「打开是空白」或「OCR 说这不是漫画」，很难联想到这里。
 */
export function readerModeOf(book: Pick<BookRecord, 'format' | 'readerMode'>): ReaderMode {
  return book.readerMode ?? book.format;
}

/** 这本书是不是「图片型小说」（显示为小说、以漫画方式阅读）。 */
export function isImageNovel(book: Pick<BookRecord, 'format' | 'readerMode' | 'pages'>): boolean {
  return book.format === 'epub' && readerModeOf(book) === 'comic';
}

/**
 * EPUB spine 里的一项。
 *
 * `href` 已经**解析到「书目录根」**（= `content/` 根 = 解包后的 ZIP 根），
 * 而不是相对 OPF 所在目录。例如 OPF 在 `OEBPS/content.opf`、章节在
 * `OEBPS/text/ch1.xhtml` 时，这里存的是 `OEBPS/text/ch1.xhtml`。
 *
 * 为什么在解析阶段就归一化：读者侧只拿到书目录根，没有 OPF 目录，
 * 每次读章节再拼一次前缀等于把「相对谁」这件事重复实现一遍——而 Fushi 正是在
 * 这个点上踩过 `img_path` 两种惯例的坑（BUG-1830）。
 */
export interface SpineItem {
  id: string;
  /** 相对书目录根（`content/`）的路径，正斜杠。 */
  href: string;
  mediaType: string;
  linear: boolean;
}

/** 目录项。`href` 同样是**相对书目录根**的路径，且已去掉 `#fragment`。 */
export interface TocEntry {
  label: string;
  href: string;
  depth: number;
}

/** 漫画的一页。`url` 相对书目录。 */
export interface ComicPage {
  url: string;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// 阅读进度
// ---------------------------------------------------------------------------

/**
 * 阅读位置。两种格式各用一半字段：
 * - epub：用 `spineIndex` + `charOffset`（该章节纯文本内的 UTF-16 偏移）。
 * - comic：用 `pageIndex`（0 基）。
 * 这些字段**恒为可选**，因为「没读过」时它们都是 undefined（Fushi 用 `-1` 表示缺省，
 * 结果在 analysis 02 §8 里被 BUG-285 咬过一次；这里用 undefined 从类型上杜绝）。
 */
export interface ReadingPosition {
  bookId: string;
  spineIndex?: number;
  charOffset?: number;
  pageIndex?: number;
  /** 用于在书变版（章节重排）后判断锚点是否还有效。 */
  spineHref?: string;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// 漫画文字层（mokuro 兼容）
// ---------------------------------------------------------------------------

/** `[x1, y1, x2, y2]`，单位是**原图像素**，永远不随缩放改变。 */
export type Box = [number, number, number, number];

/**
 * 一块文字（mokuro 的 `MokuroBlock`）。
 * 字段名保持与 Fushi `mokuro_payload.dart` 一致的语义，便于直接吃 `.mokuro` / `manga.json`。
 */
export interface TextBlock {
  box: Box;
  /** 竖排（日漫默认）。 */
  vertical: boolean;
  /** 字号，单位是**原图像素**——渲染时按 `scale` 相乘，不要用 `%`/`cqw`（analysis 01 §10）。 */
  fontSize: number;
  /** 逐行文本；`lines.join('')` 就是这一块的完整文本。 */
  lines: string[];
  /**
   * **生产者保证「这个框里只有一段文字」**（一行横排 / 一列竖排）。
   *
   * 有它时 `charIndexAt` / `boundaryAt` / `charRangeRects` 不再去猜排版：段数恒为 1，
   * 字符沿框的长边等分。没有它（例如导入的第三方 `.mokuro`）才退回按面积猜。
   *
   * 为什么必须有这个字段：第三方 mokuro 的一个 block 是**区域**（整个气泡/旁白），
   * `lines` 里可能是一整段文字，行列结构只能靠 `sqrt(W·H/N)` 反推；而本项目的 OCR
   * 引擎（`buildBlocks`）是**一个文字行/列一个 block**。两者在磁盘上是同一种形状，
   * 光看数据分不出来，只能由生产者明确声明。
   *
   * 序列化键是 `single_line`（不认识这个键的 mokuro 读取方会忽略它）。
   */
  singleLine?: boolean;
  /** 字符级命中框；没有就是 undefined（此时退化成整块命中）。 */
  regions?: TextRegion[];
}

/** 块内一个字符的命中框，`utf16Start/End` 索引 `lines.join('')`。 */
export interface TextRegion {
  box: Box;
  utf16Start: number;
  utf16End: number;
}

/** 某一页的文字层。`blocks` 为空数组表示「这页没有 OCR 数据」。 */
export interface PageText {
  url: string;
  blocks: TextBlock[];
}

// ---------------------------------------------------------------------------
// 分词 / 词典
// ---------------------------------------------------------------------------

/**
 * 一次分词出来的一个词。
 * `start`/`end` 是**源字符串的 UTF-16 偏移**，直接可以喂给 DOM `Range`。
 * `matched === false` 表示词典里查不到，只是个占位/单字。
 */
export interface SegmentToken {
  surface: string;
  start: number;
  end: number;
  matched: boolean;
  /** 词典里匹配到的词形（可能与 surface 不同，例如经过了变形还原）。 */
  baseForm: string | null;
}

/** 支持的词典包格式。v1 只做 Yomitan（= Yomichan 新版）bank 格式。 */
export type DictionaryFormat = 'yomitan';

/** 已安装的一本词典。 */
export interface DictionaryInfo {
  id: string;
  title: string;
  format: DictionaryFormat;
  /** 词条数。 */
  termCount: number;
  /** 有频率数据的词条数。 */
  freqCount: number;
  importedAt: number;
  /** 导入后被禁用时不参与查询。 */
  enabled: boolean;
}

/** Yomitan 结构化内容的递归形状（`glossary` 字段的元素）。 */
export type GlossaryContent = string | GlossaryStructured | GlossaryContent[];

/** Yomitan 结构化内容里的一个带标签节点。 */
export interface GlossaryStructured {
  tag?: string;
  style?: Record<string, string>;
  content: GlossaryContent;
}

/** 一条词典释义（≈ Yomitan term bank 的一行）。 */
export interface DictTerm {
  /** 辞书形。 */
  expression: string;
  /** 读音（假名）。没有就是空串。 */
  reading: string;
  definitionTags: string[];
  termTags: string[];
  /** Yomitan 的 `rules`：这条词能接哪些变形条件。 */
  rules: string[];
  score: number;
  sequence: number;
  glossary: GlossaryContent;
  dictionaryId: string;
  dictionaryTitle: string;
}

/** 频率数据（来自 `term_meta_bank_*.json` 的 `freq`）。 */
export interface DictFrequency {
  value: number | string;
  display: string | null;
  dictionary: string;
}

/** 变形还原的一步（用于在弹窗里显示「从 xxx 变来」）。 */
export interface DeinflectionStep {
  /** 变形名，如 `-ます`、`-て`。 */
  name: string;
  description: string;
}

/** 一条命中的查询结果。 */
export interface LookupTermResult {
  term: DictTerm;
  /** 命中的那个词形（= 扫描窗口里的候选串）。 */
  matched: string;
  /** 经过的变形还原步骤；直接命中时为空数组。 */
  deinflection: DeinflectionStep[];
  frequencies: DictFrequency[];
}

/** 一次查询的完整结果。 */
export interface LookupResult {
  /** 调用方原始传入的文本（可能是整句）。 */
  query: string;
  /**
   * 命中的**表面形**——扫描出来的最长命中，就是用户在正文里点到的那个词
   * （例如 `食べました`）。弹窗标题显示它。
   *
   * 辞书形**不在这里**，而在 `results[].term.expression`（例如 `食べる`）。
   * 两者分工明确：表面形回答「我点的是什么」，辞书形回答「这词是什么」。
   */
  term: string;
  /** 词典条目，已按频率与分数排好序。 */
  results: LookupTermResult[];
  /** 对 `query` 的分词结果，供 UI 画下划线。 */
  tokens: SegmentToken[];
  /** 命中的词典数，用于「未安装词典」提示。 */
  dictionaryCount: number;
}

/** `dict:status` 的返回。 */
export interface DictionaryStatus {
  /** 词典存放根目录的绝对路径（UI 里显示给用户）。 */
  dir: string;
  dictionaries: DictionaryInfo[];
  /** 所有启用词典的词条总数。 */
  termCount: number;
  /** 索引是否已经载入内存。 */
  loaded: boolean;
}

/** 一次导入动作的结果。 */
export interface ImportOutcome {
  /** 源路径。 */
  source: string;
  ok: boolean;
  /** 成功时是新书 id。 */
  bookId: string | null;
  /** 失败原因（给人看的）。 */
  error: string | null;
  /** 识别出来的格式。 */
  format: BookFormat | null;
}

// ---------------------------------------------------------------------------
// 书库状态
// ---------------------------------------------------------------------------

/** 书库根目录信息。 */
export interface LibraryInfo {
  /** 书库根目录绝对路径。 */
  dir: string;
  bookCount: number;
  comicCount: number;
  epubCount: number;
}

/** 书库列表的查询参数（分页 + 筛选 + 排序全在主进程做，因为索引在主进程）。 */
export interface LibraryQuery {
  /** 全文搜索串，匹配标题/作者/系列/标签。 */
  search?: string;
  /** null/undefined = 全部。 */
  format?: BookFormat | null;
  /** 按标签过滤（任一命中即可）。 */
  tags?: string[];
  sort?: LibrarySort;
  offset?: number;
  limit?: number;
}

export type LibrarySort =
  | 'title'
  | 'titleDesc'
  | 'author'
  | 'added'
  | 'addedDesc'
  | 'lastOpened'
  | 'series';

/** 书库列表的一页。 */
export interface LibraryPage {
  books: BookRecord[];
  /** 过滤后的总数（不是这一页的条数）。 */
  total: number;
  /** 整个书库的全部标签（去重排序），给侧栏用。 */
  allTags: string[];
  /** 全部系列名（去重排序）。 */
  allSeries: string[];
  /**
   * 全部作者（**整库**，不受当前筛选影响）。
   *
   * 必须由主进程从整库算。之前的做法是渲染进程「从当前这一页的书里现算」，于是选中
   * 一个作者之后，筛选结果里只剩那个作者的书 → 作者清单里也就只剩他了，
   * **其余作者整段消失**，用户没法直接切到另一个（得先清掉搜索框）。
   * 分面的**选项集合**必须是稳定的，只有**计数**才该随筛选变。
   */
  allAuthors: string[];
}

/** 打开一本书时返回的东西。 */
export interface OpenBookResult {
  book: BookRecord;
  position: ReadingPosition | null;
}

// ---------------------------------------------------------------------------
// 阅读器资源
// ---------------------------------------------------------------------------

/**
 * 一个 EPUB 章节渲染所需的素材。
 *
 * 走的是**直接在 iframe 里加载 `arale://` URL**的路子，而不是 `srcdoc`：
 * - 章节里的相对资源（图片、CSS、字体）自然相对章节 URL 解析，不需要注入 `<base>`；
 * - 阅读样式与桥接脚本由 `arale://` 协议处理器在**服务端**注入，sanitize（剥 `<script>`、
 *   `on*` 属性）也发生在那里——渲染进程拿到的东西已经是安全的；
 * - iframe 的 origin 是 `arale://<id>`，和 `file://` 外壳隔离，书里的恶意脚本即使漏网
 *   也碰不到 Node/Electron（Fushi 同样是「拦截虚拟 host」而不是起本地服务器，
 *   见 analysis 02 §5）。
 */
export interface ChapterContent {
  spineIndex: number;
  /** 直接赋给 `iframe.src` 的 `arale://` URL（协议处理器已注入样式与桥接脚本）。 */
  url: string;
  /**
   * 该章节的纯文本快照，供搜索/字数统计使用。
   *
   * **注意**：阅读位置的偏移基准不是它，而是桥接脚本在 iframe DOM 上走一遍得到的
   * 同一套偏移。两者只要「保存与恢复用同一个算法」就自洽；强行让服务端正则抽出的
   * 文本和 DOM 文本逐字对齐是 Fushi 踩过的坑（analysis 02 §9），这里不重复。
   */
  plainText: string;
}

// ---------------------------------------------------------------------------
// 本地漫画 OCR（可选能力）
// ---------------------------------------------------------------------------

/**
 * OCR 引擎标识。
 *
 * **系统引擎**（`system`）：**操作系统自己**的 OCR——macOS 走 Vision，Windows 走
 * `Windows.Media.Ocr`。随应用走、零下载、零额外依赖，开箱可用。
 *
 * **扩展引擎**（`manga-anki`）：下载安装的扩展，内含 mokuro 管线
 * （comic-text-detector + manga-ocr）。质量明显更好，但实测打包后 ~1.6 GB，
 * 所以做成可选扩展而不是随包分发。它现在**不是**「指着用户本机某个 checkout」，
 * 而是从扩展清单里装出来的一个自洽包。
 *
 * 曾经的 `builtin`（PP-OCRv5 / onnxruntime-node）已删除：它需要为竖排做旋转补偿，
 * 真实漫画上逐行命中只有 23%，而体积（onnxruntime 三个平台的二进制）还不小。
 */
export type OcrProviderId = 'system' | 'manga-anki';

/** 某个引擎的能力与就绪状态。 */
export interface OcrEngineStatus {
  id: OcrProviderId;
  /** 给人看的名字。 */
  label: string;
  /** 现在能不能用。 */
  available: boolean;
  /** 模型/依赖是否已就位（可用但未就绪时，首次运行会去准备）。 */
  ready: boolean;
  /** 不可用或未就绪的原因；available 且 ready 时为 null。 */
  reason: string | null;
  /** 这个引擎需要什么（一行说明，UI 里显示在选项下面）。 */
  requirement: string;
  /** 大概要下多少 MB（0 表示不需要下载）。 */
  downloadSizeMb: number;
  /**
   * 这个引擎来自哪个扩展；随应用走的引擎是 null。
   *
   * UI 靠它决定「不能用时该显示『安装』按钮还是『这台机器不支持』」——
   * 引擎层不该自己知道扩展的存在，但界面必须能把用户引到扩展那一页。
   */
  extension: { id: string; bytes: number; installed: boolean } | null;
}

// ---------------------------------------------------------------------------
// 本地漫画 OCR
// ---------------------------------------------------------------------------

/**
 * OCR 能力探测结果。UI 用它决定「识别本卷」按钮是可用、要下载模型、还是不可用。
 *
 * 分成三态而不是一个 bool，是因为三者的**用户出路完全不同**：
 * `model-missing` 可以自动下载；`unsupported` 只能换机器或改代码。
 */
export interface OcrCapability {
  /** 至少有一个引擎可用。 */
  available: boolean;
  /** 一个可用引擎都没有时的原因，直接展示给用户。 */
  reason: string | null;
  /** 扩展安装目录（`<userData>/extensions`）。装扩展的 UI 与这里指向同一处。 */
  extensionsDir: string;
  /** 全部可选引擎及其就绪状态。UI 用这个渲染「选哪个引擎」。 */
  providers: OcrEngineStatus[];
  /** 上次用户选的引擎（没有就用 `system`）。 */
  selected: OcrProviderId;
}

/** OCR 任务进度。 */
export interface OcrProgress {
  bookId: string;
  /** 正在跑哪个引擎。 */
  provider: OcrProviderId;
  /** 已处理页数。 */
  done: number;
  /** 总页数。 */
  total: number;
  /** 当前页序号（0 基）。 */
  pageIndex: number;
  /** 阶段，UI 据此显示不同文案。 */
  stage: 'loading-model' | 'detecting' | 'recognizing' | 'writing' | 'done' | 'failed';
  message?: string;
}

/** OCR 任务结果。 */
export interface OcrJobResult {
  bookId: string;
  ok: boolean;
  /** 实际用的引擎。 */
  provider: OcrProviderId;
  /** 处理了多少页。 */
  pages: number;
  /** 一共识别出多少个文字块。 */
  blocks: number;
  /** 失败原因。 */
  error?: string;
  /** 是否是「本来就已经有文字层、跳过」的结束态。 */
  skipped?: boolean;
  /** 只是**排进了队列**，还没开始跑。 */
  queued?: boolean;
  /** 队列中的位置（1 基）。`queued` 为真时才有意义。 */
  queuePosition?: number;
}

// ---------------------------------------------------------------------------
// OCR 任务队列
// ---------------------------------------------------------------------------

/**
 * 队列里的一条任务。
 *
 * 为什么要队列而不是「谁点谁立刻跑」：两个引擎都是**独占 CPU 的重活**——内置引擎要
 * 加载 ONNX 模型并逐页推理，manga-anki 还要拉起一整套 Python 管线。同时跑两卷只会
 * 让两卷都变慢，而且内存翻倍。串行执行 + 一个全局进度入口，用户点几次就排几本，
 * 不用盯着哪一本先点在前面。
 */
export interface OcrQueueEntry {
  bookId: string;
  /** 书名快照。队列弹层要显示「在识别哪一本」，此时书可能已经被重命名。 */
  title: string;
  /** 这条任务用哪个引擎。**入队时定死**，之后不改。 */
  provider: OcrProviderId;
  /** 入队时刻，弹层里按这个算「已等待多久」。 */
  enqueuedAt: number;
  /** 总共多少页（用于进度分母；0 表示未知）。 */
  total: number;
}

/** 队列快照。`active` 是正在跑的那条，`pending` 按 FIFO 顺序排。 */
export interface OcrQueueState {
  active: OcrQueueEntry | null;
  pending: OcrQueueEntry[];
}

// ---------------------------------------------------------------------------
// 分词（可选、可反复生成）
// ---------------------------------------------------------------------------

/**
 * 一个词在**所属文本单元内**的位置。
 *
 * 与词典查词的 `SegmentToken` 是同一个语义，但这里要**落盘**、要能跳回原文，
 * 所以带上所在单元的引用（见 [SegmentUnit.ref]）。
 */
export interface SegmentRecord {
  /** 表面形（原文里长什么样）。 */
  surface: string;
  /** 辞书形。词典里查不到时为 null。 */
  baseForm: string | null;
  /** 单元内 UTF-16 偏移（含）。 */
  start: number;
  /** 单元内 UTF-16 偏移（不含）。 */
  end: number;
  /** 词典里有没有这个词。false 时它只是个占位切分。 */
  matched: boolean;
}

/** 分词的粒度单位。漫画是一页里的一个文字块；小说是一章。 */
export interface SegmentUnit {
  /**
   * 稳定的单元引用：
   * - 漫画：`page:<页 url>#<块序号>`
   * - 小说：`chapter:<spine 序号>`
   */
  ref: string;
  /** 该单元的原文。 */
  text: string;
  tokens: SegmentRecord[];
  /** 供 UI 顺手显示的上下文标签（如页名/章节标题）。 */
  label: string;
}

/** 一本书的分词结果（落盘在 `<bookDir>/segments.json`）。 */
export interface BookSegments {
  bookId: string;
  generatedAt: number;
  /** 生成器标识，如 `dictionary-longest-match`。 */
  engine: string;
  /** 词典指纹：换了词典，旧分词就该重新生成。 */
  dictionarySignature: string;
  /** 参与分词的词典数。0 表示没装词典（此时只有占位切分）。 */
  dictionaryCount: number;
  units: SegmentUnit[];
  /** 词表：去重后的词 + 出现次数 + 见过的表面形（最多留 8 个）。 */
  vocabulary: SegmentVocabularyEntry[];
}

export interface SegmentVocabularyEntry {
  /** 辞书形；没查到词典时用表面形。 */
  base: string;
  count: number;
  surfaces: string[];
  /** 是否在词典里查到。 */
  matched: boolean;
}

/** 分词任务进度。 */
export interface SegmentProgress {
  bookId: string;
  done: number;
  total: number;
  stage: 'reading' | 'segmenting' | 'writing' | 'done' | 'failed';
  message?: string;
}

/** 分词任务结果。 */
export interface SegmentJobResult {
  bookId: string;
  ok: boolean;
  /** 处理了多少个单元。 */
  units: number;
  /** 一共切出多少个词（含重复）。 */
  tokens: number;
  /** 去重后的词数。 */
  uniqueWords: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// 词卡（用户保存下来的查询）
// ---------------------------------------------------------------------------

/**
 * 一张保存下来的词卡。
 *
 * ## 为什么「词卡的词」和「词典里的词」要分开存
 *
 * 两种查询方式的精度不同，用户看到的东西也必须不同：
 * - **点击**：从点到的字符出发做最长匹配（`core/dict` 的扫描逻辑），命中的是词典里的
 *   某个辞书形。这是「我点了一下，你猜我要查什么」，允许猜得宽一点。
 * - **划词**：用户明确框住了一段文字，那就是他要查的东西。**不许再猜**——所以
 *   `word` 原样存选区，`dictionaryExpression` 才是词典里的辞书形，两者可以不同
 *   （用户选了「食べました」而词典里是「食べる」）。
 *
 * 因此词卡顶部显示、且可编辑的是 `word`；词典那一栏显示的是 `dictionaryExpression`
 * 与它来自哪本词典。混成一个字段就再也分不清「用户想查的」与「词典给的」。
 */
export interface WordCard {
  id: string;
  /** 词卡顶部的词（用户可手动改）。划词时就是选区原文。 */
  word: string;
  /** 查词时的上下文（点击时是文字块全文，划词时是选区所在段落）。 */
  context: string;
  /** `context` 内的 UTF-16 偏移。 */
  offset: number;
  /** 选区长度；点击查词时为 0。 */
  length: number;
  /** 词典命中的辞书形。没查到就是空串。 */
  dictionaryExpression: string;
  dictionaryId: string;
  dictionaryTitle: string;
  dictionaryReading: string;
  /** 用户的笔记。 */
  note: string;
  /**
   * 这张卡上所有 LLM 分析，一个分析过的词一条。
   *
   * 为什么是数组而不是单条：用户会**从短划到长**。先划「ABCD」里的 A 分析一次，再划 AB，
   * 再到 ABC——每一步都值得知道。所以卡片按「当前词包含哪些已经分析过的词」把它们
   * 一条条列出来（短的在前），最后一条是当前词自己的。
   */
  analyses: WordCardAnalysis[];
  createdAt: number;
  updatedAt: number;
}

export interface WordCardAnalysis {
  /**
   * 这条分析针对的**词**。
   *
   * **不一定等于词卡的词**：先划 A、再划 AB 时，A 的分析会作为子句挂在 AB 这张卡上。
   * 界面据此把每条分析标出它讲的是哪个词，删除也按词定位。
   */
  word: string;
  text: string;
  /** 用哪套 LLM 配置跑的（配置名），以及模型名。 */
  profileName: string;
  model: string;
  createdAt: number;
}

/** 新建词卡时由渲染进程给出的部分。其余字段由主进程补。 */
export interface WordCardDraft {
  word: string;
  context: string;
  offset: number;
  length: number;
  dictionaryExpression: string;
  dictionaryId: string;
  dictionaryTitle: string;
  dictionaryReading: string;
}

// ---------------------------------------------------------------------------
// LLM（chat completions 兼容）
// ---------------------------------------------------------------------------

/**
 * 一套 LLM 配置。
 *
 * 形状刻意对着 **OpenAI chat completions** 的约定（`POST <baseUrl>/chat/completions`
 * 带 `{model, messages}`）：本地 llama.cpp / Ollama / LM Studio / vLLM，以及各家云端
 * 都支持这个形状，用户换服务商只需要改地址和模型名。
 */
export interface LlmProfile {
  id: string;
  /** 显示名（用户自己起，如「本地 Qwen」「DeepSeek」）。 */
  name: string;
  /** 形如 `https://api.example.com/v1` 或 `http://127.0.0.1:8080/v1`。 */
  baseUrl: string;
  model: string;
  temperature: number;
  /**
   * 是否已经存了 API key。**key 本身永远不通过 IPC 返回渲染进程**——
   * 界面只需要知道「有没有」，不需要拿到明文。
   */
  hasApiKey: boolean;
}

export interface LlmSettings {
  profiles: LlmProfile[];
  /** 当前默认用哪套；null = 没选。 */
  activeProfileId: string | null;
  /**
   * 分析用的提示词。`{{word}}` 替换成词，`{{context}}` 替换成上下文。
   *
   * 放在设置里而不是写死在代码里：不同词需要不同的问法（拟声词 vs 语法点），
   * 而这正是用户最想自己调的东西。
   */
  prompt: string;
}

export interface LlmAnalyzeRequest {
  word: string;
  /** 可选上下文。提示词里用 `{{context}}` 取。 */
  context: string;
  /**
   * 用哪套配置。
   *
   * 三档，语义依次覆盖：词卡上临时选的 > 设置里的默认（`activeProfileId`）。
   * 词卡能临时指定是必须的——同一个词用本地小模型和云端大模型问出来的东西差别很大，
   * 而「这次我想用一个更好的」是个**每次都要做**的决定，不该逼用户去改全局默认。
   */
  profileId?: string;
}

export interface LlmAnalyzeResult {
  ok: boolean;
  /** 模型返回的文本（Markdown）。 */
  text: string;
  profileName: string;
  model: string;
  /** 失败原因（含 HTTP 状态与响应片段）。 */
  error?: string;
}

/**
 * **历史默认提示词**。
 *
 * 为什么要留这个列表：`llm.json` 里存着一份 prompt，一旦存过，改代码里的默认就**再也
 * 影响不到老用户**——他会一直用着旧提示词，而界面上看不出任何区别。
 * 判据是「存着的那份**逐字等于**某个历史默认」→ 说明用户从没编辑过，可以安全升级：
 * 升级时替换成新的默认。用户真改过的话一个字符都不会动。
 *
 * 改 `DEFAULT_LLM_PROMPT` 时**把旧的那份原样追加到这里**，别删。
 */
export const LEGACY_LLM_PROMPTS: readonly string[] = [
  [
    '你是日语学习助手。请解释日语词「{{word}}」。',
    '',
    '如果有上下文，请说明它在这里的具体含义：',
    '{{context}}',
    '',
    '要求：',
    '1. 先给读音（假名）与词性；',
    '2. 再给简洁的中文释义；',
    '3. 最后用一句话说明它在上面这段上下文里的意思（没有上下文就跳过）。',
    '不要重复问题，不要客套，直接给结果。',
  ].join('\n'),
];

/** 默认提示词。改它要同时把它追加进 [LEGACY_LLM_PROMPTS] 并跑测试。 */
export const DEFAULT_LLM_PROMPT = [
  '你是日语学习助手。请解释日语词「{{word}}」。',
  '',
  '如果有上下文，请说明它在这里的具体含义：',
  '{{context}}',
  '',
  '要求：',
  '1. 先给读音（假名）与词性；',
  '2. 再给简洁的中文释义；',
  '3. **如果是舶来语（外来語）**，说明它来自哪种语言、原词是什么、以及原义与现在的日语义是否已经偏移；',
  '4. 最后用一句话说明它在上面这段上下文里的意思（没有上下文就跳过）。',
  '不要重复问题，不要客套，直接给结果。',
].join('\n');
