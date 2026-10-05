import { createAraleApi } from '@shared/api-bridge';
import { EVENT_CHANNEL, type AraleEvents } from '@shared/ipc';
import { createTauriDictionary } from './tauri-dictionary';

interface TauriGlobals {
  core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
  event: { listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> };
}

declare global {
  interface Window { __TAURI__?: TauriGlobals; }
}

export const isTauri = !!window.__TAURI__;
let bridgeReady: Promise<void> = Promise.resolve();

// This module is imported before lib/api captures window.arale. The subscription map
// is synchronous; mounting React waits for the native event subscriptions below.
if (window.__TAURI__ && !window.arale) {
  const tauri = window.__TAURI__;
  let nextId = 1;
  const subscriptions = new Map<number, { channel: string; handler: (payload: unknown) => void }>();
  const deliver = (channel: string, payload: unknown) => {
    for (const item of [...subscriptions.values()]) {
      if (item.channel !== channel) continue;
      try { item.handler(payload); } catch (error) { console.error(`[arale] event ${channel}`, error); }
    }
  };
  const native = (channel: string, ...args: unknown[]) => tauri.core.invoke('arale_invoke', { channel, args: args.map(arg => arg === undefined ? null : arg) });
  const dictionary = createTauriDictionary(native, deliver);
  const services = createTauriDictionary(native, deliver, new Worker(new URL('./services-worker.ts', import.meta.url), { type: 'module' }));
  const study = createTauriDictionary((channel, ...args) => channel === 'dict:studyEvidence' ? dictionary.invoke(channel, ...args) : native(channel, ...args), deliver,
    new Worker(new URL('./study-worker.ts', import.meta.url), { type: 'module' }));
  window.arale = createAraleApi({
    invoke: (channel, ...args) => channel.startsWith('study:') ? study.invoke(channel, ...args) : channel.startsWith('llm:') || channel.startsWith('translation:') ? services.invoke(channel, ...args) : channel.startsWith('dict:') || channel.startsWith('segment:') || channel === 'library:import' || channel === 'library:importDialog' ? dictionary.invoke(channel, ...args) : native(channel, ...args),
    assetUrl: (bookId, relative) => {
      const path = [bookId, ...relative.replace(/\\/g, '/').split('/')].map(encodeURIComponent).join('/');
      // Wry exposes custom protocols through <scheme>.localhost on Windows.
      return navigator.userAgent.includes('Windows') ? `http://arale.localhost/${path}` : `arale://localhost/${path}`;
    },
    on: <K extends keyof AraleEvents>(channel: K, handler: (payload: AraleEvents[K]) => void) => {
      const id = nextId++;
      subscriptions.set(id, { channel, handler: handler as (payload: unknown) => void });
      return id;
    },
    off: id => { subscriptions.delete(id); },
    notify: (channel) => {
      void tauri.core.invoke('arale_notify', { channel }).catch(error => console.error('[arale] notify', error));
      if (channel === 'renderer:ready') {
        void dictionary.initialize();
        void services.invoke('ocr:initialize').catch(error => console.error('[arale] OCR recovery', error));
        void study.invoke('study:initialize').catch(error => console.error('[arale] study recovery', error));
      }
    },
  });
  bridgeReady = Promise.all([
    tauri.event.listen<{ channel: string; payload: unknown }>(EVENT_CHANNEL, event => {
      if (event.payload.channel === 'ocr:convert') void services.invoke('ocr:finalize').catch(error => console.error('[arale] OCR conversion', error));
      else deliver(event.payload.channel, event.payload.payload);
    }),
    tauri.event.listen<{ paths: string[] }>('tauri://drag-drop', event => deliver('shell:openFiles', { paths: event.payload.paths })),
  ]).then(() => undefined);
}

export { bridgeReady };
