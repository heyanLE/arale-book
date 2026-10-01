/** 主进程持有的 Anki AI/翻译任务队列；IPC 入队立即返回，任务独立于页面生命周期。 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  BookRecord, StudyCardRunRequest, StudyFilterRunRequest, StudyList, StudyRunProgress,
  StudyTaskEntry, StudyTaskKind, StudyTaskQueueState,
} from '../../shared/types';
import { defaultStudyWorkflow, directCandidates } from '../../core/study/harness';
import { needsTranslation } from '../../core/study/pipeline';
import type { StudyService } from './service';

type Request = { kind: 'filter'; value: StudyFilterRunRequest } | { kind: 'cards'; value: StudyCardRunRequest };
interface QueuedTask { entry: StudyTaskEntry; request: Request; sourceHash: string; profileSignature?: string; translationSignature?: string; cancelled: boolean; }

export interface StudyTaskQueueOptions {
  study: Pick<StudyService, 'read' | 'runFilter' | 'runCards' | 'cancel'>;
  getBook(bookId: string): BookRecord | null;
  profileSignature?(profileId: string): string | null;
  translationSignature?(profileId: string): string | null;
  onChange?(state: StudyTaskQueueState): void;
  onDone?(task: StudyTaskEntry): void;
}

export class StudyTaskQueue {
  private readonly pending: QueuedTask[] = [];
  private active: QueuedTask | null = null;
  private readonly recent: StudyTaskEntry[] = [];

  constructor(private readonly options: StudyTaskQueueOptions) {}

  queueState(): StudyTaskQueueState {
    const copy = (entry: StudyTaskEntry): StudyTaskEntry => ({ ...entry });
    return {
      active: this.active ? copy(this.active.entry) : null,
      pending: this.pending.map((item) => copy(item.entry)),
      recent: this.recent.map(copy),
    };
  }

  isBusy(bookId: string): boolean {
    return this.active?.entry.bookId === bookId || this.pending.some((item) => item.entry.bookId === bookId);
  }

  enqueueFilter(bookId: string, request: StudyFilterRunRequest): StudyTaskEntry {
    return this.enqueue(bookId, { kind: 'filter', value: request });
  }

  enqueueCards(bookId: string, request: StudyCardRunRequest): StudyTaskEntry {
    return this.enqueue(bookId, { kind: 'cards', value: request });
  }

  private enqueue(bookId: string, request: Request): StudyTaskEntry {
    const existing = this.active?.entry.bookId === bookId ? this.active : this.pending.find((item) => item.entry.bookId === bookId);
    if (existing) {
      if (existing.request.kind === request.kind && JSON.stringify(existing.request.value) === JSON.stringify(request.value)) return { ...existing.entry };
      throw new Error('这本书已有 AI／翻译任务在队列中，请等待或先取消');
    }
    const book = this.options.getBook(bookId);
    const list = this.options.study.read(bookId);
    if (!book || !list) throw new Error('书或学习候选不存在，请先生成候选');
    const workflow = list.workflow ?? defaultStudyWorkflow();
    const total = request.kind === 'filter'
      ? directCandidates(list.candidates, workflow.levels, workflow.includeUnknown, workflow.direct).filter((item) => !item.forceInclude).length
      : list.candidates.filter((item) => item.selected && !item.excluded).length;
    if (total === 0) throw new Error(request.kind === 'filter' ? '没有需要 AI 筛选的候选词' : '没有准备制卡的词');
    const entry: StudyTaskEntry = {
      id: `study_${randomUUID()}`, bookId, title: book.title, kind: request.kind,
      tier: request.value.tier, status: 'queued', enqueuedAt: Date.now(), done: 0, total,
    };
    const profileId = request.value.profileId;
    const profileSignature = profileId ? this.options.profileSignature?.(profileId) ?? undefined : undefined;
    if (profileId && this.options.profileSignature && !profileSignature) throw new Error('LLM 配置不存在，请重新选择');
    const translationSignature = request.kind === 'cards' && needsTranslation(request.value.tier)
      ? this.options.translationSignature?.(request.value.translationProfileId) ?? undefined : undefined;
    if (request.kind === 'cards' && needsTranslation(request.value.tier) && this.options.translationSignature && !translationSignature) throw new Error('翻译配置不存在，请重新选择');
    this.pending.push({ entry, request, sourceHash: sourceFingerprint(list), profileSignature, translationSignature, cancelled: false });
    this.publish();
    this.pump();
    return { ...entry };
  }

  cancel(id: string): void {
    if (this.active?.entry.id === id) {
      if (!this.active.cancelled) {
        this.active.cancelled = true;
        this.active.entry.message = '正在取消…';
        this.options.study.cancel(this.active.entry.bookId);
        this.publish();
      }
      return;
    }
    const index = this.pending.findIndex((item) => item.entry.id === id);
    if (index < 0) return;
    const [item] = this.pending.splice(index, 1);
    if (item) this.finish(item, 'cancelled', '已取消排队');
  }

  dismiss(id: string): void {
    const index = this.recent.findIndex((item) => item.id === id);
    if (index >= 0) { this.recent.splice(index, 1); this.publish(); }
  }

  onProgress(progress: StudyRunProgress): void {
    const item = this.active;
    if (!item || item.entry.bookId !== progress.bookId || item.entry.kind !== progress.stage) return;
    item.entry.done = Math.max(0, Math.min(progress.done, progress.total));
    item.entry.total = progress.total;
    item.entry.message = progress.message;
    this.publish();
  }

  private publish(): void { this.options.onChange?.(this.queueState()); }

  private finish(item: QueuedTask, status: StudyTaskEntry['status'], message?: string): void {
    item.entry.status = status;
    item.entry.finishedAt = Date.now();
    item.entry.message = message;
    if (status === 'completed') item.entry.done = item.entry.total;
    this.recent.unshift({ ...item.entry });
    if (this.recent.length > 20) this.recent.length = 20;
    this.publish();
    this.options.onDone?.({ ...item.entry });
  }

  private pump(): void {
    if (this.active || this.pending.length === 0) return;
    const item = this.pending.shift()!;
    this.active = item;
    item.entry.status = 'running';
    item.entry.startedAt = Date.now();
    this.publish();
    void (async () => {
      let status: StudyTaskEntry['status'] = 'completed';
      let message = '已完成';
      try {
        const list = this.options.study.read(item.entry.bookId);
        if (!list || sourceFingerprint(list) !== item.sourceHash) throw new Error('排队期间词单已变化，请重新提交任务');
        if (item.profileSignature && this.options.profileSignature?.(item.request.value.profileId ?? '') !== item.profileSignature) {
          throw new Error('排队期间 LLM 配置已变化，请重新提交任务');
        }
        if (item.translationSignature && item.request.kind === 'cards' && this.options.translationSignature?.(item.request.value.translationProfileId) !== item.translationSignature) throw new Error('排队期间翻译配置已变化，请重新提交任务');
        if (item.request.kind === 'filter') await this.options.study.runFilter(item.entry.bookId, item.request.value);
        else await this.options.study.runCards(item.entry.bookId, item.request.value);
        if (item.cancelled) { status = 'cancelled'; message = '已取消'; }
      } catch (error) {
        item.entry.error = error instanceof Error ? error.message : String(error);
        status = item.cancelled ? 'cancelled' : 'failed';
        message = item.cancelled ? '已取消' : '任务失败';
      } finally {
        this.active = null;
        this.finish(item, status, message);
        this.pump();
      }
    })();
  }
}

/** 仅锁定任务实际输入；配图和导出时间戳变化不影响排队中的释义任务。 */
function sourceFingerprint(list: StudyList): string {
  const workflow = list.workflow ?? defaultStudyWorkflow();
  const rows = list.candidates.map((item) => ({
    id: item.id, selected: item.selected, excluded: item.excluded, forceInclude: item.forceInclude,
    expression: item.expression, reading: item.reading, meaning: item.meaning, contextRef: item.contextRef,
    meaningEdited: item.meaningEdited, contextPinned: item.contextPinned,
    occurrences: item.occurrences,
  }));
  return createHash('sha256').update(JSON.stringify({ segmentGeneratedAt: list.segmentGeneratedAt,
    levels: workflow.levels, includeUnknown: workflow.includeUnknown, direct: workflow.direct, rows })).digest('hex');
}
