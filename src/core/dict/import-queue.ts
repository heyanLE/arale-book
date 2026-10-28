import type { DictionaryImportProgress, DictionaryImportQueueState, DictionaryImportReceipt, DictionaryImportResult, DictionaryImportTask } from '../../shared/dictionary-imports';

type Processor = (path: string, id: string, progress: (value: DictionaryImportProgress) => void) => Promise<DictionaryImportResult>;
/** One session-owned queue shared by settings and the global task dock. */
export class DictionaryImportQueue {
  private active: DictionaryImportTask | null = null;
  private pending: DictionaryImportTask[] = [];
  private recent: DictionaryImportTask[] = [];
  constructor(private process: Processor, private emit: (state: DictionaryImportQueueState) => void) {}
  snapshot(): DictionaryImportQueueState {
    return structuredClone({ active: this.active, pending: this.pending, recent: this.recent });
  }
  private changed() { this.emit(this.snapshot()); }
  enqueue(paths: string[]): DictionaryImportReceipt {
    if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !path.trim())) throw new Error('词典路径必须为非空文本数组');
    const taskIds: string[] = [];
    for (const source of new Set(paths)) {
      const existing = [this.active, ...this.pending].find(task => task?.source === source);
      if (existing) { taskIds.push(existing.id); continue; }
      const task: DictionaryImportTask = { id: crypto.randomUUID(), source,
        title: source.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? source,
        status: 'queued', enqueuedAt: Date.now(), result: null, error: null,
        progress: { stage: 'checking', message: '等待导入词典', done: 0, total: 0, unit: 'files' } };
      this.pending.push(task); taskIds.push(task.id);
    }
    if (taskIds.length) { this.changed(); void this.runNext(); }
    return { taskIds };
  }
  progress(id: string, progress: DictionaryImportProgress): void {
    if (!this.active || this.active.id !== id) return;
    this.active.progress = { ...progress };
    if (progress.title) this.active.title = progress.title;
    this.changed();
  }
  cancel(id: string): DictionaryImportQueueState {
    const task = this.pending.find(task => task.id === id);
    if (task) {
      this.pending = this.pending.filter(task => task.id !== id);
      task.status = 'cancelled'; task.finishedAt = Date.now(); task.progress.message = '已取消排队';
      this.remember(task); this.changed();
    }
    return this.snapshot();
  }
  dismiss(id: string): DictionaryImportQueueState {
    this.recent = this.recent.filter(task => task.id !== id); this.changed(); return this.snapshot();
  }
  private remember(task: DictionaryImportTask) { this.recent = [task, ...this.recent].slice(0, 20); }
  private async runNext(): Promise<void> {
    if (this.active) return;
    const task = this.pending.shift(); if (!task) return;
    this.active = task; task.status = 'running'; task.progress.message = '准备导入词典…'; this.changed();
    try {
      task.result = await this.process(task.source, task.id, progress => this.progress(task.id, progress));
      task.title = task.result.dictionary.title;
      task.status = task.result.indexed ? 'completed' : 'partial';
      task.progress.message = task.result.indexed ? '词典已安装，可以查词' : '词典已安装，索引尚未加载';
    } catch (error) {
      task.status = 'failed'; task.error = (error instanceof Error ? error.message : String(error)).replace(/^(?:Error: )+/, ''); task.progress.message = '词典导入失败';
    }
    task.finishedAt = Date.now(); this.remember(task); this.active = null; this.changed();
    void this.runNext();
  }
}
