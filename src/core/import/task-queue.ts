import type { ImportOutcome } from '../../shared/types';
import type { ImportProgress, ImportQueueState, ImportTaskEntry } from '../../shared/imports';

type Processor = (source: string, id: string, progress: (value: ImportProgress) => void) => Promise<ImportOutcome[]>;
type Job = { task: ImportTaskEntry; resolve: (value: ImportOutcome[]) => void };
/** Worker 会话级 FIFO；入队即广播，页面切换不影响正在进行的导入。 */
export class ImportTaskQueue {
  private active: Job | null = null;
  private pending: Job[] = [];
  private recent: ImportTaskEntry[] = [];
  constructor(private process: Processor, private emit: (value: ImportQueueState) => void) {}
  snapshot(): ImportQueueState {
    const copy = (task: ImportTaskEntry): ImportTaskEntry => ({ ...task, progress: { ...task.progress }, results: [...task.results] });
    return { active: this.active ? copy(this.active.task) : null, pending: this.pending.map(j => copy(j.task)), recent: this.recent.map(copy) };
  }
  private changed(): void { this.emit(this.snapshot()); }
  enqueue(paths: string[]): Promise<ImportOutcome[]> {
    if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !path.trim())) return Promise.reject(new Error('导入路径必须为非空文本数组'));
    const promises = paths.map(source => new Promise<ImportOutcome[]>(resolve => {
      this.pending.push({ resolve, task: { id: crypto.randomUUID(), source, title: source.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? source,
        status: 'queued', enqueuedAt: Date.now(), progress: { stage: 'checking', message: '等待导入', done: 0, total: 0 }, results: [] } });
    }));
    if (paths.length) { this.changed(); void this.runNext(); }
    return Promise.all(promises).then(results => results.flat());
  }
  progress(id: string, value: ImportProgress): void {
    if (!this.active || this.active.task.id !== id || this.active.task.status !== 'running') return;
    this.active.task.progress = { ...value }; this.changed();
  }
  dismiss(id: string): ImportQueueState {
    this.recent = this.recent.filter(task => task.id !== id); this.changed(); return this.snapshot();
  }
  cancel(id: string): ImportQueueState {
    const index = this.pending.findIndex(job => job.task.id === id);
    if (index >= 0) {
      const job = this.pending.splice(index, 1)[0]!;
      job.task.status = 'cancelled'; job.task.finishedAt = Date.now();
      job.task.progress.message = '已取消排队'; this.remember(job.task);
      job.resolve([]);
      this.changed();
    }
    return this.snapshot();
  }
  private remember(task: ImportTaskEntry): void { this.recent = [task, ...this.recent].slice(0, 20); }
  private async runNext(): Promise<void> {
    if (this.active) return;
    const job = this.pending.shift(); if (!job) return;
    this.active = job; job.task.status = 'running'; job.task.progress.message = '正在检查文件…'; this.changed();
    let results: ImportOutcome[];
    try { results = await this.process(job.task.source, job.task.id, value => this.progress(job.task.id, value)); }
    catch (error) { results = [{ ok: false, source: job.task.source, bookId: null, format: null, error: String(error) }]; }
    job.task.results = results;
    const succeeded = results.filter(r => r.ok).length, failed = results.filter(r => !r.ok).length;
    job.task.status = succeeded ? failed ? 'partial' : 'completed' : 'failed';
    job.task.finishedAt = Date.now(); job.task.progress.message = `已导入 ${succeeded} 本${failed ? `，${failed} 项失败` : ''}`;
    this.remember(job.task); this.active = null; this.changed(); job.resolve(results);
    void this.runNext();
  }
}
