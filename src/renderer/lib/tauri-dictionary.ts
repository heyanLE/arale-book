export function createTauriDictionary(
  native: (channel: string, ...args: unknown[]) => Promise<any>,
  deliver: (channel: string, payload: unknown) => void,
  worker = new Worker(new URL('./dictionary-worker.ts', import.meta.url), { type: 'module' }),
) {
  let nextId = 1;
  let failed: Error | null = null;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  worker.onmessage = event => {
    const message = event.data;
    if (message.kind === 'native') {
      void native(message.channel, ...message.args).then(
        value => worker.postMessage({ kind: 'native-result', id: message.id, value }),
        error => worker.postMessage({ kind: 'native-result', id: message.id, error: String(error) }),
      );
    } else if (message.kind === 'event') deliver(message.channel, message.payload);
    else if (message.kind === 'result') {
      const item = pending.get(message.id); pending.delete(message.id);
      if (message.error !== undefined) item?.reject(new Error(message.error)); else item?.resolve(message.value);
    }
  };
  worker.onerror = event => {
    failed = new Error(event.message || '后台 Worker 启动失败');
    for (const item of pending.values()) item.reject(failed);
    pending.clear();
  };
  const invoke = (channel: string, ...args: unknown[]): Promise<any> => {
    if (failed) return Promise.reject(failed);
    return new Promise((resolve, reject) => {
      const id = nextId++; pending.set(id, { resolve, reject }); worker.postMessage({ channel, args, id });
    });
  };
  // Start lazily after React subscriptions mount; keep one worker across reader/settings views.
  const initialize = () => invoke('dict:initialize').catch(error => console.error('[arale] dictionary load', error));
  const request = async (channel: string, ...args: unknown[]) => {
    if (channel === 'dict:importDialog') {
      const paths = await native('dict:select') as string[] | null;
      return paths?.length ? invoke('dict:import', paths) : null;
    }
    if (channel === 'library:importDialog') {
      const paths = await native('library:select', ...args) as string[];
      return invoke('library:import', paths);
    }
    return invoke(channel, ...args);
  };
  return { initialize, invoke: request };
}
