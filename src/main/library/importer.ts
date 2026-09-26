/**
 * 导入：磁盘路径 → 一本书。
 *
 * 与 Fushi 的历史对照（见 docs/archive/2026-09-26/docs/analysis/ 下的 01 §2、02 §1）：
 * - Fushi 的载体判定是纯函数 `classifyImportCarrier`，`.zip`/`.epub` 这类**歧义扩展名**
 *   必须真正开包看一眼（`looksLikeImageArchive`）；这里照做，因为「词典包也是 .zip」是
 *   真实存在的用户行为。
 * - Fushi 对失败导入做整体回滚（先建目录再插行，失败删目录删行）。这里也是：任何一步
 *   抛错就删掉半成品目录，绝不留下一个点不开的书。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { BookRecord, ComicPage, ImportOutcome, PageText } from '../../shared/types';
import { normalizeRel, sanitizeRelSegments } from '../../core/util/paths';
import { naturalCompare } from '../../core/util/natural-sort';
import { makeBookId } from '../../core/util/id';
import { writeJsonAtomic } from '../../core/util/atomic-json';
import { probeOrientedImageSize } from '../../core/comic/image-size';
import {
  collectArchivePages,
  isComicImage,
  MOKURO_OUT_DIR,
  sortPagePaths,
} from '../../core/comic/pages';
import {
  emptyPageText,
  parseMangaJson,
  parseMokuro,
  parseMokuroTopLevel,
  serializeMangaJson,
} from '../../core/comic/mokuro';
import { extractText, parseEpub, type ParsedEpub } from '../../core/epub/parser';
import { findEntry, readZipFile, type ZipEntry } from '../../core/epub/zip-reader';
import {
  contentSpineItems,
  judgeImageNovel,
  scanChapter,
  type ChapterScan,
} from '../../core/epub/image-novel';
import { extractArchive, probeArchive } from '../native/sidecar';
import type { AppDefaults } from '../../shared/defaults';
import { DEFAULT_APP_DEFAULTS } from '../../shared/defaults';
import { bookContentDir, bookDir } from '../paths';
import { LibraryStore, makeBaseRecord } from './store';

/** 单个压缩包的内存上限。超过就拒绝并给出可操作的建议，而不是让进程 OOM。 */
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * 走纯 JS（fflate）的压缩包扩展名。
 *
 * 只有 `.cbz` / `.zip`。`.cb7` 虽然基于 7z 容器但走原生层，**不要**加回这里——
 * `NATIVE_ARCHIVE_EXTS` 先被检查，加回来只会让两处表看起来都说得通、实际上面那个赢。
 */
const COMIC_ARCHIVE_EXTS = new Set(['.cbz', '.zip']);
/** RAR/CBR/7Z/CB7/CBT 走 Rust 原生 sidecar；纯 JS 没有可靠实现（见 src/shared/native-protocol.ts）。 */
const NATIVE_ARCHIVE_EXTS = new Set(['.cbr', '.rar', '.7z', '.cb7', '.cbt']);
const EPUB_EXTS = new Set(['.epub']);
const MOKURO_EXTS = new Set(['.mokuro']);
const ARCHIVE_EXTS = new Set([...COMIC_ARCHIVE_EXTS, ...NATIVE_ARCHIVE_EXTS]);

export class ImportError extends Error {}

/** 判定一个路径该走哪条导入路径。目录一律按「纯页图漫画」处理。 */
export function detectImportKind(
  source: string,
): 'epub' | 'comic' | 'native' | 'directory' | 'unsupported' {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(source);
  } catch {
    return 'unsupported';
  }
  if (stat.isDirectory()) return 'directory';

  const ext = path.extname(source).toLowerCase();
  if (EPUB_EXTS.has(ext)) return 'epub';
  if (MOKURO_EXTS.has(ext)) return 'comic';
  // 注意：`isComicImage` 收的是**路径**（内部自己做 extname），不是扩展名。
  // 传 `${ext}` 进去会因为 extname('.png') === '' 而永远返回 false。
  if (isComicImage(source)) return 'comic';
  if (NATIVE_ARCHIVE_EXTS.has(ext)) return 'native';
  if (COMIC_ARCHIVE_EXTS.has(ext)) {
    // `.zip` 是歧义扩展名：开包看里面是 OPF 还是图片。
    return peekArchiveKind(source);
  }
  return 'unsupported';
}

/**
 * 开包嗅探。Fushi 的教训是这一步很贵，必须放进后台 isolate；我们是单进程主进程，
 * 所以只读中央目录、不解压内容，代价是 O(条目数) 次读并返回。
 */
function peekArchiveKind(source: string): 'epub' | 'comic' | 'unsupported' {
  if (fs.statSync(source).size > MAX_ARCHIVE_BYTES) return 'unsupported';
  let entries: ZipEntry[];
  try {
    entries = readZipFile(source);
  } catch {
    return 'unsupported';
  }
  const names = entries.filter((e) => !e.isDir).map((e) => e.name.toLowerCase());
  if (names.some((n) => n.endsWith('.opf'))) return 'epub';
  if (names.some((n) => isComicImage(n))) return 'comic';
  return 'unsupported';
}

/**
 * 导入一个路径。**永不抛**——失败一律包成 `ImportOutcome.error` 返回给 UI。
 *
 * 返回值是**数组**：一个文件可能产出多本书。典型场景是**套娃包**——
 * 用户拖进来的 `某某 01-02.rar` 里装的其实是两个分卷 RAR。那种情况下每个分卷
 * 各导入成一本（见 [tryImportCollection]），而不是报「这个压缩包里没有任何图片页」。
 */
export async function importPath(
  source: string,
  store: LibraryStore,
  depth = 0,
): Promise<ImportOutcome[]> {
  // 纯 JS 压缩包（`.cbz`/`.zip`）要读**两次**：一次判断是不是套娃包，一次真正导入。
  // 而 `readZipFile` 是整包 `readFileSync` + 全量 inflate（`zip-reader.ts:118`），
  // 一本 300 MB 的漫画多读一遍就是白等一次全量 I/O 加一整份缓冲区。
  // 所以这里给两条路一个**惰性**的读取入口：谁先要谁触发，结果共用一份。
  //
  // 用惰性而不是预先读：坏包必须由 `importSingle` 的 try/catch 报出原始错误
  // （`无法读取文件 …`）。预先读会把异常甩到 `importPath` 外面，测试里那条
  // `broken.zip` 的用例正是守着这个。
  let cached: ZipEntry[] | null = null;
  const peekZip =
    COMIC_ARCHIVE_EXTS.has(path.extname(source).toLowerCase()) && fs.existsSync(source)
      ? (): ZipEntry[] => {
          if (cached === null) cached = readZipFile(source);
          return cached;
        }
      : null;

  const collection = await tryImportCollection(source, store, depth, peekZip);
  if (collection !== null) return collection;
  return [await importSingle(source, store, peekZip)];
}

/**
 * 导入时用的默认值（新书的阅读方向）。
 *
 * 为什么用模块级变量而不是参数：导入是个纯函数式的流水线，四个进口
 * （zip 漫画 / 原生压缩包 / mokuro / 图片文件夹）都要用它，为此把 `defaults` 穿过
 * 六七个函数签名只会让每个调用点都多一个「这参数是干嘛的」问号。启动时与设置变更时
 * 各刷一次即可（见 `main/index.ts` 与 `main/ipc.ts`）。
 */
let importDefaults: AppDefaults = DEFAULT_APP_DEFAULTS;

export function setImportDefaults(next: AppDefaults): void {
  importDefaults = next;
}

/** 套娃包的最大递归深度。防的是「压缩包套压缩包套……」的构造炸弹。 */
const MAX_ARCHIVE_NESTING = 3;

/** 所有压缩包扩展名（含走纯 JS 的 zip/cbz）—— 用来识别「成员是压缩包」。 */
const ARCHIVE_ENTRY_EXTS = new Set([...COMIC_ARCHIVE_EXTS, ...NATIVE_ARCHIVE_EXTS]);

function isArchiveMember(rel: string): boolean {
  return ARCHIVE_ENTRY_EXTS.has(path.extname(rel).toLowerCase());
}

/**
 * 把「里面装的是压缩包」的容器拆开，逐个递归导入。
 *
 * 判据（三条都要满足，顺序也是从便宜到贵）：
 * 1. 扩展名是压缩包；
 * 2. **没有任何页图** —— 有页图说明它本身就是漫画，不是套娃；
 * 3. 至少有一个成员是压缩包。
 *
 * 返回 `null` 表示「不是套娃包，走常规导入」。返回数组表示「已处理完」。
 *
 * 分卷包很常见（发布者把 01-02 卷打成一个 RAR），而它们**不该报错**：
 * 用户的心智模型是「我拖了一套漫画进来」，正确结果是书架多出两本。
 */
async function tryImportCollection(
  source: string,
  store: LibraryStore,
  depth: number,
  peekZip: (() => ZipEntry[]) | null,
): Promise<ImportOutcome[] | null> {
  const ext = path.extname(source).toLowerCase();
  if (!ARCHIVE_ENTRY_EXTS.has(ext)) return null;

  let members: string[];
  try {
    if (NATIVE_ARCHIVE_EXTS.has(ext)) {
      const probe = await probeArchive(source);
      // 包里是 EPUB 就不是套娃包（比如 .7z 里装了一本 epub）。
      if (probe.kind === 'epub' || probe.imageCount > 0) return null;
      members = probe.entries;
    } else {
      if (peekZip === null) return null;
      const entries = peekZip();
      const names = entries.filter((entry) => !entry.isDir).map((entry) => normalizeRel(entry.name));
      // 有页图 → 它自己是漫画。
      if (names.some((name) => isComicImage(name))) return null;
      members = names;
    }
  } catch {
    // 开不了包不是这里的事，交给常规路径去报错。
    return null;
  }

  const inner = members.filter(isArchiveMember);
  if (inner.length === 0) return null;

  // 到顶了。这里**必须**报一条说得通的错误，不能只是 return null：
  // 落回常规路径会走 `detectImportKind` → 'unsupported'，于是 UI 显示
  // 「不支持的格式 .cbz」——扩展名明明支持，用户完全不知道该改什么。
  if (depth >= MAX_ARCHIVE_NESTING) {
    return [
      {
        source,
        ok: false,
        bookId: null,
        format: null,
        error: `压缩包嵌套超过 ${MAX_ARCHIVE_NESTING} 层，已停止展开。这一层里还有压缩包：${inner
          .slice(0, 3)
          .join('、')}${inner.length > 3 ? ` 等 ${inner.length} 个` : ''}`,
      },
    ];
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-collection-'));
  try {
    const paths = await materializeInnerArchives(source, tempDir, inner, peekZip);
    if (paths.length === 0) return null;

    const outcomes: ImportOutcome[] = [];
    for (const innerPath of paths) {
      // 递归：分卷本身也可能再套一层。
      const results = await importPath(innerPath, store, depth + 1);
      for (const result of results) {
        outcomes.push({ ...result, source: `${source} › ${path.basename(innerPath)}` });
      }
    }
    return outcomes;
  } finally {
    // 临时目录必须清掉：一个 200MB 的套娃包会在这里落一份同样大的副本。
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* 清不掉就留给系统临时目录去收 */
    }
  }
}

/** 把容器里的压缩包成员落到 [tempDir]，返回绝对路径。 */
async function materializeInnerArchives(
  source: string,
  tempDir: string,
  inner: readonly string[],
  peekZip: (() => ZipEntry[]) | null,
): Promise<string[]> {
  const ext = path.extname(source).toLowerCase();

  if (NATIVE_ARCHIVE_EXTS.has(ext)) {
    await extractArchive(source, tempDir, false);
    const wanted = new Set(inner);
    return listFilesRecursively(tempDir)
      .filter((rel) => wanted.has(rel) || wanted.has(path.posix.basename(rel)))
      .map((rel) => path.join(tempDir, ...rel.split('/')))
      .filter((abs) => fs.existsSync(abs));
  }

  // zip：直接从已读到的条目里取字节，不必再解一遍整包。
  if (peekZip === null) return [];
  const entries = peekZip();
  const wanted = new Set(inner);
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isDir) continue;
    const rel = normalizeRel(entry.name);
    if (!wanted.has(rel) && !wanted.has(path.posix.basename(rel))) continue;
    const segments = sanitizeRelSegments(rel);
    if (segments === null) continue;
    const dest = path.join(tempDir, ...segments);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.bytes());
    out.push(dest);
  }
  return out;
}

/** 单一路径的常规导入（不处理套娃）。 */
async function importSingle(
  source: string,
  store: LibraryStore,
  peekZip: (() => ZipEntry[]) | null,
): Promise<ImportOutcome> {
  const kind = detectImportKind(source);
  try {
    switch (kind) {
      case 'epub':
        return {
          source,
          ok: true,
          bookId: await importEpub(source, store, peekZip),
          error: null,
          format: 'epub',
        };
      case 'comic':
        return await importComicCarrier(source, store, peekZip);
      case 'native':
        return await importNativeArchive(source, store);
      case 'directory':
        return {
          source,
          ok: true,
          bookId: await importImageFolder(source, store),
          error: null,
          format: 'comic',
        };
      default:
        return {
          source,
          ok: false,
          bookId: null,
          format: null,
          error: unsupportedMessage(source),
        };
    }
  } catch (error) {
    return {
      source,
      ok: false,
      bookId: null,
      format: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function unsupportedMessage(source: string): string {
  const ext = path.extname(source).toLowerCase();
  if (ext === '') {
    return '看不懂这个路径：既不是支持的电子书/漫画文件，也不是图片文件夹。';
  }
  return `不支持的格式 ${ext}。支持：.epub / .cbz / .zip（内含图片或 OPF）/ .cbr / .rar / .7z / .cb7 / .mokuro / 图片文件夹。`;
}

// ---------------------------------------------------------------------------
// EPUB
// ---------------------------------------------------------------------------

async function importEpub(
  source: string,
  store: LibraryStore,
  peekZip: (() => ZipEntry[]) | null = null,
): Promise<string> {
  // `.zip` 里装 EPUB 时 peekZip 已经在套娃判定里读过包了，直接复用。
  const entries = peekZip ? peekZip() : readZipFile(source);
  const parsed = parseEpub(entries);

  const id = makeBookId();
  const contentDir = bookContentDir(id);
  const dir = bookDir(id);
  try {
    fs.mkdirSync(contentDir, { recursive: true });
    extractEntries(entries, contentDir);
    fs.copyFileSync(source, path.join(dir, 'original.epub'));

    const title = cleanTitle(parsed.title) ?? basenameNoExt(source);
    const record = makeBaseRecord({
      id,
      format: 'epub',
      title,
      author: parsed.author,
      language: parsed.language,
      publisher: parsed.publisher,
      description: parsed.description,
      direction: parsed.direction,
      dir,
    });
    applyEpubParse(record, parsed, contentDir);
    record.pageCount = record.spine?.length ?? 0;

    // 图片型小说：整本都是插图/扫描页 → 显示为小说，但以漫画方式阅读。
    applyImageNovelIfAny(record, parsed, entries, contentDir);

    store.add(record);
    return id;
  } catch (error) {
    rollback(dir);
    throw error;
  }
}

/**
 * 图片型小说：整本都是插图页 → 保持 `format: 'epub'`（书架显示为小说），
 * 但把 `readerMode` 切到 `comic`，进去后走漫画阅读器。
 *
 * 判据在 `core/epub/image-novel.ts`（纯函数、可单测），这里只负责把判定结果落到记录上。
 * **顺序有讲究**：必须在 `record.pageCount` 按 spine 定好之后调用——命中时页数要以
 * `pages.length` 为准，否则阅读器的翻页范围会跟实际页面对不上。
 *
 * 返回是否命中，方便测试和调试时确认「这本书为什么进了漫画阅读器」。
 */
export function applyImageNovelIfAny(
  record: BookRecord,
  parsed: ParsedEpub,
  entries: readonly ZipEntry[],
  contentDir: string,
): boolean {
  const items = contentSpineItems(parsed.spine);
  if (items.length === 0) return false;

  const byHref = new Map<string, ZipEntry>();
  for (const entry of entries) {
    if (!entry.isDir) byHref.set(normalizeRel(entry.name), entry);
  }

  const decoder = new TextDecoder();
  const scans: ChapterScan[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const href = normalizeRel(items[index]!.href);
    // 正文以落盘版本为准（解包时可能已做过路径清洗）；读不到再回退到包内原始条目。
    const local = path.join(contentDir, ...href.split('/'));
    let xhtml: string | null = null;
    try {
      if (fs.existsSync(local)) xhtml = fs.readFileSync(local, 'utf8');
    } catch {
      xhtml = null;
    }
    if (xhtml === null) {
      const entry = byHref.get(href);
      if (!entry) continue;
      xhtml = decoder.decode(entry.bytes());
    }
    scans.push(scanChapter(index, href, xhtml, extractText));
  }

  const verdict = judgeImageNovel(scans);
  if (!verdict.isImageNovel) return false;

  const pages: ComicPage[] = [];
  for (const rel of verdict.pages) {
    // 尺寸只用于给阅读器一个初始宽高比；探不出来就给 0，阅读器按视口兜底。
    let size: { width: number; height: number } = { width: 0, height: 0 };
    try {
      const abs = path.join(contentDir, ...rel.split('/'));
      if (fs.existsSync(abs)) size = probeOrientedImageSize(fs.readFileSync(abs)) ?? size;
    } catch {
      /* 探尺寸失败不该挡导入 */
    }
    pages.push({ url: rel, width: size.width, height: size.height });
  }
  if (pages.length === 0) return false;

  record.readerMode = 'comic';
  record.pages = pages;
  record.pageCount = pages.length;
  // 封面用第一页：EPUB 里常没有规范封面声明，而插图页本身就是封面。
  record.coverRel = record.coverRel ?? pages[0]!.url;
  return true;
}

/** 把解析结果写进记录，并把「指向不存在的封面」清成 null。 */
export function applyEpubParse(record: BookRecord, parsed: ParsedEpub, contentDir: string): void {
  record.spine = parsed.spine;
  record.toc = parsed.toc;
  record.opfRel = parsed.opfRel;
  record.coverRel = existsIn(contentDir, parsed.coverRel) ? parsed.coverRel : null;
}

// ---------------------------------------------------------------------------
// 漫画（压缩包 / .mokuro / 图片文件夹）
// ---------------------------------------------------------------------------

async function importComicCarrier(
  source: string,
  store: LibraryStore,
  peekZip: (() => ZipEntry[]) | null = null,
): Promise<ImportOutcome> {
  const ext = path.extname(source).toLowerCase();
  if (MOKURO_EXTS.has(ext)) {
    return {
      source,
      ok: true,
      bookId: await importMokuroSidecar(source, store),
      error: null,
      format: 'comic',
    };
  }
  if (isComicImage(source)) {
    // 单张图片也当一卷（1 页）处理，比报错友好。
    return { source, ok: true, bookId: await importImageFolder(path.dirname(source), store, [source]), error: null, format: 'comic' };
  }

  const entries = peekZip ? peekZip() : readZipFile(source);
  const files = entries.filter((e) => !e.isDir);
  const pageNames = collectArchivePages(files.map((e) => e.name));
  if (pageNames.length === 0) {
    throw new ImportError('这个压缩包里没有任何图片页。');
  }

  const id = makeBookId();
  const dir = bookDir(id);
  const contentDir = bookContentDir(id);
  try {
    fs.mkdirSync(contentDir, { recursive: true });

    // 只落盘页图 + 可能存在的 mokuro 清单，其他（URL 快捷方式、nfo、txt）一律不写。
    const byNormalized = new Map<string, ZipEntry>();
    for (const entry of files) byNormalized.set(normalizeRel(entry.name), entry);

    const pages: ComicPage[] = [];
    for (const name of pageNames) {
      const entry = byNormalized.get(name);
      if (!entry) continue;
      const segments = sanitizeRelSegments(name);
      if (!segments) continue;
      const dest = path.join(contentDir, ...segments);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const bytes = entry.bytes();
      fs.writeFileSync(dest, bytes);
      const size = probeOrientedImageSize(bytes) ?? { width: 0, height: 0 };
      pages.push({ url: segments.join('/'), width: size.width, height: size.height });
    }
    if (pages.length === 0) throw new ImportError('压缩包里的页图都在非法路径下，已全部跳过。');

    fs.copyFileSync(source, path.join(dir, `original${ext}`));

    // 文字层：包内 `.mokuro` / `manga.json`，或压缩包同级的同名 sidecar。
    const text = loadComicTextLayer(source, files, byNormalized, pages);

    const title = cleanTitle(text.title) ?? basenameNoExt(source);
    const record = makeBaseRecord({
      id,
      format: 'comic',
      title,
      volume: parseVolumeFrom(text.volume),
      direction: importDefaults.direction,
      dir,
    });
    record.pages = pages;
    record.pageCount = pages.length;
    record.coverRel = pages[0]?.url ?? null;
    store.add(record);

    writeJsonAtomic(path.join(contentDir, 'manga.json'), JSON.parse(serializeMangaJson(text.pages, text.ocr)));
    return { source, ok: true, bookId: id, error: null, format: 'comic' };
  } catch (error) {
    rollback(dir);
    throw error;
  }
}

interface ComicTextLayer {
  pages: PageText[];
  title: string | null;
  volume: string | null;
  ocr?: { engine: string; engineSignature: string; schemaVersion: number };
}

// ---------------------------------------------------------------------------
// 原生压缩包（.rar / .cbr / .7z / .cb7 / .cbt）
// ---------------------------------------------------------------------------

/**
 * 走 Rust sidecar 解包。
 *
 * 为什么单独一条路：纯 JS 对 RAR5 / 7z 没有可靠实现（`node-unrar-js` 把整包读进 WASM
 * 线性内存，多 GB 的漫画卷直接爆；`7z-wasm` 同样是全量缓冲）。Rust 侧用官方 UnRAR 源码
 * + 纯 Rust 的 sevenz，可以流式解。
 *
 * 复用现有解码链：解包后**当成一个普通目录**处理——页图用同一套自然序与尺寸探测，
 * 文字层走同一个 `loadComicTextLayer` 之外的解析器（这里文件已经在盘上，直接读）。
 * 如果包里其实是 EPUB（有 `.opf`），也顺带支持：把落盘的文件包装成 `ZipEntry` 列表喂给
 * 现成的 `parseEpub`，不另写一套。
 */
async function importNativeArchive(source: string, store: LibraryStore): Promise<ImportOutcome> {
  let probe;
  try {
    probe = await probeArchive(source);
  } catch (error) {
    // 原生组件缺失是一种**可修复的环境问题**，不是「这个文件坏了」，
    // 所以错误文案必须带上修复办法（NativeUnavailableError 里已经写好了）。
    return {
      source,
      ok: false,
      bookId: null,
      format: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const id = makeBookId();
  const dir = bookDir(id);
  const contentDir = bookContentDir(id);
  try {
    fs.mkdirSync(contentDir, { recursive: true });
    const extracted = await extractArchive(source, contentDir, false);
    if (extracted.extracted.length === 0) {
      throw new ImportError(`${path.basename(source)} 里没有解出任何文件。`);
    }

    const rels = listFilesRecursively(contentDir);

    // --- 包里其实是 EPUB ---
    if (probe.kind === 'epub') {
      const entries = readDirAsZipEntries(contentDir, rels);
      const parsed = parseEpub(entries);
      const title = cleanTitle(parsed.title) ?? basenameNoExt(source);
      const record = makeBaseRecord({
        id,
        format: 'epub',
        title,
        author: parsed.author,
        language: parsed.language,
        publisher: parsed.publisher,
        description: parsed.description,
        direction: parsed.direction,
        dir,
      });
      applyEpubParse(record, parsed, contentDir);
      record.pageCount = record.spine?.length ?? 0;
      if (record.pageCount === 0) throw new ImportError('压缩包里的 EPUB 没有可读章节。');
      copyOriginal(source, dir);
      store.add(record);
      return { source, ok: true, bookId: id, error: null, format: 'epub' };
    }

    // --- 漫画 ---
    // 用 `collectArchivePages` 而不是裸的扩展名过滤：它同时剔掉 macOS 资源叉
    // （`._*`）与 `__MACOSX/`。那些条目**能通过扩展名判定**（`._p001.png` 的扩展名
    // 就是 `.png`），不过滤就会在书里多出「幽灵页」——实测 macOS `bsdtar` 打的 `.cbt`
    // 里真的有它们。
    const pageRels = collectArchivePages(rels);
    if (pageRels.length === 0) throw new ImportError('这个压缩包里没有任何图片页。');

    const pages: ComicPage[] = [];
    for (const rel of pageRels) {
      const abs = path.join(contentDir, ...rel.split('/'));
      let bytes: Uint8Array;
      try {
        bytes = fs.readFileSync(abs);
      } catch {
        continue;
      }
      const size = probeOrientedImageSize(bytes) ?? { width: 0, height: 0 };
      pages.push({ url: rel, width: size.width, height: size.height });
    }
    if (pages.length === 0) throw new ImportError('压缩包里的页图都读不出来。');

    const text = loadDiskComicTextLayer(contentDir, rels, pages, source);

    const title = cleanTitle(text.title) ?? basenameNoExt(source);
    const record = makeBaseRecord({
      id,
      format: 'comic',
      title,
      volume: parseVolumeFrom(text.volume),
      direction: importDefaults.direction,
      dir,
    });
    record.pages = pages;
    record.pageCount = pages.length;
    record.coverRel = pages[0]?.url ?? null;
    store.add(record);

    writeJsonAtomic(
      path.join(contentDir, 'manga.json'),
      JSON.parse(serializeMangaJson(text.pages)),
    );
    copyOriginal(source, dir);
    return { source, ok: true, bookId: id, error: null, format: 'comic' };
  } catch (error) {
    rollback(dir);
    return {
      source,
      ok: false,
      bookId: null,
      format: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 递归列出 `root` 下所有文件，返回正斜杠相对路径（自然序）。 */
function listFilesRecursively(root: string, maxDepth = 8): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
      } else if (entry.isFile()) {
        out.push(normalizeRel(path.relative(root, full)));
      }
    }
  };
  walk(root, 0);
  return out.sort(naturalCompare);
}

/** 把落盘的目录包装成 `ZipEntry[]`，好让现有的 `parseEpub` 直接复用。 */
function readDirAsZipEntries(root: string, rels: readonly string[]): ZipEntry[] {
  return rels.map((rel) => {
    const abs = path.join(root, ...rel.split('/'));
    return {
      name: rel,
      rawName: rel,
      isDir: false,
      bytes: () => fs.readFileSync(abs),
      text: () => fs.readFileSync(abs, 'utf8'),
    };
  });
}

/**
 * 从**已落盘**的目录里找文字层。
 *
 * 与压缩包路径（`loadComicTextLayer`）的区别只是数据来源：这里文件已经在 `contentDir`
 * 里了，不需要再解一次。对齐逻辑一致——逐页匹配，对不上就退回空文字层而不是整本失败。
 */
function loadDiskComicTextLayer(
  contentDir: string,
  rels: readonly string[],
  pages: ComicPage[],
  source: string,
): ComicTextLayer {
  const empty: ComicTextLayer = {
    pages: pages.map((p) => emptyPageText(p.url, p.width, p.height)),
    title: null,
    volume: null,
  };

  const mokuroRel = rels.find((rel) => rel.toLowerCase().endsWith('.mokuro'));
  const mangaJsonRel = rels.find((rel) => path.posix.basename(rel) === 'manga.json');
  const sidecarPath = path.join(path.dirname(source), `${basenameNoExt(source)}.mokuro`);

  let parsedPages: PageText[] | null = null;
  let title: string | null = null;
  let volume: string | null = null;

  try {
    if (mokuroRel) {
      const raw = fs.readFileSync(path.join(contentDir, ...mokuroRel.split('/')), 'utf8');
      parsedPages = parseMokuro(raw);
      const top = parseMokuroTopLevel(raw);
      title = top.title;
      volume = top.volume;
    } else if (fs.existsSync(sidecarPath)) {
      const raw = fs.readFileSync(sidecarPath, 'utf8');
      parsedPages = parseMokuro(raw);
      const top = parseMokuroTopLevel(raw);
      title = top.title;
      volume = top.volume;
    } else if (mangaJsonRel) {
      parsedPages = parseMangaJson(fs.readFileSync(path.join(contentDir, ...mangaJsonRel.split('/')), 'utf8'));
    }
  } catch {
    parsedPages = null;
  }

  if (!parsedPages || parsedPages.length === 0) return { ...empty, title, volume };

  const aligned: PageText[] = pages.map((page) => emptyPageText(page.url, page.width, page.height));
  const used = new Set<string>();
  for (const textPage of parsedPages) {
    const target = matchPage(normalizeRel(textPage.url), pages, used);
    if (!target) continue;
    used.add(target.url);
    aligned[pages.indexOf(target)] = { url: target.url, blocks: textPage.blocks };
  }
  return { pages: aligned, title, volume };
}

/** 保留原始压缩包，便于「重新导出 / 换工具打开」。 */
function copyOriginal(source: string, dir: string): void {
  try {
    const ext = path.extname(source).toLowerCase() || '.bin';
    fs.copyFileSync(source, path.join(dir, `original${ext}`));
  } catch {
    // 原包可能是只读挂载/网络盘；拷不动不影响已导入的内容。
  }
}


/**
 * 找一个压缩包的文字层。
 *
 * 匹配顺序（简化版 `resolveMokuroPageRoot`）：包内 `.mokuro` → 包内 `manga.json`
 * → 压缩包同级 `<同名>.mokuro`。找到后再**逐页对齐**：mokuro 的 `img_path` 与实际
 * 成员名先精确匹配，退化为 basename 唯一匹配，再退化为后缀匹配。
 *
 * Fushi 的 BUG-1830 正是「`img_path` 到底相对谁」没解析就硬编码同级目录导致的整卷
 * 报缺图；这里的对齐是**逐页**做的，对不上就退回空文字层而不是整卷失败。
 */
function loadComicTextLayer(
  source: string,
  files: ZipEntry[],
  byNormalized: Map<string, ZipEntry>,
  pages: ComicPage[],
): ComicTextLayer {
  const empty: ComicTextLayer = {
    pages: pages.map((p) => emptyPageText(p.url, p.width, p.height)),
    title: null,
    volume: null,
  };

  const mokuroEntry = files.find((e) => e.name.toLowerCase().endsWith('.mokuro'));
  const mangaJsonEntry = files.find((e) => path.posix.basename(e.name) === 'manga.json');
  const sidecarPath = path.join(path.dirname(source), `${basenameNoExt(source)}.mokuro`);
  const sidecarExists = fs.existsSync(sidecarPath);

  let raw: string | null = null;
  let parsedPages: PageText[] | null = null;
  let title: string | null = null;
  let volume: string | null = null;

  try {
    if (mokuroEntry) {
      raw = mokuroEntry.text();
      parsedPages = parseMokuro(raw);
      const top = parseMokuroTopLevel(raw);
      title = top.title;
      volume = top.volume;
    } else if (sidecarExists) {
      raw = fs.readFileSync(sidecarPath, 'utf8');
      parsedPages = parseMokuro(raw);
      const top = parseMokuroTopLevel(raw);
      title = top.title;
      volume = top.volume;
    } else if (mangaJsonEntry) {
      parsedPages = parseMangaJson(mangaJsonEntry.text());
    }
  } catch {
    // 文字层坏了不能连累整本书：退回空文字层。
    parsedPages = null;
  }

  if (!parsedPages || parsedPages.length === 0) return { ...empty, title, volume };

  // 建立「实际落盘页 → 文字层页」的对齐表。
  const aligned: PageText[] = pages.map((page) => emptyPageText(page.url, page.width, page.height));
  const used = new Set<string>();
  for (const textPage of parsedPages) {
    const wanted = normalizeRel(textPage.url);
    const target = matchPage(wanted, pages, used);
    if (!target) continue;
    used.add(target.url);
    const index = pages.indexOf(target);
    aligned[index] = { url: target.url, blocks: textPage.blocks };
  }
  return { pages: aligned, title, volume };
}

function matchPage(wanted: string, pages: ComicPage[], used: Set<string>): ComicPage | null {
  const available = pages.filter((p) => !used.has(p.url));
  const exact = available.find((p) => p.url === wanted);
  if (exact) return exact;
  const wantedBase = path.posix.basename(wanted).toLowerCase();
  const byBase = available.filter((p) => path.posix.basename(p.url).toLowerCase() === wantedBase);
  if (byBase.length === 1) return byBase[0]!;
  const bySuffix = available.find((p) => p.url.toLowerCase().endsWith(wanted.toLowerCase()));
  return bySuffix ?? null;
}

async function importMokuroSidecar(source: string, store: LibraryStore): Promise<string> {
  const raw = fs.readFileSync(source, 'utf8');
  const parsed = parseMokuro(raw);
  if (parsed.length === 0) throw new ImportError('这个 .mokuro 文件里没有任何页。');
  const top = parseMokuroTopLevel(raw);

  // 图片在 .mokuro 同级目录（同样简化了 Fushi 的两种 img_path 惯例）。
  const sourceDir = path.dirname(source);
  const volumeName = basenameNoExt(source);
  const roots = [sourceDir, path.join(sourceDir, volumeName)];

  const id = makeBookId();
  const dir = bookDir(id);
  const contentDir = bookContentDir(id);
  try {
    fs.mkdirSync(contentDir, { recursive: true });
    const pages: ComicPage[] = [];
    for (const textPage of parsed) {
      const rel = normalizeRel(textPage.url);
      const found = roots
        .map((root) => path.join(root, ...rel.split('/')))
        .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (!found) {
        throw new ImportError(
          `.mokuro 指定的页图找不到：${textPage.url}（已在 ${roots.join(' 与 ')} 下查找）`,
        );
      }
      const segments = sanitizeRelSegments(rel);
      if (!segments) continue;
      const dest = path.join(contentDir, ...segments);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(found, dest);
      const bytes = fs.readFileSync(dest);
      const size = probeOrientedImageSize(bytes) ?? { width: 0, height: 0 };
      pages.push({ url: segments.join('/'), width: size.width, height: size.height });
    }
    fs.copyFileSync(source, path.join(dir, 'original.mokuro'));

    const title = cleanTitle(top.title) ?? volumeName;
    const record = makeBaseRecord({
      id,
      format: 'comic',
      title,
      volume: parseVolumeFrom(top.volume),
      direction: importDefaults.direction,
      dir,
    });
    record.pages = pages;
    record.pageCount = pages.length;
    record.coverRel = pages[0]?.url ?? null;
    store.add(record);

    const aligned = pages.map((page, index) => ({
      ...emptyPageText(page.url, page.width, page.height),
      blocks: parsed[index]?.blocks ?? [],
    }));
    writeJsonAtomic(path.join(contentDir, 'manga.json'), JSON.parse(serializeMangaJson(aligned)));
    return id;
  } catch (error) {
    rollback(dir);
    throw error;
  }
}

async function importImageFolder(
  source: string,
  store: LibraryStore,
  onlyFiles?: string[],
): Promise<string> {
  const roots = onlyFiles ?? collectImagesRecursively(source);
  if (roots.length === 0) throw new ImportError('这个文件夹里没有找到图片。');

  const id = makeBookId();
  const dir = bookDir(id);
  const contentDir = bookContentDir(id);
  try {
    fs.mkdirSync(contentDir, { recursive: true });
    const pages: ComicPage[] = [];
    for (const file of roots) {
      const rel = normalizeRel(path.relative(source, file));
      const segments = sanitizeRelSegments(rel);
      if (!segments) continue;
      const dest = path.join(contentDir, ...segments);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file, dest);
      const size = probeOrientedImageSize(fs.readFileSync(dest)) ?? { width: 0, height: 0 };
      pages.push({ url: segments.join('/'), width: size.width, height: size.height });
    }
    if (pages.length === 0) throw new ImportError('文件夹里的图片都在非法路径下，已全部跳过。');

    // 同名 .mokuro 也认。
    const sidecar = path.join(source, `${path.basename(source)}.mokuro`);
    let title: string | null = null;
    let aligned = pages.map((p) => emptyPageText(p.url, p.width, p.height));
    if (fs.existsSync(sidecar)) {
      try {
        const top = parseMokuroTopLevel(fs.readFileSync(sidecar, 'utf8'));
        title = top.title;
        const parsed = parseMokuro(fs.readFileSync(sidecar, 'utf8'));
        aligned = pages.map((page, index) => ({
          ...emptyPageText(page.url, page.width, page.height),
          blocks: parsed[index]?.blocks ?? [],
        }));
      } catch {
        /* sidecar 坏了就用空文字层 */
      }
    }

    const record = makeBaseRecord({
      id,
      format: 'comic',
      title: cleanTitle(title) ?? (path.basename(source) || 'manga'),
      direction: importDefaults.direction,
      dir,
    });
    record.pages = pages;
    record.pageCount = pages.length;
    record.coverRel = pages[0]?.url ?? null;
    store.add(record);
    writeJsonAtomic(path.join(contentDir, 'manga.json'), JSON.parse(serializeMangaJson(aligned)));
    return id;
  } catch (error) {
    rollback(dir);
    throw error;
  }
}

/** 递归枚举图片，深度上限 6（与 Fushi `kMangaPageScanMaxDepth` 一致），排除 OCR 产物目录。 */
function collectImagesRecursively(root: string, maxDepth = 6): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === MOKURO_OUT_DIR || entry.name.startsWith('.')) continue;
        if (depth < maxDepth) walk(full, depth + 1);
      } else if (entry.isFile() && isComicImage(entry.name)) {
        found.push(full);
      }
    }
  };
  walk(root, 0);
  // 用相对路径自然序，保证「p2 < p10」。
  found.sort((a, b) => naturalCompare(normalizeRel(path.relative(root, a)), normalizeRel(path.relative(root, b))));
  return found;
}

// ---------------------------------------------------------------------------
// 公共小工具
// ---------------------------------------------------------------------------

function extractEntries(entries: ZipEntry[], contentDir: string): void {
  for (const entry of entries) {
    if (entry.isDir) continue;
    const segments = sanitizeRelSegments(entry.name);
    if (!segments) continue; // 含 `..`：zip-slip，直接丢
    const dest = path.join(contentDir, ...segments);
    const resolved = path.resolve(dest);
    if (!resolved.startsWith(path.resolve(contentDir) + path.sep)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.bytes());
  }
}

function existsIn(root: string, rel: string | null): boolean {
  if (!rel) return false;
  try {
    return fs.statSync(path.join(root, ...normalizeRel(rel).split('/'))).isFile();
  } catch {
    return false;
  }
}

function cleanTitle(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function basenameNoExt(file: string): string {
  const base = path.basename(file);
  const ext = path.extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

function parseVolumeFrom(value: string | null): number | null {
  if (!value) return null;
  const match = /(\d+)/.exec(value);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 导入失败的回滚：删掉半成品书目录。与 Fushi `_copyAndInsert` 的 catch 分支同义。 */
function rollback(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不掩盖原始错误 */
  }
}

export { sortPagePaths };
