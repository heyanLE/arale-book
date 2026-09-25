/**
 * 词典服务：包住 core 里的 `DictionaryStore`，加两件事——
 * 1. **懒加载**：词条索引可能有几十万条、上百 MB JSON，绝不能卡住窗口创建。启动后
 *    在后台 `setImmediate` 里载入，载入完成再广播 `dict:changed`。
 * 2. **不阻塞查询**：索引没就绪时查询返回空结果（`dictionaryCount` 如实反映），
 *    UI 显示「词典载入中」。永远不要为了等一下就把渲染进程的 IPC 挂起。
 */

import type { DictionaryStatus, LookupResult, SegmentToken } from '../../shared/types';
import { DictionaryStore } from '../../core/dict/store';
import { dictionaryRoot } from '../paths';

export class DictionaryService {
  readonly store: DictionaryStore;
  private loading: Promise<DictionaryStatus> | null = null;

  constructor(root: string = dictionaryRoot()) {
    this.store = new DictionaryStore(root);
  }

  /** 同步状态：只读 meta.json，很轻。 */
  status(): DictionaryStatus {
    return this.store.status();
  }

  /** 幂等地触发后台载入；已有载入在跑就复用同一个 promise。 */
  ensureLoaded(): Promise<DictionaryStatus> {
    const inFlight = this.loading;
    if (inFlight) return inFlight;
    const started = this.store
      .load()
      .catch(() => this.store.status())
      .finally(() => {
        // 只在「还是自己这一轮」时清空，避免把后来者的 promise 抹掉。
        if (this.loading === started) this.loading = null;
      });
    this.loading = started;
    return started;
  }

  get ready(): boolean {
    return this.store.ready;
  }

  lookup(text: string, charOffset: number | undefined): LookupResult {
    try {
      return this.store.lookup(text, charOffset);
    } catch (error) {
      // 查询路径绝不抛给 IPC：UI 只该看到「没查到」。
      void error;
      return {
        query: text,
        term: '',
        results: [],
        tokens: [],
        dictionaryCount: this.store.list().filter((d) => d.enabled).length,
      };
    }
  }

  segment(text: string): SegmentToken[] {
    try {
      return this.store.segment(text);
    } catch {
      return [];
    }
  }

  async importZip(zipPath: string): Promise<DictionaryStatus> {
    await this.store.importZip(zipPath);
    await this.store.load();
    return this.store.status();
  }

  async remove(dictId: string): Promise<DictionaryStatus> {
    await this.store.remove(dictId);
    return this.store.status();
  }

  async setEnabled(dictId: string, enabled: boolean): Promise<DictionaryStatus> {
    await this.store.setEnabled(dictId, enabled);
    await this.store.load();
    return this.store.status();
  }
}
