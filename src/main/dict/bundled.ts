/**
 * **随包内嵌的小词典**：首次启动时自动装上。
 *
 * ## 为什么是这几部、以及为什么不是别的
 *
 * 判断标准只有一条：**「离线可用的价值 ÷ 安装包体积」**。用户永远不该为 1 MB 的东西
 * 做决定，但 22 MB 的 JMdict 就必须让他自己选。
 *
 * 内嵌（`resources/dictionaries/`，共 ~1 MB）：
 * - 青空文庫熟語（878 KB）：16 万条熟语频率。**这是我们唯一能补齐「哪个词更常用」的数据源**，
 *   查「一日」会直接显示 `325 (3935)`。
 * - surasura 擬声語（102 KB）：1422 条拟声拟态语。漫画里全是「ドキドキ」「ふわふわ」，
 *   通用词典经常查不到，这一部正好补这个洞。
 * - 複合語起源（5 KB）：222 条复合词由来。
 *
 * 走扩展下载（几十 MB，让用户自己选）：JMdict 各语言、Jitendex、KANJIDIC、Pixiv/Nico-Pixiv…
 *
 * **不内嵌**：[Kanji] 系列的包是 `kanji_bank`，而我们的导入器只读 `term_bank` /
 * `term_meta_bank`（v1 只做词语查询）。把它塞进包里只会变成一个查不出东西的条目。
 *
 * ## 为什么用「标记文件」而不是「看词典还在不在」
 *
 * 用户完全可以卸载内嵌词典。如果靠「不在就装」，下次启动它会**自己回来**——那是
 * 用户明确删过的东西，绝不能偷偷恢复。标记文件记的是「这批内嵌词典已经提供过」，
 * 与当前装没装无关。
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const BUNDLED_MANIFEST_FILE = 'manifest.json';
/** 记录「已经提供过哪些内嵌词典」。与 `dictionaries/` 同级。 */
export const BUNDLED_MARKER_FILE = 'bundled-installed.json';

export interface BundledDictionaryEntry {
  file: string;
  title: string;
  description: string;
  source: string;
  license: string;
  bytes: number;
  sha256: string;
}

interface Marker {
  /** `file` → 已安装时的 sha256。文件变了（数据更新）会重新导入。 */
  [file: string]: string;
}

/**
 * 列出随包词典。读不到清单就返回空数组 —— 内嵌词典是「锦上添花」，
 * 缺了它应用必须照常启动。
 */
export function listBundledDictionaries(dir: string): BundledDictionaryEntry[] {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, BUNDLED_MANIFEST_FILE), 'utf8'),
    ) as { dictionaries?: unknown };
    if (!Array.isArray(raw.dictionaries)) return [];
    return raw.dictionaries.filter((item): item is BundledDictionaryEntry => {
      if (typeof item !== 'object' || item === null) return false;
      const record = item as Record<string, unknown>;
      return typeof record['file'] === 'string' && typeof record['sha256'] === 'string';
    });
  } catch {
    return [];
  }
}

function readMarker(file: string): Marker {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return {};
    const out: Marker = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export interface InstallBundledResult {
  installed: string[];
  skipped: string[];
  failed: Array<{ file: string; error: string }>;
}

/**
 * 装随包词典。**永不抛**：任何一部装不上都不该挡住应用启动。
 *
 * `root` 是词典目录（`<userData>/dictionaries`），`dir` 是随包目录
 * （`<resources>/dictionaries`）。
 */
export async function installBundledDictionaries(
  dir: string,
  root: string,
  importZip: (zipPath: string) => Promise<{ title: string }>,
): Promise<InstallBundledResult> {
  const result: InstallBundledResult = { installed: [], skipped: [], failed: [] };
  const entries = listBundledDictionaries(dir);
  if (entries.length === 0) return result;

  const markerFile = path.join(root, BUNDLED_MARKER_FILE);
  const marker = readMarker(markerFile);

  for (const entry of entries) {
    const zipPath = path.join(dir, entry.file);
    if (!fs.existsSync(zipPath)) {
      result.failed.push({ file: entry.file, error: '随包词典文件缺失' });
      continue;
    }
    // 装过、且文件没变 → 跳过。用 sha256 而不是「文件在不在」：数据更新后
    // 版本号没变也应该重新导入。
    const digest = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
    if (marker[entry.file] === digest) {
      result.skipped.push(entry.file);
      continue;
    }
    if (digest !== entry.sha256) {
      // 清单与文件对不上：要么打包错了、要么文件被改过。**不装**并如实报出来，
      // 免得用户以为装上了、实际是一份来路不明的东西。
      result.failed.push({ file: entry.file, error: 'sha256 与清单不符，已跳过' });
      continue;
    }
    try {
      await importZip(zipPath);
      marker[entry.file] = digest;
      result.installed.push(entry.title);
    } catch (error) {
      result.failed.push({
        file: entry.file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify(marker, null, 2), 'utf8');
  } catch {
    // 标记写不进去只会导致下次重复导入（importZip 是幂等的，按 title 生成 id），
    // 不值得为一个辅助文件让启动失败。
  }
  return result;
}
