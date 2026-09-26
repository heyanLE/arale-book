/**
 * 主进程入口。
 *
 * 顺序有硬约束：`registerBookSchemePrivileges()` 必须在 `app.whenReady()` **之前**
 * 调用，否则 `arale://` 不会拿到 standard/secure 权限，阅读器里的相对链接与
 * `@font-face` 会集体失效（且报错信息毫无指向性）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { BrowserWindow, app, shell } from 'electron';

import { APP_WINDOW_TITLE } from '../shared/brand';

import { DictionaryService } from './dict/service';
import { installBundledDictionaries } from './dict/bundled';
import { registerIpc } from './ipc';
import { LibraryStore, PositionStore } from './library/store';
import { installMenu } from './menu';
import { OpenFileQueue, openFilesFromArgv } from './open-files';
import { ExtensionService } from './extensions/service';
import { LlmService } from './llm/service';
import { setImportDefaults } from './library/importer';
import { readAppDefaults } from './settings';
import { OcrService } from './ocr/service';
import { SegmentService } from './segment/service';
import { SystemOcrEngine } from './ocr/providers/system';
import { ExtensionOcrEngine } from './ocr/providers/extension';
import {
  bookContentDir,
  isDev,
  extensionsRoot,
  localOcrRepositoryFile,
  debugOcrEngineDir,
  systemOcrToolDirs,
  bundledDictionariesDir,
  llmSettingsPath,
  preloadPath,
  rendererIndexPath,
  settingsPath,
} from './paths';
import { parseMangaJson } from '../core/comic/mokuro';
import { getChapterContent } from './reader/content';
import { installBookProtocol, registerBookSchemePrivileges } from './reader/protocol';
import { emitEvent } from './events';

registerBookSchemePrivileges();

let mainWindow: BrowserWindow | null = null;
let positions: PositionStore | null = null;

/**
 * 「用 aralebook 打开这些文件」的队列（来源与必要性见 open-files.ts）。
 *
 * 队列必须先于窗口存在：macOS 的 `open-file` 常常在窗口建好之前就到达。
 */
const openFiles = new OpenFileQueue();
openFiles.setSink((paths) => emitEvent('shell:openFiles', { paths }));

// 第二个实例带文件启动时，把文件转给已经开着的那个窗口。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    openFiles.push(openFilesFromArgv(argv));
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  openFiles.push([filePath]);
});

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#f2f2f0',
    show: false,
    title: APP_WINDOW_TITLE,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // 首帧渲染完再显示，避免白屏闪一下——桌面应用的白闪很廉价。
  window.once('ready-to-show', () => window.show());

  // 渲染进程就绪后把攒下来的「用本应用打开」的文件送过去。
  window.webContents.once('did-finish-load', () => openFiles.setReady(true));

  // 外壳自己不允许被导航走；外链一律丢给系统浏览器。
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    // `arale://` 的导航发生在 iframe 内部，不会走到这里；这里只挡外壳窗口。
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url);
    }
  });

  void window.loadFile(rendererIndexPath());
  return window;
}

async function bootstrap(): Promise<void> {
  // 先把默认值灌给导入器：新书的阅读方向要在**第一次导入之前**就位。
  setImportDefaults(readAppDefaults(settingsPath()));
  const store = new LibraryStore();
  store.load();
  positions = new PositionStore();
  positions.load();

  const dict = new DictionaryService();

  // 随包内嵌的小词典（~1 MB）：第一次启动自动装上，之后按标记跳过。
  // **不 await**：装 1 MB 只要几百毫秒，但启动路径上不该有网络/磁盘的不确定项，
  // 而且词典服务本来就是懒加载的，装完广播 `dict:changed` 让界面自己刷新。
  void installBundledDictionaries(
    bundledDictionariesDir(),
    dict.store.dir,
    (zipPath) => dict.store.importZip(zipPath),
  )
    .then((result) => {
      if (result.installed.length > 0) {
        emitEvent('dict:changed', dict.status());
      }
      for (const failure of result.failed) {
        console.warn(`[dict] 内嵌词典 ${failure.file} 未安装：${failure.error}`);
      }
    })
    .catch(() => undefined);
  // OCR 是**可选**能力：两个引擎都只是被构造出来，模型/进程要等用户真的点了识别才动。
  // 扩展：清单 + 下载器。OCR 引擎扩展装到 <userData>/extensions。
  const debugExtensionDir = debugOcrEngineDir();
  const extensions = new ExtensionService({
    root: extensionsRoot(),
    localRepositoryFile: localOcrRepositoryFile(),
    debugExtensionDir,
    preferLocalRepository: debugExtensionDir !== undefined,
    onProgress: (progress) => emitEvent('extensions:progress', progress),
    onChanged: () => emitEvent('extensions:changed', {}),
  });

  const ocr = new OcrService({
    extensionsDir: extensionsRoot(),
    settingsFile: settingsPath(),
    engines: [
      // 系统 OCR 随应用走，零下载。
      // 搜索目录由 paths.ts 给（打包布局 → 开发布局 → cwd），引擎自己挑平台文件名。
      new SystemOcrEngine({ toolDirs: systemOcrToolDirs() }),
      // 扩展引擎（arale_onnx_v1）是下载出来的；应用侧完全不知道它是 Rust 还是别的什么。
      new ExtensionOcrEngine({
        extensionId: 'ocr-arale_onnx_v1',
        engineId: 'arale_onnx_v1',
        extensions,
      }),
    ],
    getBook: (bookId) => store.get(bookId),
    onFinished: () => emitEvent('library:changed', { reason: 'update' }),
  });

  // LLM：给词卡做分析。配置里含 API key，所以走独立的 llm.json。
  const llm = new LlmService({ settingsFile: llmSettingsPath() });

  // 分词：同样是可选能力，同样在后台跑。文本来源按格式分两条。
  const segment = new SegmentService({
    getBook: (bookId) => store.get(bookId),
    dictionary: {
      segment: (text) =>
        dict.segment(text).map((token) => ({
          surface: token.surface,
          baseForm: token.baseForm,
          start: token.start,
          end: token.end,
          matched: token.matched,
        })),
      // 用 getter 而不是快照：词典是在窗口出来之后才在后台载入的，
      // 构造时取一次会永远拿到「0 部词典」。
      get count() {
        return dict.status().dictionaries.filter((item) => item.enabled).length;
      },
      get signature() {
        return dict
          .status()
          .dictionaries.filter((item) => item.enabled)
          .map((item) => `${item.id}:${item.termCount}`)
          .sort()
          .join('|');
      },
      get ready() {
        return dict.ready;
      },
    },
    readComicText: (book) => {
      const pages = book.pages ?? [];
      let parsed: ReturnType<typeof parseMangaJson> = [];
      try {
        parsed = parseMangaJson(fs.readFileSync(path.join(bookContentDir(book.id), 'manga.json'), 'utf8'));
      } catch {
        parsed = [];
      }
      return pages.map((page) => {
        const found = parsed.find((item) => item.url === page.url);
        return { pageUrl: page.url, blocks: (found?.blocks ?? []).map((block) => ({ lines: block.lines })) };
      });
    },
    readChapters: (book) => {
      const spine = book.spine ?? [];
      if (book.format !== 'epub' || spine.length === 0) return [];
      return spine.map((item, index) => {
        let plainText = '';
        try {
          plainText = getChapterContent(book, index).plainText;
        } catch {
          plainText = '';
        }
        const toc = book.toc?.find((entry) => entry.href === item.href);
        return {
          index,
          href: item.href,
          title: toc?.label ?? path.posix.basename(item.href),
          plainText,
        };
      });
    },
    onFinished: () => emitEvent('library:changed', { reason: 'update' }),
  });

  installBookProtocol((bookId) => store.get(bookId));
  registerIpc({ store, positions, dict, ocr, segment, extensions, llm });

  // 命令行里带的文件（Windows/Linux）。此时窗口还没建，队列会先攒着，
  // 等 `did-finish-load` 再派发。
  openFiles.push(openFilesFromArgv(process.argv));

  mainWindow = createWindow();
  installMenu({ getWindow: () => mainWindow });

  // 开发态 Dock 图标：不打进 .app 的时候 macOS 显示的是 Electron 的图标，改图标后
  // 得先打包才看得到。这里直接指向图标素材的导出件，改完 `npm run icon` 重启就生效。
  // 打包后由 electron-builder 的 `build/icon.icns` 负责，这条不参与。
  if (process.platform === 'darwin' && isDev()) {
    const icon = path.join(app.getAppPath(), 'build', 'icon.png');
    try {
      if (fs.existsSync(icon)) app.dock?.setIcon(icon);
    } catch (error) {
      // Dock 图标只是观感，拿不到就安静算了——绝不能因为一张图起不来窗口。
      console.warn(`[main] 设置 Dock 图标失败：${String(error)}`);
    }
  }

  // 词典索引在后台载入，不挡窗口。
  setImmediate(() => {
    void dict.ensureLoaded();
  });

  if (isDev()) {
    // 开发时把渲染进程的 console 转到主进程终端，省得开两个窗口看日志。
    mainWindow.webContents.on('console-message', (_event, level, message, line, source) => {
      if (level >= 2) console.log(`[renderer] ${source}:${line} ${message}`);
    });
  }
}

void app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
  }
});

// 退出前把阅读进度刷盘：PositionStore 是延迟写的，直接退会丢最后 250ms 的位置。
app.on('before-quit', () => {
  try {
    positions?.flush();
  } catch {
    /* 退出路径上不允许再抛 */
  }
});
