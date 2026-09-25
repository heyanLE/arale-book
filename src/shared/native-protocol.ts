/**
 * `arale-native` 原生 sidecar 的协议（冻结文件）。
 *
 * 为什么要有原生层：`.rar/.cbr`（RAR5）与 `.7z/.cb7` 在纯 JS 里没有可靠实现——
 * `node-unrar-js`/`7z-wasm` 要么格式覆盖不全，要么把整包读进 WASM 线性内存（多 GB 的
 * 漫画卷直接爆）。Rust 侧用 `unrar`（编译官方 UnRAR C++ 源码）+ `sevenz-rust`（纯 Rust）
 * + `zip`，能把解包做成流式、格式正确。
 *
 * **`.zip`/`.cbz` 不走原生层**：fflate 已经够用，不该让一个能用的路径依赖外部二进制。
 *
 * ## 调用约定
 *
 * ```
 * arale-native version
 * arale-native probe   --input <archive>
 * arale-native extract --input <archive> --out <dir> [--images-only]
 * ```
 *
 * - **stdout 永远只输出一个 JSON 对象**（后面跟一个换行）。日志一律走 stderr，
 *   这样 Node 侧可以无脑 `JSON.parse(stdout)`。
 * - 退出码：`0` 成功；`1` 已处理的失败（此时 stdout 仍是合法 JSON 且 `ok:false`）；
 *   `2` 用法错误。这样 Node 侧不需要解析 stderr 文案就能区分失败类型。
 * - 所有路径用**绝对路径**传递；返回的 `rel` 一律是正斜杠相对路径。
 */

/** 压缩包格式。`unknown` 表示认不出来（可能是损坏文件或非压缩包）。 */
export type NativeArchiveFormat = 'zip' | 'rar' | '7z' | 'unknown';

/** 包内容像什么。与 main 侧的导入判定共用同一套语义。 */
export type NativeArchiveKind = 'comic' | 'epub' | 'unknown';

/** `probe` 的返回。 */
export interface NativeProbeResult {
  ok: boolean;
  format: NativeArchiveFormat;
  kind: NativeArchiveKind;
  /** 包内条目总数（不含目录项）。 */
  entryCount: number;
  /** 页图张数。 */
  imageCount: number;
  /**
   * 页图条目名，**已按自然序排好**（`p2 < p10`，与导入器同一套口径）。
   * kind 为 epub 时为空数组。
   */
  pages: string[];
  /**
   * 全部成员名（正斜杠归一化，不含目录项），**最多前 2000 个**。
   *
   * 用来判断「这是一个套娃包」——里面装的是分卷压缩包而不是页图。只看 `pages`
   * 的话，一套分卷会被判成 `unknown` 然后报「没有任何图片页」；而正确行为是把
   * 每个分卷各导入成一本（见 importer 的 `tryImportCollection`）。
   */
  entries: string[];
  /** 是否含 `.opf`（EPUB 的判据）。 */
  hasOpf: boolean;
  /** 失败原因（给人看的）。`ok:false` 时必有。 */
  error?: string;
}

/** `extract` 的返回。 */
export interface NativeExtractResult {
  ok: boolean;
  format: NativeArchiveFormat;
  /** 实际写出的条目。 */
  extracted: Array<{
    /** 包内原始名。 */
    entry: string;
    /** 落盘后的正斜杠相对路径（已 sanitize，可能与 entry 不同）。 */
    rel: string;
    /** 字节数。 */
    bytes: number;
  }>;
  /** 因非页图/非法路径/超限被跳过的条目数。 */
  skipped: number;
  error?: string;
}

/** 支持的扩展名 → 是否需要原生层。`.zip`/`.cbz` 用 fflate，不进这里。 */
export const NATIVE_ONLY_EXTENSIONS = ['.rar', '.cbr', '.7z', '.cb7', '.cbt'] as const;

/** 需要原生层处理的扩展名判定。 */
export function needsNativeExtractor(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return NATIVE_ONLY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
