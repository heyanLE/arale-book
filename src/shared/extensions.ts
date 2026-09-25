/**
 * **扩展**：可下载安装的能力包（清单 + 下载器）的契约（冻结文件）。
 *
 * ## 为什么需要这一层
 *
 * 有些能力**不该随安装包分发**：
 * - OCR 的 manga-anki 管线是一个 1.6 GB 的 Python 运行时（实测），装进 .app 会让
 *   所有用户都先下 700 MB，而绝大多数人根本不跑 OCR；
 * - 它是 macOS 14+ / Apple Silicon 专用，别的平台装了也没用；
 * - 它有独立的上游与版本节奏，跟着应用一起发版是错配。
 *
 * 所以这些能力做成「应用去网上取一份清单，按需下载、校验、安装」。清单里**必须有
 * sha256**：没有校验的下载器等于让远端决定用户磁盘上跑什么代码。
 *
 * ## 为什么清单在远端，但开发时有一份内置的
 *
 * 清单放远端（GitHub raw）才能不发新版就上新扩展。但同时**随包带一份**：
 * 新装的应用第一次打开就得能用，不能因为 GitHub 不可达就让「扩展」页面一片空白。
 * 内置那份只是回退，顺手也当作离线场景的兜底（与 Fushi 的 `RecommendedDictionary`
 * 静态目录是同一个思路：远端清单是增量，不是唯一真相源）。
 *
 * ## 分层
 *
 * - `ExtensionCatalog`：远端/内置的**可用清单**（"有什么可下"）
 * - `InstalledExtension`：**本机状态**（"装了什么"）
 * - `ExtensionStatus`：两者拼起来给 UI 看的一行
 */

/** 归档格式。目前只用 zip —— 它是唯一三平台都自带解法的格式。 */
export type ExtensionArchive = 'zip';

/** 扩展提供的能力种类。 */
export type ExtensionKind = 'ocr-engine';

/** 支持的操作系统（与 `process.platform` 同口径）。 */
export type ExtensionPlatform = 'darwin' | 'win32' | 'linux';

/** 支持的 CPU 架构（与 `process.arch` 同口径，做一次映射）。 */
export type ExtensionArch = 'arm64' | 'x64';

/** 清单里的一条扩展。 */
export interface ExtensionEntry {
  /** 稳定标识，也是安装目录名。**改它等于换一个扩展**。 */
  id: string;
  /** 给人看的名字。 */
  name: string;
  /** 一句话说明它是什么。 */
  summary: string;
  /** 语义化版本。用于判断「有没有新版」。 */
  version: string;
  kind: ExtensionKind;
  /**
   * 提供的能力标识。对 `ocr-engine` 来说就是 `OcrProviderId`。
   * 应用靠它把扩展接到对应的引擎槽位上。
   */
  provides: string;
  /** 支持的平台。空数组 = 全平台。 */
  platforms: ExtensionPlatform[];
  /** 支持的架构。空数组 = 全架构。 */
  arch: ExtensionArch[];
  /**
   * 下载地址，按顺序回退。**多个是有意的**：上游是 GitHub Releases 时经常
   * 直连超时（本机实测过），配一个镜像能显著提高成功率。
   */
  urls: string[];
  /** 归档字节数，用于显示「要下多大」。 */
  bytes: number;
  /** 归档的 sha256（小写十六进制）。**必填**，空字符串会被拒绝安装。 */
  sha256: string;
  /** 解包后大概占多少字节（显示用）。 */
  installedBytes: number;
  /** 许可标识（如 `MIT`、`GPL-3.0`）。装第三方运行时必须让用户看得到。 */
  license: string;
  /** 主页 / 出处。 */
  homepage: string;
  /** 依赖的其它扩展 id（先装它们）。 */
  requires: string[];
  /** 额外说明（如「需要 macOS 14+」「首次运行会加载 500 MB 模型」）。 */
  notes: string;
}

/** 清单文件。 */
export interface ExtensionCatalog {
  /** 清单格式版本。应用不认的版本会拒绝加载，而不是半懂不懂地解析。 */
  schemaVersion: number;
  /** 生成时间（ISO 8601）。 */
  generatedAt: string;
  extensions: ExtensionEntry[];
}

/** 本机已安装的一条。 */
export interface InstalledExtension {
  id: string;
  /** 安装时的版本。装完之后清单更新了，这个值不变。 */
  version: string;
  installedAt: number;
  /** 安装目录（绝对路径）。 */
  dir: string;
  /** 安装时校验通过的归档 sha256。 */
  sha256: string;
  /** 安装时清单里的字节数（UI 显示「已占用」）。 */
  bytes: number;
}

/** 拼好的状态行，UI 直接渲染。 */
export interface ExtensionStatus {
  entry: ExtensionEntry;
  /** 没装就是 null。 */
  installed: InstalledExtension | null;
  /** 装了但清单里的版本更高。 */
  updateAvailable: boolean;
  /** 当前平台/架构能不能装。 */
  supported: boolean;
  /** 不能装的原因；能装时为 null。 */
  unsupportedReason: string | null;
}

/** 安装进度。 */
export interface ExtensionProgress {
  id: string;
  phase: 'resolving' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'failed';
  /** 已下载字节（`downloading` 阶段有效）。 */
  received: number;
  /** 总字节（清单里的值；未知时为 0）。 */
  total: number;
  /** 给人看的补充说明。 */
  message: string;
}

/** 清单里每条扩展**解包后必须存在**的自描述文件。 */
export const EXTENSION_MANIFEST_FILE = 'extension.json';

/**
 * 扩展自描述（归档内的 `extension.json`）。
 *
 * 为什么归档里还要再写一份、而不是只信远端清单：解包之后应用要**照着它**去启动
 * runner，而远端清单不该携带「怎么运行」这种可执行信息——那等于让远端清单直接决定
 * 在本机跑什么命令。runner 的路径与参数由**归档自己**声明，安装时校验它落在
 * 安装目录内，这样清单被篡改也无法指向系统别处的可执行文件。
 */
export interface ExtensionManifest {
  id: string;
  version: string;
  kind: ExtensionKind;
  provides: string;
  /**
   * 能力自描述。`ocr-engine` 用它填 `OcrEngineStatus`。
   */
  engine?: {
    label: string;
    /** 这个引擎需要什么（一行说明，显示在选项下面）。 */
    requirement: string;
    /** 首次运行大概要下多少 MB（随扩展一起下时为 0）。 */
    downloadSizeMb: number;
  };
  /**
   * 怎么跑。路径**相对扩展目录**，安装时校验不含 `..` 也不指向目录外。
   */
  runner?: {
    /** 可执行文件（相对路径）。 */
    program: string;
    /** 固定参数。`{pagesFile}` 会被替换成页清单文件的路径。 */
    args: string[];
    /** 需要哪些额外的运行环境变量。 */
    env?: Record<string, string>;
  };
  license?: string;
  homepage?: string;
}
