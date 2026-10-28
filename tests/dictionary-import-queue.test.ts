import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DictionaryImportQueue } from '../src/core/dict/import-queue';
import { importDictionary } from '../src/core/dict/import-dictionary';
import type { DictionaryImportQueueState, DictionaryImportResult } from '../src/shared/dictionary-imports';

const result = (title: string, indexed = true): DictionaryImportResult => ({ indexed, warnings: [],
  dictionary: { id: title, title, format: 'yomitan', termCount: 2, freqCount: 0, enabled: true, importedAt: 1 } });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('dictionary imports return task IDs immediately, deduplicate active files and isolate failures', async () => {
  const states: DictionaryImportQueueState[] = [], started: string[] = [];
  let finish!: (value: DictionaryImportResult) => void;
  const queue = new DictionaryImportQueue(async (source, _id, progress) => {
    started.push(source);
    if (source === 'bad.zip') throw new Error('invalid zip');
    if (source === 'good.zip') return result('Good');
    progress({ stage: 'extracting', message: '解压中', done: 1, total: 3, unit: 'files' });
    return new Promise(resolve => { finish = resolve; });
  }, state => states.push(state));
  const receipt = queue.enqueue(['first.zip', 'first.zip', 'bad.zip', 'good.zip']);
  assert.equal(receipt.taskIds.length, 3);
  assert.equal(queue.enqueue(['first.zip']).taskIds[0], receipt.taskIds[0]);
  assert.equal(states[0]!.pending.length, 3);
  assert.equal(queue.snapshot().active!.progress.done, 1);
  finish(result('First')); await tick();
  assert.deepEqual(started, ['first.zip', 'bad.zip', 'good.zip']);
  assert.deepEqual(queue.snapshot().recent.map(task => task.status), ['completed', 'failed', 'completed']);
  assert.match(queue.snapshot().recent[1]!.error!, /invalid zip/);
});

test('queued cancellation never claims to stop active IO and index failure keeps the installed result', async () => {
  let finish!: (value: DictionaryImportResult) => void;
  const queue = new DictionaryImportQueue(() => new Promise(resolve => { finish = resolve; }), () => {});
  assert.throws(() => queue.enqueue(['']), /非空/);
  const ids = queue.enqueue(['active.zip', 'pending.zip']).taskIds;
  queue.cancel(ids[0]!); assert.equal(queue.snapshot().active!.status, 'running');
  queue.cancel(ids[1]!); assert.equal(queue.snapshot().pending.length, 0);
  finish({ ...result('Installed', false), warnings: ['index failed'] }); await tick();
  const task = queue.snapshot().recent[0]!;
  assert.equal(task.status, 'partial'); assert.equal(task.result!.dictionary.title, 'Installed');
  queue.progress(ids[0]!, { stage: 'extracting', message: 'stale', done: 0, total: 1, unit: 'files' });
  assert.equal(queue.snapshot().recent[0]!.progress.stage, task.progress.stage);
  queue.dismiss(task.id); assert.equal(queue.snapshot().recent[0]!.status, 'cancelled');
});

test('dictionary parser reports stages, keeps frequency data and exposes skipped rows', async () => {
  const stages: string[] = [], calls: string[] = []; let committed: any[] = [];
  const native = async (channel: string, ...args: any[]) => {
    calls.push(channel);
    if (channel === 'dict:stage') { assert.equal(args[1], 'task'); return { id: 'dict_test', title: 'Test', format: 3, banks: ['term_bank_1.json', 'term_meta_bank_1.json', 'term_bank_2.json'] }; }
    if (channel === 'dict:rawBank') return args[1] === 'term_bank_1.json' ? JSON.stringify([['猫', 'ねこ', '', '', 1, ['cat'], 1, ''], null])
      : args[1] === 'term_bank_2.json' ? 'bad json' : JSON.stringify([['猫', 'freq', 7]]);
    if (channel === 'dict:commit') { committed = args; return { ...result('Test').dictionary, termCount: 1, freqCount: 1 }; }
  };
  const imported = await importDictionary(native, 'test.zip', 'task', progress => stages.push(progress.stage));
  assert.equal(imported.dictionary.termCount, 1); assert.equal(imported.dictionary.freqCount, 1);
  assert.equal(JSON.parse(committed[1])[0].expression, '猫');
  assert.equal(JSON.parse(committed[2])[0].frequencies[0].value, 7);
  assert.match(imported.warnings[0]!, /1 条.*1 个/);
  assert.ok(stages.includes('parsing') && stages.includes('saving'));
  assert.equal(calls.includes('dict:discard'), false);
});

test('invalid dictionary data cleans only staging and does not publish an empty dictionary', async () => {
  const calls: string[] = [];
  await assert.rejects(importDictionary(async channel => {
    calls.push(channel);
    if (channel === 'dict:stage') return { id: 'dict_empty', title: 'Empty', format: 3, banks: ['term_bank_1.json'] };
    if (channel === 'dict:rawBank') return '[null]';
  }, 'empty.zip', 'task', () => {}), /没有可导入/);
  assert.equal(calls.includes('dict:commit'), false);
  assert.equal(calls.at(-1), 'dict:discard');
});
