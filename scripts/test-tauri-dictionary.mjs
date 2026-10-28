/** Real Worker dispatch and bridge failure coverage, with isolated in-memory native storage. */
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
const bundle = await build({ entryPoints: ['src/renderer/lib/dictionary-worker.ts'], bundle: true, write: false, format: 'iife', platform: 'browser',
  alias: { '@core': resolve('src/core'), '@shared': resolve('src/shared') }, plugins: [{ name: 'worker-fixtures', setup(build) {
    build.onResolve({ filter: /\/data-source$/ }, () => ({ path: resolve('src/renderer/lib/dictionary-data.ts') }));
    build.onResolve({ filter: /\.json\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw' }));
    build.onLoad({ filter: /.*/, namespace: 'raw' }, args => ({ contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf8'))}`, loader: 'js' }));
    build.onResolve({ filter: /tauri-tokenizer$/ }, () => ({ path: 'tokenizer', namespace: 'mock' }));
    build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: 'export async function tokenizeJapanese(){return []}', loader: 'js' }));
  } }] });
async function until(predicate) { const end = Date.now() + 5000; while (Date.now() < end) { if (await predicate()) return; await delay(2); } throw Error('Worker test timed out'); }
let releaseStage;
const stageGate = new Promise(resolve => { releaseStage = resolve; });
const installed = new Map(), events = [], pending = new Map();
let nextId = 0, failIndex = false;
const native = async (channel, ...args) => {
  switch (channel) {
    case 'dict:status': return { dictionaries: [...installed.values()].map(item => item.info), termCount: installed.size, freqCount: 0, loaded: false };
    case 'dict:stage':
      if (args[0] === 'bad.zip') throw Error('invalid ZIP');
      if (args[0] === 'first.zip') await stageGate;
      return { id: args[0], title: args[0], format: 3, banks: ['term_bank_1.json'] };
    case 'dict:rawBank': return JSON.stringify([['猫', 'ねこ', '', '', 1, ['cat'], 1, '']]);
    case 'dict:commit': {
      const info = { id: args[0], title: args[0], format: 'yomitan', termCount: 1, freqCount: 0, enabled: true, importedAt: Date.now() };
      installed.set(args[0], { info, terms: args[1], frequencies: args[2] }); return info;
    }
    case 'dict:data': if (failIndex) throw Error('index read failed'); return installed.get(args[0]);
    case 'dict:discard': throw Error('successful commits must not be discarded');
    default: throw Error(`unexpected native call: ${channel}`);
  }
};
const scope = { postMessage(message) {
  if (message.kind === 'native') void native(message.channel, ...message.args).then(
    value => scope.onmessage({ data: { kind: 'native-result', id: message.id, value } }),
    error => scope.onmessage({ data: { kind: 'native-result', id: message.id, error: String(error) } }),
  );
  else if (message.kind === 'event') events.push(structuredClone(message));
  else { const item = pending.get(message.id); pending.delete(message.id); message.error ? item.reject(Error(message.error)) : item.resolve(message.value); }
} };
runInNewContext(bundle.outputFiles[0].text, { self: scope, crypto: globalThis.crypto, structuredClone, setTimeout, clearTimeout, console, TextDecoder, TextEncoder, URL, performance });
const request = (channel, ...args) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); scope.onmessage({ data: { id, channel, args } }); });
await request('dict:initialize');
const receipt = await request('dict:import', ['first.zip', 'bad.zip', 'last.zip']);
assert.equal(receipt.taskIds.length, 3);
assert.equal((await request('dict:importQueue')).active.id, receipt.taskIds[0]);
assert.equal((await request('dict:import', ['first.zip'])).taskIds[0], receipt.taskIds[0]);
await request('dict:importProgress', { taskId: receipt.taskIds[0], stage: 'extracting', message: 'extracting', done: 1, total: 2, unit: 'files' });
assert.equal((await request('dict:importQueue')).active.progress.done, 1);
releaseStage();
await until(async () => (await request('dict:importQueue')).recent.length === 3);
let queue = await request('dict:importQueue');
assert.deepEqual(Array.from(queue.recent, task => task.status), ['completed', 'failed', 'completed']);
assert.match(queue.recent[1].error, /invalid ZIP/);
assert.equal((await request('dict:lookup', '猫', 0)).results.length, 2);
assert(events.some(event => event.channel === 'dict:importQueue' && event.payload.active?.progress.stage === 'indexing'));
console.log('ok immediate receipt, native progress, deduplication, per-file failure and usable index');
failIndex = true;
const partial = await request('dict:import', ['partial.zip']);
await until(async () => (await request('dict:importQueue')).recent.some(task => task.id === partial.taskIds[0]));
queue = await request('dict:importQueue');
assert.equal(queue.recent[0].status, 'partial');
assert.match(queue.recent[0].result.warnings[0], /index read failed/);
assert(installed.has('partial.zip'));
assert.equal((await request('dict:lookup', '猫', 0)).results.length, 2, 'previous index stays usable on failed reload');
failIndex = false;
assert.equal((await request('dict:reload')).loaded, true);
assert.equal((await request('dict:lookup', '猫', 0)).results.length, 3);
console.log('ok committed dictionary survives index failure; manual reload restores lookup');
const bridgeBundle = await build({ entryPoints: ['src/renderer/lib/tauri-dictionary.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
const { createTauriDictionary } = await import(`data:text/javascript;base64,${Buffer.from(bridgeBundle.outputFiles[0].text).toString('base64')}`);
const worker = { postMessage() {} }, delivered = [];
const adapter = createTauriDictionary(async () => null, (channel, payload) => delivered.push({ channel, payload }), worker);
const active = { ...queue.recent[0], status: 'running' };
worker.onmessage({ data: { kind: 'event', channel: 'dict:importQueue', payload: { active, pending: [{ ...active, id: 'pending', status: 'queued' }], recent: [] } } });
worker.onerror({ message: 'Worker crashed' });
const interrupted = await adapter.invoke('dict:importQueue');
assert.equal(interrupted.active, null); assert.equal(interrupted.pending.length, 0);
assert(interrupted.recent.every(task => task.status === 'failed' && /后台中断/.test(task.error)));
assert.equal(delivered.at(-1).channel, 'dict:importQueue');
await assert.rejects(adapter.invoke('dict:status'), /Worker crashed/);
console.log('ok Worker interruption retains actionable failed tasks after settings remount');
console.log('Tauri dictionary adapter: 3/3 passed');
