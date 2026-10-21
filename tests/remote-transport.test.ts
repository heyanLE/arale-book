import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSourceTransport } from '../src/core/remote-transport';
const localSources = { activeId: null, connections: [] };
test('sources coexist: local behavior stays unchanged and book identity wins over selected library', async () => {
    const calls: any[] = [];
    const events: any[] = [];
    let selected: any = localSources;
    const router = createSourceTransport(async (channel, ...args) => { calls.push([channel, ...args]); if (channel === 'remote:connections')
        return selected; if (channel === 'remote:activate')
        return selected = { activeId: args[0], connections: [] }; return 'ok'; }, (c, v) => events.push([c, v]));
    await router.invoke('library:list', {});
    assert.equal(calls.at(-1)[0], 'library:list');
    await router.invoke('remote:activate', 'nas');
    await router.invoke('library:list', { search: '猫' });
    assert.deepEqual(calls.at(-1), ['remote:list', { search: '猫' }]);
    await router.invoke('library:open', 'bk_local');
    assert.deepEqual(calls.at(-1), ['library:open', 'bk_local']);
    await router.invoke('library:open', 'rs_server_bk_one');
    assert.deepEqual(calls.at(-1), ['remote:open', 'rs_server_bk_one']);
    await router.invoke('remote:activate', null);
    await router.invoke('library:savePosition', { bookId: 'rs_server_bk_one', pageIndex: 2 });
    assert.equal(calls.at(-1)[0], 'remote:savePosition');
    await router.invoke('library:import', ['local.cbz']);
    assert.equal(calls.at(-1)[0], 'library:import');
    await assert.rejects(() => router.invoke('library:remove', ['bk_local', 'rs_server_bk_one']), /服务器/);
    assert.equal(events.filter(e => e[0] === 'sources:changed').length, 2);
});
test('remote OCR is polled independently, merged with local queue, and published after cached layer is readable', async () => {
    const events: any[] = [];
    let release: () => void = () => { };
    let state: any = { jobs: [{ id: 'job', bookId: 'rs_server_book', title: '远程', state: 'running', createdAt: 1, done: 1, total: 3 }], conflicts: [], offline: [] };
    const router = createSourceTransport(async (channel) => { if (channel === 'remote:poll')
        return state; if (channel === 'remote:refreshLayer')
        await new Promise<void>(accept => release = accept); }, (c, v) => events.push([c, v]));
    router.localQueue({ active: { bookId: 'bk_local', title: '本地', provider: 'system', enqueuedAt: 0, total: 2 }, pending: [] });
    await router.poll();
    const queue = events.filter(e => e[0] === 'ocr:queue').at(-1)[1];
    assert.equal(queue.active.bookId, 'bk_local');
    assert.equal(queue.pending[0].bookId, 'rs_server_book');
    assert.equal(queue.pending[0].running,true);
    state.jobs[0].state = 'succeeded';
    const pending = router.poll();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(events.filter(e => e[0] === 'ocr:done').length, 0);
    release();
    await pending;
    assert.equal(events.filter(e => e[0] === 'ocr:done').length, 1);
    await router.poll();
    assert.equal(events.filter(e => e[0] === 'ocr:done').length, 1);
});
test('source capability follows server while dictionaries, learning data and local import remain native', async () => {
    const calls: string[] = [];
    const router = createSourceTransport(async (c) => { calls.push(c); return c === 'remote:connections' ? { activeId: 'nas', connections: [] } : null; }, () => { });
    for (const c of ['ocr:capability', 'ocr:selectProvider', 'dict:lookup', 'annotations:read', 'reading:save', 'study:read', 'library:importQueue'])
        await router.invoke(c, 'bk_local');
    assert.deepEqual(calls, ['remote:connections', 'remote:capability', 'remote:capability', 'dict:lookup', 'annotations:read', 'reading:save', 'study:read', 'library:importQueue']);
});

test('remote reading direction stays a per-client preference while server metadata stays read-only',async()=>{
 const calls:any[]=[];const router=createSourceTransport(async(c,...args)=>{calls.push([c,...args]);return {};},()=>{});
 await router.invoke('library:updateMeta','rs_server_book',{direction:'ltr'});assert.equal(calls[0][0],'remote:preferences');
 await assert.rejects(()=>router.invoke('library:updateMeta','rs_server_book',{title:'Replacement'}),/服务器/);
});
