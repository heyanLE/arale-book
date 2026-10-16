import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ImportTaskQueue } from '../src/core/import/task-queue';
import type { ImportQueueState } from '../src/shared/imports';
import type { ImportOutcome } from '../src/shared/types';
const success = (source: string): ImportOutcome => ({ ok: true, source, bookId: source, format: 'comic', error: null });
const failure = (source: string): ImportOutcome => ({ ok: false, source, bookId: null, format: null, error: 'bad archive' });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('import FIFO announces pending tasks before IO and keeps stage progress visible until completion', async () => {
  const events: ImportQueueState[] = [], starts: string[] = [];
  const finish: Array<(results: ImportOutcome[]) => void> = [];
  const queue = new ImportTaskQueue((source, _id, progress) => {
    starts.push(source); progress({ stage: 'extracting', message: '解压中', done: 0, total: 0 });
    return new Promise(resolve => finish.push(resolve));
  }, state => events.push(state));
  const promise = queue.enqueue(['/a.rar', '/b.rar']);
  assert.deepEqual(events[0]!.pending.map(t => t.source), ['/a.rar', '/b.rar']);
  assert.deepEqual(starts, ['/a.rar']);
  assert.equal(queue.snapshot().active!.progress.message, '解压中');
  const firstId = queue.snapshot().active!.id;
  finish[0]!([success('volume01'), failure('volume02')]); await tick();
  assert.deepEqual(starts, ['/a.rar', '/b.rar']);
  assert.equal(queue.snapshot().recent[0]!.status, 'partial');
  queue.progress(firstId, { stage: 'publishing', message: 'late', done: 5, total: 5 });
  assert.equal(queue.snapshot().active!.progress.message, '解压中');
  finish[1]!([success('b')]);
  assert.equal((await promise).length, 3);
  assert.equal(queue.snapshot().active, null);
  assert.equal(queue.snapshot().recent.length, 2);
});
test('queued import cancellation resolves its caller without starting IO, active import is not falsely cancelled', async () => {
  let resolveActive!: (results: ImportOutcome[]) => void;
  let calls = 0;
  const queue = new ImportTaskQueue(() => { calls++; return new Promise(resolve => { resolveActive = resolve; }); }, () => {});
  const promise = queue.enqueue(['active.rar', 'queued.rar']);
  queue.cancel(queue.snapshot().active!.id);
  assert.equal(queue.snapshot().active!.status, 'running');
  queue.cancel(queue.snapshot().pending[0]!.id);
  assert.equal(queue.snapshot().pending.length, 0);
  assert.equal(queue.snapshot().recent[0]!.status, 'cancelled');
  resolveActive([success('active')]);
  const results = await promise;
  assert.equal(calls, 1); assert.equal(results.length, 1); assert.equal(results[0]!.ok, true);
  const recentId = queue.snapshot().recent[0]!.id;
  queue.dismiss(recentId); assert.equal(queue.snapshot().recent.length, 1);
});
test('one processor failure does not strand later imports, and invalid input creates no task', async () => {
  const queue = new ImportTaskQueue(async source => { if (source === 'bad.rar') throw new Error('CRC'); return [success(source)]; }, () => {});
  await assert.rejects(queue.enqueue(['']), /非空/);
  assert.equal(queue.snapshot().recent.length, 0);
  const results = await queue.enqueue(['bad.rar', 'good.rar']);
  assert.match(results[0]!.error!, /CRC/); assert.equal(results[1]!.ok, true);
  assert.equal(queue.snapshot().recent[1]!.status, 'failed');
});
