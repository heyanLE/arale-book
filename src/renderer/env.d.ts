/// <reference types="vite/client" />

import type { AraleApi } from '@shared/ipc';

/**
 * Tauri API bridge把 `AraleApi` 挂到 `window.arale`（见 src/shared/ipc.ts）。
 *
 * 注意 `AraleApi` 里**只有** `notify` 是渲染进程 → 主进程方向；主进程 → 渲染进程的事件
 * 走的是 `window` 上的 `CustomEvent`（`arale:<event>`），类型在 `AraleEvents` 里。
 * 订阅统一用 `lib/api.ts` 的 `useIpcEvent`。
 */
declare global {
  interface Window {
    /** 由 Tauri API bridge 在页面启动时提供。 */
    arale: AraleApi;
  }
}

export {};
