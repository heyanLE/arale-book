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
    assert.deepEqual(calls.at(-1), ['remote:open', 'rs_server_bk_one', true]);
    await router.invoke('remote:activate', null);
    await router.invoke('library:savePosition', { bookId: 'rs_server_bk_one', pageIndex: 2 });
    assert.ok(calls.some(call=>call[0] === 'remote:savePosition'));
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
test('remote OCR choices load locally without probing the NAS', async () => {
    const calls: string[] = [];
    const router = createSourceTransport(async c => {
        calls.push(c);
        if(c==='remote:connections')return {activeId:'nas',connections:[]};
        if(c==='ocr:capability')return {available:true,selected:'system',providers:[{id:'system',label:'系统 OCR',available:true,ready:true}]};
        if(c.startsWith('remote:'))throw new Error('offline');
    },()=>{});
    const capability=await router.invoke('ocr:capability');
    assert.deepEqual(capability.providers.map((p:any)=>p.id),['system','server']);
    assert.equal(capability.selected,'server');
    await router.invoke('ocr:selectProvider','server');
    for(const c of ['dict:lookup','annotations:read','reading:save','study:read','library:importQueue'])await router.invoke(c,'bk_local');
    assert.deepEqual(calls,['remote:connections','ocr:capability','ocr:capability','dict:lookup','annotations:read','reading:save','study:read','library:importQueue']);
});

test('remote books can start and cancel native OCR while server start reports its own connection failure',async()=>{
    const calls:any[]=[];const id='rs_server_book';
    const router=createSourceTransport(async(c,...args)=>{
        calls.push([c,...args]);
        if(c==='ocr:start')return {ok:true,queued:true};
        if(c==='ocr:queue')return {active:{bookId:id,provider:'system'},pending:[]};
        if(c==='remote:ocrStart')throw new Error('服务器连接失败');
    },()=>{});
    assert.equal((await router.invoke('ocr:start',id,{provider:'system'})).queued,true);
    await router.invoke('ocr:cancel',id);
    assert.ok(calls.some(c=>c[0]==='ocr:cancel'));
    assert.equal(calls.some(c=>c[0]==='remote:ocrCancel'),false);
    await assert.rejects(()=>router.invoke('ocr:start',id,{provider:'server'}),/服务器连接失败/);
});

test('remote reading direction stays a per-client preference while server metadata stays read-only',async()=>{
 const calls:any[]=[];const router=createSourceTransport(async(c,...args)=>{calls.push([c,...args]);return {};},()=>{});
 await router.invoke('library:updateMeta','rs_server_book',{direction:'ltr'});assert.equal(calls[0][0],'remote:preferences');
 await assert.rejects(()=>router.invoke('library:updateMeta','rs_server_book',{title:'Replacement'}),/服务器/);
});

test('remote reader opens at the saved position while text downloads, then publishes a text-only refresh', { timeout: 2000 }, async () => {
    const events: any[] = [];
    const calls: any[] = [];
    let finish!: (value: unknown) => void;
    const layer = new Promise(resolve => { finish = resolve; });
    const id = 'rs_server_book';
    const opened = { book: { id, remote: { revision: 'content-v1' } }, position: { pageIndex: 42 }, textLayerPending: true };
    const router = createSourceTransport(async (channel, ...args) => {
        calls.push([channel, ...args]);
        if (channel === 'remote:open') return opened;
        if (channel === 'remote:refreshLayer') return layer;
        return { blocks: [] };
    }, (channel, value) => events.push([channel, value]));
    assert.equal(await router.invoke('library:open', id), opened);
    assert.deepEqual(calls[0], ['remote:open', id, true]);
    assert.deepEqual(calls[1], ['remote:refreshLayer', id, 'content-v1']);
    assert.deepEqual(events, [['book:textLayer', { bookId: id, state: 'loading' }]]);
    await router.invoke('library:open', id);
    assert.equal(calls.filter(([channel]) => channel === 'remote:refreshLayer').length, 1);
    await router.invoke('comic:pageText', id, 42);
    const study = router.invoke('segment:input', id);
    await Promise.resolve();
    assert.equal(calls.some(([channel]) => channel === 'segment:input'), false);
    finish({ updated: true, blocks: 9 });
    await study;
    assert.deepEqual(events.at(-1), ['book:textLayer', { bookId: id, state: 'ready' }]);
    assert.equal(events.some(([channel]) => channel === 'ocr:done'), false);
    assert.equal(calls.some(([channel]) => channel === 'remote:savePosition'), false);
});

test('failed deferred text keeps the reader usable and can retry on the next open', { timeout: 2000 }, async () => {
    const events: any[] = [];
    let reject!: (error: Error) => void;
    let attempts = 0;
    const first = new Promise((_, fail) => { reject = fail; });
    const router = createSourceTransport(async channel => {
        if (channel === 'remote:open') return { book: {}, position: { pageIndex: 3 }, textLayerPending: true };
        if (channel === 'remote:refreshLayer') return ++attempts === 1 ? first : { updated: true };
    }, (channel, value) => events.push([channel, value]));
    const opened = await router.invoke('library:open', 'rs_book');
    assert.equal(opened.position.pageIndex, 3);
    const pendingStudy = router.invoke('study:read', 'rs_book');
    reject(new Error('offline'));
    await assert.rejects(pendingStudy, /offline/);
    assert.deepEqual(events.at(-1), ['book:textLayer', { bookId: 'rs_book', state: 'failed', error: 'offline' }]);
    await router.invoke('library:open', 'rs_book');
    await router.invoke('study:read', 'rs_book');
    assert.equal(attempts, 2);
    assert.equal(events.at(-1)[1].state, 'ready');
});

test('a current cached text layer does not start another background download', async () => {
    const calls: string[] = [];
    const router = createSourceTransport(async channel => {
        calls.push(channel);
        return { book: {}, position: { pageIndex: 8 }, textLayerPending: false };
    }, () => { throw new Error('No text event expected'); });
    assert.equal((await router.invoke('library:open', 'rs_cached')).position.pageIndex, 8);
    assert.deepEqual(calls, ['remote:open']);
});

test('queued progress keeps the content revision of the opened reader',async()=>{
    const calls:any[]=[];const events:any[]=[];
    const state={jobs:[],conflicts:[],offline:[],connections:[]};
    const router=createSourceTransport(async(channel,...args)=>{calls.push([channel,...args]);if(channel==='remote:open')return {book:{remote:{revision:'old-content'}},textLayerPending:false};if(channel==='remote:status')return state;return {};},(c,v)=>events.push([c,v]));
    await router.invoke('library:open','rs_book');
    await router.invoke('library:savePosition',{bookId:'rs_book',pageIndex:3});
    assert.deepEqual(calls.find(c=>c[0]==='remote:savePosition'),['remote:savePosition',{bookId:'rs_book',pageIndex:3,contentRevision:'old-content'}]);
    assert.ok(events.some(e=>e[0]==='sources:status'));
});

test('manual sync publishes status and a changed catalogue independently of the auto preference',async()=>{
    const events:any[]=[];const config={activeId:'nas',connections:[{id:'nas',autoSync:false}]};
    const router=createSourceTransport(async channel=>channel==='remote:connections'?config:{jobs:[],conflicts:[],offline:[],connections:[{connectionId:'nas',catalogRevision:'new',pending:0}]},(c,v)=>events.push([c,v]));
    await router.invoke('remote:connections');await router.invoke('remote:sync','nas');
    assert.ok(events.some(e=>e[0]==='library:changed'));
    assert.equal(events.find(e=>e[0]==='sources:status')[1].connections[0].pending,0);
});
