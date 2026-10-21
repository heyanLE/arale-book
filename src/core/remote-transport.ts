import type { OcrQueueState, OcrJobResult } from '../shared/types';
import type { ServerConnections, ServerPoll } from '../shared/server';
type Invoke = (channel: string, ...args: any[]) => Promise<any>;
/** Book operations route by identity; switching libraries cannot redirect an open book. */
export function createSourceTransport(invoke: Invoke, deliver: (channel: string, value: any) => void) {
    let sources: ServerConnections | null = null;
    let local: OcrQueueState = { active: null, pending: [] };
    let remote: OcrQueueState = { active: null, pending: [] };
    const completed = new Set<string>();
    const scans=new Map<string,number>();
    let polling: Promise<ServerPoll> | null = null;
    const queue = (): OcrQueueState => ({ active: local.active ?? remote.active, pending: [...(local.active && remote.active ? [remote.active] : []), ...local.pending, ...remote.pending] });
    const poll = (): Promise<ServerPoll> => polling ??= invoke('remote:poll').then(async (state: ServerPoll) => {
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
                        const layer=await invoke('remote:refreshLayer', j.bookId);
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
    }).finally(() => { polling = null; });
    return {
        poll,
        localQueue(value: OcrQueueState) { local = value; deliver('ocr:queue', queue()); },
        async invoke(channel: string, ...args: any[]): Promise<any> {
            if (['remote:save', 'remote:activate', 'remote:remove'].includes(channel)) {
                sources = await invoke(channel, ...args);
                deliver('sources:changed', sources);
                return sources;
            }
            if (channel === 'remote:connections')
                return sources = await invoke(channel, ...args);
            if (channel === 'remote:poll')
                return poll();
            if (channel.startsWith('remote:'))
                return invoke(channel, ...args);
            if (['library:list', 'library:info', 'ocr:capability', 'ocr:selectProvider'].includes(channel)) {
                sources ??= await invoke('remote:connections');
                if (sources!.activeId)
                    return invoke({ 'library:list': 'remote:list', 'library:info': 'remote:info', 'ocr:capability': 'remote:capability', 'ocr:selectProvider': 'remote:capability' }[channel]!, ...args);
            }
            const id = channel === 'library:savePosition' ? args[0]?.bookId : args[0];
            if (typeof id === 'string' && id.startsWith('rs_')) {
                const route: Record<string, string> = { 'library:open': 'remote:open', 'library:savePosition': 'remote:savePosition', 'ocr:start': 'remote:ocrStart', 'ocr:cancel': 'remote:ocrCancel', 'ocr:status': 'remote:ocrStatus' };
                if (route[channel]) {
                    const result = await invoke(route[channel]!, ...args);
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
