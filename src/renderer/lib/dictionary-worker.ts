import { addDictionaryToIndex, emptyTermIndex, parseTermRow, parseMetaRow, parseFrequencyData, frequencyKey, type StoredFrequency } from '@core/dict/model';
import { lookup, segment } from '@core/dict/lookup';
import { naturalCompare } from '@core/util/natural-sort';
import type { DictionaryStatus, DictTerm } from '@shared/types';
import { TauriSegments } from './tauri-segments';
import { sanitizeGlossaryHtml } from '@core/dict/glossary';
import type { GlossaryContent } from '@shared/types';
import { importBooks } from './tauri-epub';

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
let bookImports: Promise<unknown> = Promise.resolve();
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
async function reload(): Promise<DictionaryStatus> {
  loaded = false;
  const status = sortStatus(await native('dict:status') as DictionaryStatus);
  const next = emptyTermIndex();
  for (const dict of status.dictionaries) {
    if (!dict.enabled) continue;
    const data = await native('dict:data', dict.id) as { terms: string; frequencies: string };
    addDictionaryToIndex(next, dict, JSON.parse(data.terms), JSON.parse(data.frequencies));
  }
  index = next; loaded = true;
  const result = { ...status, loaded };
  self.postMessage({ kind: 'event', channel: 'dict:changed', payload: result });
  return result;
}
async function importOne(path: string): Promise<void> {
  const staged = await native('dict:stage', path) as { id: string; title: string; format: number | null; banks: string[] };
  try {
    if (staged.format !== null && staged.format !== 3) console.warn(`[dict] ${staged.title}: format=${staged.format}, 按 v3 解析`);
    const terms: DictTerm[] = [];
    const frequencies = new Map<string, StoredFrequency>();
    let skipped = 0;
    for (const bank of staged.banks.sort(naturalCompare)) {
      const raw = await native('dict:rawBank', staged.id, bank) as string;
      let rows: unknown;
      try { rows = JSON.parse(raw); } catch { skipped++; continue; }
      if (!Array.isArray(rows)) { skipped++; continue; }
      for (const row of rows) {
        if (bank.startsWith('term_bank_')) {
          const term = parseTermRow(row, staged.id, staged.title);
          if (term) terms.push(term); else skipped++;
        } else {
          const meta = parseMetaRow(row);
          if (!meta) { skipped++; continue; }
          if (meta.mode !== 'freq') continue;
          const value = parseFrequencyData(meta.data);
          if (!value) { skipped++; continue; }
          const key = frequencyKey(meta.expression, value.reading);
          let record = frequencies.get(key);
          if (!record) { record = { expression: meta.expression, reading: value.reading, frequencies: [] }; frequencies.set(key, record); }
          record.frequencies.push({ value: value.value, display: value.display, dictionary: staged.title });
        }
      }
    }
    if (skipped) console.warn(`[dict] ${staged.title}: 跳过 ${skipped} 行/bank`);
    await native('dict:commit', staged.id, JSON.stringify(terms), JSON.stringify([...frequencies.values()]));
  } catch (error) {
    await native('dict:discard', staged.id).catch(() => undefined); throw error;
  }
}
async function dispatch(channel: string, args: any[]): Promise<unknown> {
  if (channel === 'library:import') {
    const task = bookImports.then(() => importBooks(native, args[0]));
    bookImports = task.catch(() => undefined);
    return task;
  }
  if (channel.startsWith('segment:')) return segments.request(channel, args);
  switch (channel) {
    case 'dict:initialize': return serialize(reload);
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
    case 'dict:import': return serialize(async () => {
      try { for (const path of args[0] as string[]) await importOne(path); }
      finally { await reload(); } // A later failed ZIP must not hide earlier successful imports.
      return sortStatus(await native('dict:status') as DictionaryStatus);
    });
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
