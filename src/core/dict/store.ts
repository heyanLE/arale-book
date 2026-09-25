/**
 * DictionaryStore —— 词典子系统的唯一入口（Electron 主进程只认这一个类）。
 *
 * 生命周期约定（很重要，UI 依赖它）：
 * - `lookup`/`segment` 是**同步**的，且在 `load()` 完成前也必须能用（返回空结果），
 *   绝不抛异常、绝不阻塞 —— 主进程的 IPC handler 是同步调用的，抛出去就是整个查询链路崩。
 * - `load()` 幂等：重复调用只是重建索引；索引整个换掉再赋值，所以并发查询不会读到半个索引。
 * - 索引全在内存（Map），查询是纯 CPU 的同步操作；几万到几十万词条量级没问题。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { DictionaryInfo, DictionaryStatus, LookupResult, SegmentToken } from '../../shared/types';
import { readJson, writeJsonAtomic } from '../util/atomic-json';
import { makeDictId } from '../util/id';
import { byNaturalOrder } from '../util/natural-sort';
import { resolveInside } from '../util/paths';
import { lookup, segment, type LookupOptions } from './lookup';
import { emptyTermIndex, importYomitanZip, loadTermIndex, type TermIndex } from './yomitan';

const META_FILE = 'meta.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验 meta.json 的最小形状；坏文件当不存在（不修、不猜）。 */
function toDictionaryInfo(value: unknown): DictionaryInfo | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const title = value['title'];
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof title !== 'string' || title.length === 0) return null;
  return {
    id,
    title,
    format: 'yomitan',
    termCount: typeof value['termCount'] === 'number' ? value['termCount'] : 0,
    freqCount: typeof value['freqCount'] === 'number' ? value['freqCount'] : 0,
    importedAt: typeof value['importedAt'] === 'number' ? value['importedAt'] : 0,
    enabled: value['enabled'] !== false,
  };
}

export class DictionaryStore {
  readonly dir: string;

  private index: TermIndex = emptyTermIndex();
  private loaded = false;

  constructor(dictRootDir: string) {
    this.dir = dictRootDir;
  }

  /** 读所有 `<dir>/<id>/meta.json`；**不**加载词条索引（管理页要秒开）。 */
  list(): DictionaryInfo[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: DictionaryInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const info = toDictionaryInfo(readJson<unknown>(path.join(this.dir, entry.name, META_FILE), null));
      if (info !== null) out.push(info);
    }
    // 顺序确定性：同 title 时用 id 兜底（byNaturalOrder 只比 title）。
    return out.sort((a, b) => byNaturalOrder<DictionaryInfo>((dict) => dict.title)(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  status(): DictionaryStatus {
    const dictionaries = this.list();
    let termCount = 0;
    for (const dict of dictionaries) if (dict.enabled) termCount += dict.termCount;
    return { dir: this.dir, dictionaries, termCount, loaded: this.loaded };
  }

  /** 载入（或重载）所有启用词典；幂等。 */
  async load(): Promise<DictionaryStatus> {
    const enabled = this.list().filter((dict) => dict.enabled);
    // 先建好离屏索引再整体换掉：并发查询永远看到完整的旧索引或完整的新索引。
    const next = loadTermIndex(this.dir, enabled);
    this.index = next;
    this.loaded = true;
    return this.status();
  }

  /** 导入一个 Yomitan zip；成功后立即重载索引，保证新词典马上可查。 */
  async importZip(zipPath: string): Promise<DictionaryInfo> {
    const dictId = makeDictId();
    const result = await importYomitanZip(zipPath, this.dir, dictId);
    await this.load();
    return result.info;
  }

  /** 删除一本词典（目录一起删），然后重载索引。 */
  async remove(dictId: string): Promise<DictionaryStatus> {
    const target = resolveInside(this.dir, dictId);
    if (target !== null) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch (error) {
        // 中文注释：删目录失败（Windows 上文件被占用很常见）不能让状态接口抛，
        // 否则管理页整页打不开；重载后这本词典还在列表里，用户会看到它没被删掉。
        console.warn(`[dict] 删除词典失败 ${dictId}: ${String(error)}`);
      }
    }
    this.index = emptyTermIndex();
    this.loaded = false;
    return this.load();
  }

  /** 启用/禁用一本词典（写 meta.json 后重载索引）。 */
  async setEnabled(dictId: string, enabled: boolean): Promise<DictionaryStatus> {
    const metaPath = resolveInside(this.dir, path.join(dictId, META_FILE));
    if (metaPath !== null) {
      const info = toDictionaryInfo(readJson<unknown>(metaPath, null));
      if (info !== null) writeJsonAtomic(metaPath, { ...info, enabled });
    }
    this.index = emptyTermIndex();
    this.loaded = false;
    return this.load();
  }

  /** 点击位置查询。`charOffset` 是 UTF-16 偏移；默认 0。 */
  lookup(text: string, charOffset = 0, options?: LookupOptions): LookupResult {
    if (!this.loaded) return lookup(text, charOffset, emptyTermIndex(), options);
    return lookup(text, charOffset, this.index, options);
  }

  segment(text: string, options?: LookupOptions): SegmentToken[] {
    if (!this.loaded) return segment(text, emptyTermIndex(), options);
    return segment(text, this.index, options);
  }

  /** true 表示 `load()` 已完成且至少有一本启用词典。 */
  get ready(): boolean {
    return this.loaded && this.index.dictionaries.length > 0;
  }
}
