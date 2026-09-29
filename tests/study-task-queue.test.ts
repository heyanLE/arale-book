import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BookRecord, StudyList } from '../src/shared/types';
import type { StudyService } from '../src/main/study/service';
import { StudyTaskQueue } from '../src/main/study/task-queue';

function studyList(bookId: string): StudyList {
  return {
    bookId, generatedAt: 1, segmentGeneratedAt: 1, jlptSource: 'test',
    workflow: { levels: [3], includeUnknown: false },
    candidates: [{ id: `${bookId}-word`, expression: '猫', reading: 'ねこ', partOfSpeech: '名詞', jlpt: 3,
      jlptConflict: false, count: 1, occurrences: [{ id: 'page:p#0@0', ref: 'page:p#0', label: '第 1 页', text: '猫', start: 0, end: 1 }],
      meaning: '', selected: true, excluded: false, contextRef: 'page:p#0@0', exportedAt: null }],
  };
}

async function tick(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

test('AI 任务立即入队、跨书串行、进度可读取且完成记录可清除', async () => {
  const lists = new Map([['a', studyList('a')], ['b', studyList('b')]]);
  const resolvers = new Map<string, (list: StudyList) => void>();
  const starts: string[] = [];
  const done: string[] = [];
  const study = {
    read: (id: string) => lists.get(id) ?? null,
    runFilter: (id: string) => { starts.push(id); return new Promise<StudyList>((resolve) => resolvers.set(id, resolve)); },
    runCards: async () => { throw new Error('不应调用制卡'); },
    cancel: () => undefined,
  } as unknown as Pick<StudyService, 'read' | 'runFilter' | 'runCards' | 'cancel'>;
  const queue = new StudyTaskQueue({ study, getBook: (id) => ({ id, title: `漫画${id}` } as BookRecord), onDone: (task) => done.push(task.id) });
  const a = queue.enqueueFilter('a', { tier: 'F1', profileId: 'p' });
  const b = queue.enqueueFilter('b', { tier: 'F2', profileId: 'p' });
  assert.deepEqual(starts, ['a'], '首任务可启动，但入队调用不等待模型完成');
  assert.equal(queue.enqueueFilter('a', { tier: 'F1', profileId: 'p' }).id, a.id, '相同任务不会重复入队');
  await tick();
  assert.deepEqual(starts, ['a']);
  assert.equal(queue.queueState().pending[0]?.id, b.id);
  queue.onProgress({ bookId: 'a', stage: 'filter', done: 5, total: 10 });
  assert.equal(queue.queueState().active?.done, 5);
  resolvers.get('a')?.(lists.get('a')!);
  await tick(); await tick();
  assert.deepEqual(starts, ['a', 'b']);
  assert.equal(queue.queueState().recent[0]?.status, 'completed');
  resolvers.get('b')?.(lists.get('b')!);
  await tick(); await tick();
  assert.equal(queue.queueState().active, null);
  assert.equal(done.length, 2);
  queue.dismiss(a.id);
  assert.equal(queue.queueState().recent.length, 1);
});

test('排队任务可取消；队列等待期间词单变化会失败而不会处理新输入', async () => {
  const lists = new Map([['a', studyList('a')], ['b', studyList('b')], ['c', studyList('c')]]);
  let finishA!: (value: StudyList) => void;
  const starts: string[] = [];
  const study = {
    read: (id: string) => lists.get(id) ?? null,
    runFilter: (id: string) => { starts.push(id); return id === 'a' ? new Promise<StudyList>((resolve) => { finishA = resolve; }) : Promise.resolve(lists.get(id)!); },
    runCards: async () => { throw new Error('不应调用制卡'); },
    cancel: () => undefined,
  } as unknown as Pick<StudyService, 'read' | 'runFilter' | 'runCards' | 'cancel'>;
  const queue = new StudyTaskQueue({ study, getBook: (id) => ({ id, title: id } as BookRecord) });
  queue.enqueueFilter('a', { tier: 'F1', profileId: 'p' });
  const b = queue.enqueueFilter('b', { tier: 'F1', profileId: 'p' });
  const c = queue.enqueueFilter('c', { tier: 'F1', profileId: 'p' });
  queue.cancel(b.id);
  assert.equal(queue.queueState().recent[0]?.status, 'cancelled');
  lists.get('c')!.candidates[0]!.expression = '犬';
  await tick();
  finishA(lists.get('a')!);
  await tick(); await tick();
  assert.deepEqual(starts, ['a'], '变化后的 c 不应送入模型');
  assert.equal(queue.queueState().recent.find((item) => item.id === c.id)?.status, 'failed');
  assert.match(queue.queueState().recent.find((item) => item.id === c.id)?.error ?? '', /词单已变化/);
});

test('停止运行中的任务会通知 StudyService 并继续下一本', async () => {
  const lists = new Map([['a', studyList('a')], ['b', studyList('b')]]);
  let rejectA!: (error: Error) => void;
  const cancelled: string[] = [];
  const study = {
    read: (id: string) => lists.get(id) ?? null,
    runFilter: (id: string) => id === 'a' ? new Promise<StudyList>((_resolve, reject) => { rejectA = reject; }) : Promise.resolve(lists.get(id)!),
    runCards: async () => { throw new Error('不应调用制卡'); },
    cancel: (id: string) => { cancelled.push(id); rejectA(new Error('已取消')); },
  } as unknown as Pick<StudyService, 'read' | 'runFilter' | 'runCards' | 'cancel'>;
  const queue = new StudyTaskQueue({ study, getBook: (id) => ({ id, title: id } as BookRecord) });
  const a = queue.enqueueFilter('a', { tier: 'F1', profileId: 'p' });
  queue.enqueueFilter('b', { tier: 'F1', profileId: 'p' });
  queue.cancel(a.id);
  await tick(); await tick();
  assert.deepEqual(cancelled, ['a']);
  assert.equal(queue.queueState().recent.find((item) => item.id === a.id)?.status, 'cancelled');
  assert.equal(queue.queueState().recent.find((item) => item.bookId === 'b')?.status, 'completed');
});
