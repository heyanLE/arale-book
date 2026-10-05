import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAraleApi } from '../src/shared/api-bridge';
import { IPC, bookAssetUrl } from '../src/shared/ipc';

test('desktop bridge keeps all invoke mappings and passes optional fields without altering them', async () => {
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  const api = createAraleApi({
    invoke: async (channel, ...args) => { calls.push({ channel, args }); return 'result'; },
    assetUrl: bookAssetUrl, on: () => 1, off: () => {}, notify: () => {},
  });
  const marker = { tier: 'A3', fields: { kana: true }, concurrency: 3 };
  await api.study.runCards('book', marker as never);
  assert.deepEqual(calls.pop(), { channel: IPC.studyRunCards, args: ['book', marker] });
  await api.annotations.write('book', marker as never);
  assert.deepEqual(calls.pop(), { channel: IPC.annotationsWrite, args: ['book', marker] });
  // Invoke every method group to ensure the extracted factory still represents the complete API.
  for (const group of Object.values(api)) {
    if (!group || typeof group !== 'object') continue;
    for (const [name, fn] of Object.entries(group)) {
      if (name === 'assetUrl' || name === 'forFile') continue;
      if (typeof fn === 'function') await fn('first', 'second', 'third', 'fourth', 'fifth');
    }
  }
  assert.deepEqual(new Set(calls.map(c => c.channel)), new Set(Object.values(IPC)));
  assert.equal(api.book.assetUrl('bk_1', '图片/1.png'), bookAssetUrl('bk_1', '图片/1.png'));
});

test('desktop bridge delegates subscription lifecycle and notifications to the selected host', () => {
  const messages: unknown[] = [];
  const handler = () => {};
  const api = createAraleApi({
    invoke: async () => null, assetUrl: bookAssetUrl,
    on: (channel, callback) => { messages.push([channel,callback]); return 12; },
    off: id => { messages.push(id); }, notify: (channel,payload) => { messages.push([channel,payload]); },
  });
  assert.equal(api.on('library:changed',handler),12);
  api.off(12); api.notify('renderer:ready');
  assert.deepEqual(messages,[['library:changed',handler],12,['renderer:ready',undefined]]);
});
