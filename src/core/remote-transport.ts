import type { OcrQueueState, OcrJobResult, OcrCapability } from '../shared/types';
import type { ServerConnections, ServerPoll } from '../shared/server';
type Invoke = (channel: string, ...args: any[]) => Promise<any>;
/** Book operations route by identity; switching libraries cannot redirect an open book. */
export function createSourceTransport(invoke: Invoke, deliver: (channel: string, value: any) => void) {
    let sources: ServerConnections | null = null;
    let local: OcrQueueState = { active: null, pending: [] };
    let remote: OcrQueueState = { active: null, pending: [] };
    const completed = new Set<string>();
    const scans=new Map<string,number>();
    const revisions = new Map<string, string>();
    const openedRevisions = new Map<string, string>();
    let polling: Promise<ServerPoll> | null = null;
    const textLoads = new Map<string, Promise<unknown>>();
    const loadText = (bookId: string, revision: string | undefined) => {
        if (textLoads.has(bookId)) return;
        deliver('book:textLayer', { bookId, state: 'loading' });
        const work = invoke('remote:refreshLayer', bookId, revision).then(() => {
            deliver('book:textLayer', { bookId, state: 'ready' });
        }).catch(error => {
            deliver('book:textLayer', { bookId, state: 'failed', error: error instanceof Error ? error.message : String(error) });
            throw error;
        }).finally(() => { textLoads.delete(bookId); });
        textLoads.set(bookId, work);
        void work.catch(() => {});
    };
    const queue = (): OcrQueueState => ({ active: local.active ?? remote.active, pending: [...(local.active && remote.active ? [remote.active] : []), ...local.pending, ...remote.pending] });
    const acceptState = async (state: ServerPoll): Promise<ServerPoll> => {
        deliver('sources:status', state);
        for (const connection of state.connections ?? []) {
            const before = revisions.get(connection.connectionId);
            revisions.set(connection.connectionId, connection.catalogRevision);
            if (before !== connection.catalogRevision && connection.catalogRevision && sources?.activeId === connection.connectionId) deliver('library:changed', { reason: 'update' });
        }
        for(const scan of state.scans??[]){
            const previous=scans.get(scan.connectionId);scans.set(scan.connectionId,scan.completedAt);
            if((previous??0)!==scan.completedAt && scan.completedAt>0 && sources?.activeId===scan.connectionId)deliver('library:changed',{reason:'update'});
        }
        const latest=new Map<string,string>();
        for(const job of [...state.jobs].sort((a,b)=>b.createdAt-a.createdAt))if(!latest.has(job.bookId))latest.set(job.bookId,job.id);
        const ongoing = state.jobs.filter(j => j.state === 'queued' || j.state === 'running').sort((a, b) => a.createdAt - b.createdAt);
        const entry = (j: typeof ongoing[number]) => ({ bookId: j.bookId, title: j.title, provider: 'server' as const, enqueuedAt: j.createdAt, total: j.total, running:j.state==='running' });
        const running = ongoing.find(j => j.state === 'running');
        remote = { active: running ? entry(running) : null, pending: ongoing.filter(j => j !== running).map(entry) };
        for (const j of ongoing)
            if (j.state === 'running')
                deliver('ocr:progress', { bookId: j.bookId, provider: 'server', done: j.done, total: j.total, pageIndex: Math.max(0, j.done - 1), stage: 'recognizing', message: '服务器后台识别中' });
        for (const j of state.jobs)
            if (!['queued', 'running'].includes(j.state) && !completed.has(j.id)) {
                if(latest.get(j.bookId)!==j.id){completed.add(j.id);continue;}
                let blocks=j.blocks??0;
                if (j.state === 'succeeded') {
                    // Retry publication after a transient disconnect; don't announce text before it is readable.
                    try {
                        const layer=await invoke('remote:refreshLayer', j.bookId, undefined, j.id);
                        blocks=layer?.blocks??blocks;
                    }
                    catch {
                        continue;
                    }
                    deliver('library:changed', { reason: 'update' });
                }
                completed.add(j.id);
                const result: OcrJobResult = { bookId: j.bookId, ok: j.state === 'succeeded', provider: 'server', pages: j.done, blocks, error: j.error ?? (j.state === 'cancelled' ? '已取消' : undefined) };
                deliver('ocr:done', result);
            }
        deliver('sources:status', state);
        deliver('ocr:queue', queue());
        return state;
    };
    const poll = (): Promise<ServerPoll> => polling ??= invoke('remote:poll').then(acceptState).finally(() => { polling = null; });
    const localQueued = (id: string) => local.active?.bookId === id || local.pending.some(job => job.bookId === id);
    const capabilities = async (): Promise<OcrCapability> => {
        // Listing choices must not probe the NAS. The explicit start action checks it.
        const native = await invoke('ocr:capability') as OcrCapability;
        return { ...native, available: true, selected: 'server', reason: null, providers: [
            ...native.providers.map(provider => ({ ...provider, label: `本机 · ${provider.label}` })),
            { id: 'server', label: '服务器 OCR', available: true, ready: true, reason: null, requirement: '开始识别时连接服务器', downloadSizeMb: 0, extension: null },
        ] };
    };
    return {
        poll,
        localQueue(value: OcrQueueState) { local = value; deliver('ocr:queue', queue()); },
        async invoke(channel: string, ...args: any[]): Promise<any> {
            if (['remote:save', 'remote:activate', 'remote:remove', 'remote:autoSync'].includes(channel)) {
                sources = await invoke(channel, ...args);
                deliver('sources:changed', sources);
                return sources;
            }
            if (channel === 'remote:connections')
                return sources = await invoke(channel, ...args);
            if (channel === 'remote:sync') return acceptState(await invoke(channel, ...args));
            if (channel === 'remote:poll')
                return poll();
            if (channel.startsWith('remote:'))
                return invoke(channel, ...args);
            if (['library:list', 'library:info', 'ocr:capability', 'ocr:selectProvider'].includes(channel)) {
                sources ??= await invoke('remote:connections');
                if (sources!.activeId && ['ocr:capability', 'ocr:selectProvider'].includes(channel)) {
                    if (channel === 'ocr:selectProvider' && args[0] !== 'server') await invoke(channel, ...args);
                    return capabilities();
                }
                if (sources!.activeId)
                    return invoke({ 'library:list': 'remote:list', 'library:info': 'remote:info', 'ocr:capability': 'remote:capability', 'ocr:selectProvider': 'remote:capability' }[channel]!, ...args);
            }
            const id = channel === 'library:savePosition' ? args[0]?.bookId : args[0];
            if (typeof id === 'string' && id.startsWith('rs_')) {
                if (channel === 'library:open') {
                    const result = await invoke('remote:open', id, true);
                    if (result?.book?.remote?.revision) openedRevisions.set(id, result.book.remote.revision);
                    if (result?.textLayerPending) loadText(id, result.book?.remote?.revision);
                    return result;
                }
                if (channel.startsWith('segment:') || channel.startsWith('study:'))
                    await textLoads.get(id);
                if (channel === 'ocr:start' && args[1]?.provider && args[1].provider !== 'server') {
                    const result = await invoke(channel, ...args);
                    local = await invoke('ocr:queue'); deliver('ocr:queue', queue());
                    return result;
                }
                if (channel === 'ocr:cancel' && localQueued(id)) return invoke(channel, ...args);
                if (channel === 'ocr:status') {
                    const result = await invoke(channel, ...args);
                    if (result) return result;
                }
                const route: Record<string, string> = { 'library:savePosition': 'remote:savePosition', 'ocr:start': 'remote:ocrStart', 'ocr:cancel': 'remote:ocrCancel', 'ocr:status': 'remote:ocrStatus' };
                if (route[channel]) {
                    const routedArgs = channel === 'library:savePosition' && openedRevisions.has(id) ? [{ ...args[0], contentRevision: openedRevisions.get(id) }] : args;
                    const result = await invoke(route[channel]!, ...routedArgs);
                    if (channel === 'library:savePosition') void invoke('remote:status').then(state => deliver('sources:status', state)).catch(() => {});
                    if (channel.startsWith('ocr:'))
                        void poll().catch(() => { });
                    return result;
                }
                if (channel === 'library:updateMeta' && args[1] && Object.keys(args[1]).every(k => k === 'direction')) {
                    const book = await invoke('remote:preferences', ...args);
                    deliver('library:changed', { reason: 'update' });
                    return book;
                }
                if (['library:updateMeta', 'library:reveal'].includes(channel))
                    throw new Error('请在服务器管理原文件与元数据');
            }
            if (channel === 'library:remove' && args[0]?.some((id: string) => id.startsWith('rs_')))
                throw new Error('请在服务器管理远程书籍');
            if (channel === 'ocr:queue') {
                local = await invoke(channel, ...args);
                void poll().catch(() => { });
                return queue();
            }
            return invoke(channel, ...args);
        },
    };
}
