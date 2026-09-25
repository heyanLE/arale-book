/**
 * 预加载脚本 —— 渲染进程能碰到的**全部**主进程能力都在这里显式列一遍。
 *
 * 安全姿态：渲染窗口用 `contextIsolation: true` + `nodeIntegration: false` +
 * `sandbox: true`。渲染进程拿不到 `require`、拿不到 `fs`，只有下面这个 `window.arale`
 * 对象。这是把「EPUB 内容里的脚本」与「用户磁盘」隔开的关键一层。
 *
 * 注意：本文件跑在 sandbox 里，**只能** import `electron` / `events` / `timers` / `url`。
 * 尤其不能 import `node:path`——所以 `bookAssetUrl` 实现在 `shared/ipc.ts` 里，纯字符串操作。
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';

import {
  bookAssetUrl,
  EVENT_CHANNEL,
  IPC,
  NOTIFY_CHANNEL,
  type AraleApi,
} from '../shared/ipc';

/**
 * 事件订阅表。
 *
 * `contextBridge` 不能把函数当返回值传回主世界，所以 `on()` 返回的是可克隆的数字
 * 订阅号，渲染进程用它在 `useEffect` 清理里调 `off()`。
 */
let nextSubscriptionId = 1;
const subscriptions = new Map<number, { channel: string; handler: (payload: unknown) => void }>();
let bridgeAttached = false;

function ensureEventBridge(): void {
  if (bridgeAttached) return;
  bridgeAttached = true;
  ipcRenderer.on(EVENT_CHANNEL, (_ipcEvent, message: { channel: string; payload: unknown }) => {
    if (!message) return;
    // 复制一份再遍历：handler 里退订/新订阅不会打断这一轮派发。
    for (const subscription of [...subscriptions.values()]) {
      if (subscription.channel !== message.channel) continue;
      try {
        subscription.handler(message.payload);
      } catch (error) {
        // 监听器抛错不能把 ipcRenderer 的事件循环带崩。
        console.error(`[arale] event handler for ${message.channel} threw`, error);
      }
    }
  });
}

const api: AraleApi = {
  library: {
    info: () => ipcRenderer.invoke(IPC.libraryInfo),
    list: (query) => ipcRenderer.invoke(IPC.libraryList, query),
    importPaths: (paths) => ipcRenderer.invoke(IPC.libraryImport, paths),
    importViaDialog: () => ipcRenderer.invoke(IPC.libraryImportDialog),
    remove: (bookIds) => ipcRenderer.invoke(IPC.libraryRemove, bookIds),
    open: (bookId) => ipcRenderer.invoke(IPC.libraryOpen, bookId),
    savePosition: (position) => ipcRenderer.invoke(IPC.librarySavePosition, position),
    updateMeta: (bookId, patch) => ipcRenderer.invoke(IPC.libraryUpdateMeta, bookId, patch),
    reveal: (bookId) => ipcRenderer.invoke(IPC.libraryReveal, bookId),
  },
  book: {
    chapter: (bookId, spineIndex) => ipcRenderer.invoke(IPC.chapterContent, bookId, spineIndex),
    pageText: (bookId, pageIndex) => ipcRenderer.invoke(IPC.comicPageText, bookId, pageIndex),
    assetUrl: (bookId, rel) => bookAssetUrl(bookId, rel),
  },
  paths: {
    // `webUtils.getPathForFile` 必须在预加载里调用：渲染进程拿不到 webUtils，而
    // `File.path` 从 Electron 32 起已被移除。`File` 对象经 contextBridge 代理传过来
    // 仍然指向同一个底层对象，所以这里能正确解析。
    forFile: (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
  },
  dict: {
    status: () => ipcRenderer.invoke(IPC.dictStatus),
    importPaths: (zipPaths) => ipcRenderer.invoke(IPC.dictImport, zipPaths),
    importViaDialog: () => ipcRenderer.invoke(IPC.dictImportDialog),
    remove: (dictId) => ipcRenderer.invoke(IPC.dictRemove, dictId),
    setEnabled: (dictId, enabled) => ipcRenderer.invoke(IPC.dictSetEnabled, dictId, enabled),
    lookup: (text, charOffset) => ipcRenderer.invoke(IPC.dictLookup, text, charOffset),
    segment: (text) => ipcRenderer.invoke(IPC.dictSegment, text),
  },
  ocr: {
    capability: () => ipcRenderer.invoke(IPC.ocrCapability),
    status: (bookId) => ipcRenderer.invoke(IPC.ocrStatus, bookId),
    start: (bookId, options) => ipcRenderer.invoke(IPC.ocrStart, bookId, options),
    cancel: (bookId) => ipcRenderer.invoke(IPC.ocrCancel, bookId),
    queue: () => ipcRenderer.invoke(IPC.ocrQueue),
    selectProvider: (provider) => ipcRenderer.invoke(IPC.ocrSelectProvider, provider),
  },
  extensions: {
    list: () => ipcRenderer.invoke(IPC.extensionsList),
    refresh: () => ipcRenderer.invoke(IPC.extensionsRefresh),
    install: (id) => ipcRenderer.invoke(IPC.extensionsInstall, id),
    cancel: (id) => ipcRenderer.invoke(IPC.extensionsCancel, id),
    remove: (id) => ipcRenderer.invoke(IPC.extensionsRemove, id),
  },
  defaults: {
    read: () => ipcRenderer.invoke(IPC.defaultsRead),
    write: (patch) => ipcRenderer.invoke(IPC.defaultsWrite, patch),
  },
  cards: {
    list: (bookId) => ipcRenderer.invoke(IPC.cardsList, bookId),
    add: (bookId, draft) => ipcRenderer.invoke(IPC.cardsAdd, bookId, draft),
    update: (bookId, id, patch) => ipcRenderer.invoke(IPC.cardsUpdate, bookId, id, patch),
    remove: (bookId, id) => ipcRenderer.invoke(IPC.cardsRemove, bookId, id),
  },
  llm: {
    settings: () => ipcRenderer.invoke(IPC.llmSettings),
    update: (patch) => ipcRenderer.invoke(IPC.llmUpdate, patch),
    setApiKey: (profileId, apiKey) => ipcRenderer.invoke(IPC.llmSetApiKey, profileId, apiKey),
    analyze: (request) => ipcRenderer.invoke(IPC.llmAnalyze, request),
  },
  segment: {
    status: (bookId) => ipcRenderer.invoke(IPC.segmentStatus, bookId),
    read: (bookId) => ipcRenderer.invoke(IPC.segmentRead, bookId),
    start: (bookId, options) => ipcRenderer.invoke(IPC.segmentStart, bookId, options),
    cancel: (bookId) => ipcRenderer.invoke(IPC.segmentCancel, bookId),
    clear: (bookId) => ipcRenderer.invoke(IPC.segmentClear, bookId),
  },
  on: (event, handler) => {
    ensureEventBridge();
    const id = nextSubscriptionId++;
    subscriptions.set(id, {
      channel: String(event),
      // 这里的断言是必要的：`AraleEvents[K]` 在泛型擦除后无法与运行时频道名对应，
      // 而「频道名 → 载荷类型」的映射由 `shared/ipc.ts` 的 `AraleEvents` 一处维护。
      handler: handler as (payload: unknown) => void,
    });
    return id;
  },
  off: (subscriptionId) => {
    subscriptions.delete(subscriptionId);
  },
  notify: (channel, payload) => {
    ipcRenderer.send(NOTIFY_CHANNEL, channel, payload);
  },
};

contextBridge.exposeInMainWorld('arale', api);
