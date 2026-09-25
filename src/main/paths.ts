/**
 * 应用数据目录布局（唯一定义处）。
 *
 * ```
 * <userData>/
 *   library/
 *     index.json                 ← 全部书的元数据（原子写；全书库的真相源）
 *     <bookId>/
 *       content/                 ← 阅读器唯一可访问的目录（arale:// 的根）
 *         ...EPUB 解包后的原样目录树，或漫画页图
 *         manga.json             ← 漫画文字层（mokuro 兼容格式）
 *       original.epub|.cbz       ← 原始文件，保留以便重新导入/导出
 *   dictionaries/
 *     <dictId>/meta.json, terms.json, freq.json
 *   positions.json               ← 阅读进度
 *   settings.json                ← 主进程侧设置（渲染进程的 UI 偏好走 localStorage）
 * ```
 *
 * 为什么每本书只有 content/ 一个可读根：`arale://<id>/<rel>` 的路径校验可以退化成
 * 「解析后是否仍在 <id>/content/ 内」这一句，不用按格式分支，也不会因为漫画/小说
 * 布局不同而各留一个穿越口子。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** `<userData>` 根。测试里可以通过 `setUserDataRootForTesting` 换掉。 */
let userDataRoot: string | null = null;

function root(): string {
  if (userDataRoot) return userDataRoot;
  // **延迟 require**（不是顶层 import）：让 `main/library/*` 这些模块能在纯 Node 测试
  // 里被 import，而不必先把整个 Electron 拖进来。顶层 `import { app } from 'electron'`
  // 在缺少 `node_modules/electron/dist` 的环境（只跑单测的机器）会直接抛。
  const electron = require('electron') as typeof import('electron');
  return electron.app.getPath('userData');
}

/** 测试专用：把数据根指到临时目录，避免污染真实 userData。 */
export function setUserDataRootForTesting(dir: string | null): void {
  userDataRoot = dir;
}

export function libraryRoot(): string {
  return path.join(root(), 'library');
}

export function libraryIndexPath(): string {
  return path.join(libraryRoot(), 'index.json');
}

export function bookDir(bookId: string): string {
  return path.join(libraryRoot(), bookId);
}

/** 阅读器的唯一可访问根。 */
export function bookContentDir(bookId: string): string {
  return path.join(bookDir(bookId), 'content');
}

export function dictionaryRoot(): string {
  return path.join(root(), 'dictionaries');
}

/**
 * 扩展安装目录。
 *
 * 放在应用自己的数据目录下，而不是库默认的缓存位置（`~/.cache`、`~/Library/Caches`）：
 * 那些目录会被系统或清理工具删掉，而扩展是用户**明确下载过**的几百 MB 内容，
 * 被顺手清掉是最恼人的失败方式。也让它跟随应用的数据根——用户换数据目录时，
 * 「装了什么扩展」跟着一起走。
 */
export function extensionsRoot(): string {
  return path.join(root(), 'extensions');
}

export function positionsPath(): string {
  return path.join(root(), 'positions.json');
}

/**
 * LLM 配置（含 API key）。
 *
 * 单独一个文件而不是并进 `settings.json`：里面有密钥，单独放便于用户自己检查/备份/删除，
 * 「把设置恢复默认」也不该顺手把密钥清掉。
 */
export function llmSettingsPath(): string {
  return path.join(root(), 'llm.json');
}

export function settingsPath(): string {
  return path.join(root(), 'settings.json');
}

/** 渲染进程产物目录（`dist/renderer`），dev 与 prod 都是同一个相对布局。 */
export function rendererIndexPath(): string {
  return path.join(__dirname, '..', 'renderer', 'index.html');
}

export function preloadPath(): string {
  return path.join(__dirname, '..', 'preload', 'index.js');
}

export function isDev(): boolean {
  const electron = require('electron') as typeof import('electron');
  return !electron.app.isPackaged;
}

/**
 * 随包资源的搜索目录。
 *
 * 打包与开发两种布局都要能找到东西，而 `process.resourcesPath` 在**开发态指向的是
 * Electron 自己的 .app**（`node_modules/electron/dist/Electron.app/Contents/Resources`），
 * 不是本仓库——照它拼路径会永远找不到文件，而且失败得很安静：扩展清单读成空、
 * 系统 OCR 判成「组件缺失」。所以这里给出候选列表，取第一个真的存在的。
 *
 * 顺序与 `native/sidecar.ts` 的 `resolveNativeBinary()` 保持同一套思路：环境变量 →
 * 打包布局 → 开发布局 → cwd 兜底。三处各写一份搜索逻辑迟早会漂移。
 */
function resourceDirs(): string[] {
  return [
    process.env['ARALE_RESOURCES_DIR'] ?? '',
    // 打包后：<App>.app/Contents/Resources
    process.resourcesPath ?? '',
    // 开发态：dist/main/paths.js → 仓库根
    path.join(__dirname, '..', '..'),
    process.cwd(),
  ].filter((dir) => dir !== '');
}

/** 在候选目录里找一个存在的文件/目录；找不到返回 null。 */
function findResource(relative: string): string | null {
  for (const dir of resourceDirs()) {
    const candidate = path.join(dir, relative);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

/**
 * 随包带的扩展清单（远端拉不到时的回退，也是新装应用的第一次体验）。
 *
 * 找不到时返回一个**不存在的路径**而不是 null：调用方（`ExtensionService`）已经
 * 会处理「读不到清单」，多一种空值形态只会让那条路径多一个分支。
 */
export function bundledExtensionsCatalog(): string {
  return (
    findResource(path.join('resources', 'extensions', 'catalog.json')) ??
    findResource(path.join('extensions', 'catalog.json')) ??
    path.join(process.resourcesPath ?? '', 'extensions', 'catalog.json')
  );
}

/**
 * 随包内嵌词典目录（`resources/dictionaries`）。
 *
 * 找不到时返回一个不存在的路径：调用方（`installBundledDictionaries`）本来就会处理
 * 「清单读不到」，多一种空值形态只会让那条路径多一个分支。
 */
export function bundledDictionariesDir(): string {
  return (
    findResource(path.join('resources', 'dictionaries')) ??
    findResource(path.join('dictionaries')) ??
    path.join(process.resourcesPath ?? '', 'dictionaries')
  );
}

/**
 * 系统 OCR 小工具的候选目录，按顺序找。
 *
 * 交给引擎而不是在这里定死：引擎才知道自己那个平台的文件名是什么
 * （`arale-vision-ocr` / `arale-winrt-ocr.ps1`）。
 */
export function systemOcrToolDirs(): string[] {
  return [
    path.join(process.resourcesPath ?? '', 'native'),
    path.join(__dirname, '..', '..', 'native'),
    path.join(process.cwd(), 'native'),
    // 开发时 `npm run build:vision-ocr` 的产物在源目录里，不在 target/ 之类的地方。
    path.join(__dirname, '..', '..', 'native', 'arale-vision-ocr'),
  ].filter((dir) => dir !== '');
}
