/**
 * **扩展**：可下载安装的能力包（JSONL 仓库 + 下载器）的契约（冻结文件）。
 *
 * ## 为什么需要这一层
 *
 * 有些能力**不该随安装包分发**：
 * - OCR 引擎是一个自带运行时与模型的归档（实测 ≈170 MB），装进 .app 会让
 *   所有用户都先下 700 MB，而绝大多数人根本不跑 OCR；
 * - 它是 macOS 14+ / Apple Silicon 专用，别的平台装了也没用；
 * - 它有独立的上游与版本节奏，跟着应用一起发版是错配。
 *
 * 所以这些能力做成「应用去网上取一份清单，按需下载、校验、安装」。清单里**必须有
 * sha256**：没有校验的下载器等于让远端决定用户磁盘上跑什么代码。
 *
 * ## 为什么仓库在远端，但包内有一份索引
 *
 * JSONL 仓库放远端（GitHub raw）才能不发新版就上新扩展。但同时从 submodule **随包带一份**：
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

/** 一个远端 OCR 引擎仓库（HTTPS JSONL 文件）。 */
export interface OcrRepository { name: string; url: string }

/** 支持的操作系统（与 `process.platform` 同口径）。 */
export type ExtensionPlatform = 'darwin' | 'win32' | 'linux';

/** 支持的 CPU 架构（与 `process.arch` 同口径，做一次映射）。 */
export type ExtensionArch = 'arm64' | 'x64';

/**
 * 一个平台归档：包名 + 校验信息。
 *
 * 校验信息跟着**包**走而不是跟着条目走，因为同一个 release 里 mac 与 win 是两个不同的
 * 归档、sha256 与体积都不同（这是「一个 release 传两个包」的必然结果）。
 */
export interface ExtensionAsset {
  /** 资产文件名，如 `arale_onnx_v1-macos-arm64.zip`。只能是文件名，不能带路径。 */
  asset: string;
  /** 这个包的 sha256（小写十六进制）。空字符串 = 尚未发布，安装会被拒绝。 */
  sha256: string;
  /** 这个包的字节数（显示「要下多大」）。 */
  bytes: number;
  /** 解包后大概占多少（显示用）。缺省沿用条目顶层的 `installedBytes`。 */
  installedBytes?: number;
}

/**
 * 归档放在**哪个 release、哪个包**里。
 *
 * 清单不写完整 URL 而是写这三件事，理由：GitHub Releases 的地址格式是死的
 * （`https://github.com/<repo>/releases/download/<tag>/<asset>`），把它**拼**出来比让清单
 * 自己写 URL 更不容易错——换 owner、换 release 名只改一个字段，也不会出现
 * 「清单里指向一个不存在的组织」这种只有到用户点安装时才会暴露的错误。
 *
 * 一个 release 可以同时放两个平台的包（mac + win），两条清单条目共用同一个 `tag`、
 * 只有 `asset` 不同——这正是「按平台传两个包」的表达方式。
 */
export interface ExtensionRelease {
  /** `owner/repo`，如 `heyanLE/arale-book-ocr-manga`。 */
  repo: string;
  /** release 名（GitHub 上是 tag 名），如 `v0.1.0`。 */
  tag: string;
  /**
   * 按 `<platform>-<arch>` 给平台包（`darwin-arm64` / `win32-x64` / `linux-x64`…）。
   *
   * **一个能力一条清单条目**（id 是安装身份，重复 id 会让整份清单作废），
   * 平台差异放在这里——这正是「同一个 release 里传 mac 与 win 两个包」的表达方式。
   */
  assets: Record<string, ExtensionAsset>;
}

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
  /** macOS 主版本下限；缺省不限制。 */
  minMacOS?: number;
  /**
   * 归档放在哪个 release 的哪个包里。**与 `urls` 二选一**（见 [downloadUrlsOf]）。
   * 两条都给时 `urls` 优先（用来配镜像）。
   */
  release?: ExtensionRelease;
  /**
   * 下载地址，按顺序回退。**多个是有意的**：上游是 GitHub Releases 时经常
   * 直连超时（本机实测过），配一个镜像能显著提高成功率。
   *
   * 能从 `release` 拼出来时这里就留空——别把同一个地址写两遍。
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
  /** 从 submodule 开发目录直接加载，不能在应用中卸载。 */
  local?: boolean;
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

// ---------------------------------------------------------------------------
// 地址：清单只写「哪个 release 的哪个包」，URL 在这里拼（纯函数，可单测）
// ---------------------------------------------------------------------------

/** 平台键：`darwin-arm64` / `win32-x64` / `linux-x64`。与 `process.platform`+`process.arch` 同口径。 */
export function platformKey(platform: string, arch: string): string {
  return `${platform}-${arch}`;
}

/** GitHub Release 资产的固定地址格式。 */
export function releaseAssetUrl(repo: string, tag: string, asset: string): string {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
}

/** 最终去哪下、下下来的东西应该长什么样。 */
export interface ResolvedDownload {
  /** 按顺序回退的地址；空数组 = 清单里根本没给这个平台的地址。 */
  urls: string[];
  /** 期望的 sha256（空字符串 = 未发布，安装会被拒绝）。 */
  sha256: string;
  bytes: number;
  installedBytes: number;
  /** 地址是从哪儿来的（UI 显示出处用）。 */
  source: 'release' | 'urls' | 'none';
}

/**
 * 解析「这个平台到底下哪个包」。
 *
 * 规则（**顺序是刻意的**）：
 * 1. `release.assets[<platform>-<arch>]` 命中 → 用它的 asset 拼地址、用它自己的 sha256/bytes；
 * 2. 没命中 → 退回条目顶层的 `urls` + `sha256` + `bytes`（单平台归档、或自建镜像）；
 * 3. 都没有 → 地址为空，调用方明确报错（而不是拿去下载一个 undefined）。
 *
 * 为什么 `urls` 不能盖过 release：`urls` 是「镜像/自建源」这类**显式**配置，而 release 是
 * 默认分发路径。两者都给时，镜像应当**排在前**但仍带上 release 的校验值——所以这里
 * 采用「有 urls 就先用 urls，校验值仍取 release.assets 里的」的组合。
 */
export function resolveDownload(
  entry: Pick<ExtensionEntry, 'urls' | 'release' | 'sha256' | 'bytes' | 'installedBytes'>,
  platform: string,
  arch: string,
): ResolvedDownload {
  const asset = entry.release?.assets?.[platformKey(platform, arch)];
  const fromRelease =
    entry.release !== undefined && asset !== undefined
      ? [releaseAssetUrl(entry.release.repo, entry.release.tag, asset.asset)]
      : [];
  const urls = [...entry.urls, ...fromRelease];
  const sha256 = asset?.sha256 ?? entry.sha256;
  const bytes = asset?.bytes ?? entry.bytes;
  return {
    urls,
    sha256,
    bytes,
    installedBytes: asset?.installedBytes ?? entry.installedBytes,
    source: urls.length === 0 ? 'none' : entry.urls.length > 0 ? 'urls' : 'release',
  };
}

/** 给人看的一句话出处（UI 用）。 */
export function describeRelease(
  release: ExtensionRelease | undefined,
  platform: string,
  arch: string,
): string {
  if (release === undefined) return '';
  const asset = release.assets?.[platformKey(platform, arch)];
  return asset === undefined
    ? `${release.repo} ${release.tag}`
    : `${release.repo} ${release.tag} · ${asset.asset}`;
}
