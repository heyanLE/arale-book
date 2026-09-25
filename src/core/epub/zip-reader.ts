/**
 * ZIP 读取薄封装 —— EPUB 与 CBZ 共用（`fflate` 同步解压）。
 *
 * 只有一个职责：把解压结果变成一组**名字已经归一化**的 `ZipEntry`。归一化集中在
 * 这一个边界上完成，是 Fushi BUG-2484 / BUG-1221 的修复口径：压缩包成员名只在
 * 这里 percent-解码**一次**。下游（OPF / 图片 / 章节查找）拿到的都是已解码路径；
 * 一旦在别处再解一次，`%2525` 这种名字会被二次解码成 `%25`，与 producer 的原始
 * 文件名不再相等，表现就是「文件明明在包里却找不到」。
 *
 * 另一个边界职责是**跳过垃圾**：目录项、`__MACOSX/`、`._` 资源叉文件。它们是
 * macOS 打包/解包留下的噪音，混进成员表只会让「第一个 *.opf」之类的回落扫描抓错
 * 东西。
 */
import * as fs from 'node:fs';
import { strToU8, unzipSync, zipSync } from 'fflate';

/** 压缩包读不开（截断 / 中央目录损坏 / 根本不是 zip）时抛这个。 */
export class ZipReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipReadError';
  }
}

/**
 * 一个已解压的成员。
 *
 * `name` 已归一化（反斜杠→正斜杠、去前导 `/`、percent-解码一次）；`rawName` 保留
 * zip 里的原始拼写，只用于诊断（报错文案里给用户看真实成员名）。目录项在
 * `openZip` 里就被丢掉了，所以正常拿到的 `isDir` 恒为 false —— 字段保留是为了
 * 接口完整与将来可能的目录语义。
 */
export interface ZipEntry {
  name: string;
  rawName: string;
  isDir: boolean;
  bytes(): Uint8Array;
  text(): string;
}

/** 归一化成员名：反斜杠→正斜杠 → 去前导 `/` → percent-解码一次。 */
function normalizeEntryName(raw: string): string {
  const forward = raw.replace(/\\/g, '/');
  const stripped = forward.startsWith('/') ? forward.slice(1) : forward;
  // 非法转义（例如文件名里本来就有裸 `%`，或 `100%.jpg`）时 decodeURIComponent
  // 会抛，此时原样返回——绝不能因此丢掉一个成员。
  try {
    return decodeURIComponent(stripped);
  } catch {
    return stripped;
  }
}

/** 是否是必须跳过的垃圾成员（macOS 资源叉 / 元数据目录）。 */
function isJunkEntry(name: string): boolean {
  const segments = name.split('/');
  if (segments.includes('__MACOSX')) return true;
  const base = segments[segments.length - 1] ?? '';
  return base.startsWith('._') || base === '.DS_Store';
}

function decodeUtf8(data: Uint8Array): string {
  // 容错解码：非法字节变 U+FFFD 而不是抛错（与 Fushi decodeEpubText 同口径，
  // epub_book.dart 的阅读侧同样从不因编码抛错）。
  const text = new TextDecoder('utf-8').decode(data);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function makeEntry(name: string, rawName: string, data: Uint8Array): ZipEntry {
  let cached: string | null = null;
  return {
    name,
    rawName,
    isDir: false,
    bytes: () => data,
    text: () => {
      if (cached === null) cached = decodeUtf8(data);
      return cached;
    },
  };
}

/**
 * 解压内存里的 zip 字节。
 *
 * `unzipSync` 在部分真实 EPUB 上会抛（中央目录损坏但局部头可读）。这里捕获后换成
 * 带 **zip 体积** 的 `ZipReadError`：体积是判断「下载被截断」还是「打包器写坏」的
 * 第一手线索，原样透传 fflate 的 `invalid zip data` 则什么也诊断不出来。
 */
export function openZip(bytes: Uint8Array): ZipEntry[] {
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(bytes);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ZipReadError(`无法解压 ZIP（体积 ${bytes.byteLength} 字节）：${reason}`);
  }

  const names = Object.keys(raw);
  const entries: ZipEntry[] = [];
  for (const rawName of names) {
    if (rawName.endsWith('/') || rawName.endsWith('\\')) continue; // 目录项
    const name = normalizeEntryName(rawName);
    if (name === '' || isJunkEntry(name)) continue;
    const data = raw[rawName];
    if (data === undefined) continue;
    // 有些打包器写「零字节、无尾斜杠」的目录项。Fushi epub_parser.dart:249-257
    // 的判据：一个零字节成员若同时是别的成员的父路径，它就是目录，不是文件。
    if (data.byteLength === 0 && names.some((other) => other !== rawName && other.startsWith(name + '/'))) {
      continue;
    }
    entries.push(makeEntry(name, rawName, data));
  }
  return entries;
}

/** 从磁盘路径读 zip。IO 失败也统一包成 `ZipReadError`，调用方只需捕一种错。 */
export function readZipFile(filePath: string): ZipEntry[] {
  let bytes: Uint8Array;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ZipReadError(`无法读取文件 ${filePath}：${reason}`);
  }
  return openZip(bytes);
}

/**
 * 用一堆成员名→内容造一个 zip（**测试专用**）。
 * 值传 `string` 时按 UTF-8 编码；目录项用 `'dir/'` 作键即可。
 */
export function makeZip(entries: Record<string, Uint8Array | string>): Uint8Array {
  const input: Record<string, Uint8Array> = {};
  for (const name of Object.keys(entries)) {
    const value = entries[name];
    if (value === undefined) continue;
    input[name] = typeof value === 'string' ? strToU8(value) : value;
  }
  return zipSync(input);
}

/**
 * 按相对路径找成员：**精确匹配优先**，失配再走一次大小写不敏感匹配。
 *
 * 大小写回落是必需的：真实 EPUB 里 `META-INF/container.xml` 被打包/解包工具统一
 * 小写成 `meta-inf/container.xml` 是常见事故，Fushi epub_parser.dart:336-347 就是
 * 靠这条兜底救回整本书（TODO-739 记录了把 `META-INF` 写成 `meta-inf` 后大小写
 * 敏感的对端直接读不到）。精确匹配优先保证「包里两套大小写都在」时不会选错。
 */
export function findEntry(entries: ZipEntry[], relPath: string): ZipEntry | null {
  const wanted = relPath
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
  for (const entry of entries) {
    if (entry.name === wanted) return entry;
  }
  const lower = wanted.toLowerCase();
  for (const entry of entries) {
    if (entry.name.toLowerCase() === lower) return entry;
  }
  return null;
}
