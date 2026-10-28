import { addDictionaryToIndex, emptyTermIndex } from '@core/dict/model';
import { DictionaryImportQueue } from '@core/dict/import-queue';
import { importDictionary } from '@core/dict/import-dictionary';
import type { DictionaryImportProgress } from '@shared/dictionary-imports';
import { lookup, segment } from '@core/dict/lookup';
import { naturalCompare } from '@core/util/natural-sort';
import type { DictionaryStatus } from '@shared/types';
import { TauriSegments } from './tauri-segments';
import { sanitizeGlossaryHtml } from '@core/dict/glossary';
import type { GlossaryContent } from '@shared/types';
import { importBooks } from './tauri-epub';
import { ImportTaskQueue } from '@core/import/task-queue';

// No filesystem or Tauri globals in this worker: the host forwards a narrow native RPC.
let nextNativeId = 1;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
function native(channel: string, ...args: unknown[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextNativeId++; pending.set(id, { resolve, reject });
    self.postMessage({ kind: 'native', id, channel, args });
  });
}
let index = emptyTermIndex();
let loaded = false;
let mutation: Promise<unknown> = Promise.resolve();
const imports = new ImportTaskQueue((path, id, progress) => importBooks(native, [path], id, progress),
  payload => self.postMessage({ kind: 'event', channel: 'library:importQueue', payload }));
const dictionaryImports = new DictionaryImportQueue((path, id, progress) => serialize(async () => {
  const result = await importDictionary(native, path, id, progress);
  try { await reload(progress); return { ...result, indexed: true }; }
  catch (error) {
    const status = await native('dict:status').catch(() => null);
    if (status) self.postMessage({ kind: 'event', channel: 'dict:changed', payload: { ...status, loaded: false } });
    return { ...result, warnings: [...result.warnings, `索引加载失败：${String(error)}。词典文件已保留，可在设置中刷新索引。`] };
  }
}), payload => self.postMessage({ kind: 'event', channel: 'dict:importQueue', payload }));
const segments = new TauriSegments(native, (channel, payload) => self.postMessage({ kind: 'event', channel, payload }), async () => {
  await mutation;
  if (!loaded) await serialize(reload);
  return index;
});
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const task = mutation.then(fn, fn); mutation = task.catch(() => undefined); return task;
}
function sortStatus(status: DictionaryStatus): DictionaryStatus {
  status.dictionaries.sort((a, b) => naturalCompare(a.title, b.title) || naturalCompare(a.id, b.id));
  return { ...status, loaded };
}
async function reload(progress?: (value: DictionaryImportProgress) => void): Promise<DictionaryStatus> {
  loaded = false;
  const status = sortStatus(await native('dict:status') as DictionaryStatus);
  const next = emptyTermIndex();
  const enabled = status.dictionaries.filter(dict => dict.enabled);
  for (const [i, dict] of enabled.entries()) {
    progress?.({ stage: 'indexing', message: `正在加载词典索引：${dict.title}`, done: i, total: enabled.length, unit: 'dictionaries' });
    const data = await native('dict:data', dict.id) as { terms: string; frequencies: string };
    addDictionaryToIndex(next, dict, JSON.parse(data.terms), JSON.parse(data.frequencies));
    progress?.({ stage: 'indexing', message: `已加载词典索引：${dict.title}`, done: i + 1, total: enabled.length, unit: 'dictionaries' });
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  index = next; loaded = true;
  const result = { ...status, loaded };
  self.postMessage({ kind: 'event', channel: 'dict:changed', payload: result });
  return result;
}
async function dispatch(channel: string, args: any[]): Promise<unknown> {
  if (channel === 'library:import') {
    return imports.enqueue(args[0]);
  }
  if (channel === 'library:importQueue') return imports.snapshot();
  if (channel === 'library:cancelImport') return imports.cancel(args[0]);
  if (channel === 'library:dismissImport') return imports.dismiss(args[0]);
  if (channel === 'library:importProgress') { const { taskId, ...progress } = args[0]; imports.progress(taskId, progress); return null; }
  if (channel.startsWith('segment:')) return segments.request(channel, args);
  if (channel === 'dict:importQueue') return dictionaryImports.snapshot();
  if (channel === 'dict:cancelImport') return dictionaryImports.cancel(args[0]);
  if (channel === 'dict:dismissImport') return dictionaryImports.dismiss(args[0]);
  if (channel === 'dict:importProgress') { const { taskId, ...progress } = args[0]; dictionaryImports.progress(taskId, progress); return null; }
  switch (channel) {
    case 'dict:initialize': case 'dict:reload': return serialize(() => reload());
    case 'dict:status': return sortStatus(await native('dict:status') as DictionaryStatus);
    case 'dict:lookup': {
      const result = lookup(args[0], args[1] ?? 0, index);
      const clean = (value: GlossaryContent): GlossaryContent => typeof value === 'string' ? sanitizeGlossaryHtml(value)
        : Array.isArray(value) ? value.map(clean) : { ...value, content: clean(value.content) };
      return { ...result, results: result.results.map(result => ({ ...result, term: { ...result.term, glossary: clean(result.term.glossary) } })) };
    }
    case 'dict:studyEvidence': {
      await mutation; if (!loaded) await serialize(reload);
      const wanted = new Set<string>(args[0]);
      return Object.fromEntries([...wanted].map(expression => [expression, lookup(expression,0,index).results.map(hit=>hit.term)]));
    }
    case 'dict:segment': return segment(args[0], index);
    case 'dict:import': return dictionaryImports.enqueue(args[0]);
    case 'dict:remove': case 'dict:setEnabled': return serialize(async () => {
      await native(channel, ...args); return reload();
    });
    default: throw new Error(`未知词典 Worker 请求：${channel}`);
  }
}
self.onmessage = (event: MessageEvent) => {
  const message = event.data;
  if (message.kind === 'native-result') {
    const item = pending.get(message.id); pending.delete(message.id);
    if (message.error !== undefined) item?.reject(new Error(message.error)); else item?.resolve(message.value);
    return;
  }
  void dispatch(message.channel, message.args).then(
    value => self.postMessage({ kind: 'result', id: message.id, value }),
    error => self.postMessage({ kind: 'result', id: message.id, error: String(error) }),
  );
};
