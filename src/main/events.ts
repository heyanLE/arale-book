/**
 * 主进程 → 渲染进程的事件广播。
 *
 * 只有一条 IPC 通道（`EVENT_CHANNEL`），载荷里带逻辑频道名。这样加事件不用动预加载
 * 的白名单，也让「渲染进程能收到什么」集中可审计。
 *
 * **没有窗口时静默丢弃**：`BrowserWindow` 只在 Electron 主进程里存在，而 `main/**`
 * 里有一批值得单测的纯逻辑（OCR 队列、分词编排、导入管线）要在纯 Node 里跑。
 * 所以这里用**延迟 require + 判空**，而不是让每个调用方都包一层 try/catch——
 * 与 `main/paths.ts` 的延迟 require 是同一套做法。
 */

import type { BrowserWindow } from 'electron';

import { EVENT_CHANNEL, type AraleEvents } from '../shared/ipc';

export { EVENT_CHANNEL };

export function emitEvent<K extends keyof AraleEvents>(event: K, payload: AraleEvents[K]): void {
  const windows = allWindows();
  if (windows === null) return;
  const message = { channel: event, payload };
  for (const window of windows) {
    if (window.isDestroyed()) continue;
    window.webContents.send(EVENT_CHANNEL, message);
  }
}

/** 当前窗口列表；不在 Electron 主进程里（纯 Node 测试）返回 null。 */
function allWindows(): BrowserWindow[] | null {
  try {
    // 延迟 require 而不是顶层 import：顶层 `import { BrowserWindow } from 'electron'`
    // 在缺 node_modules/electron/dist 的环境下会让这个模块直接加载失败。
    const electron = require('electron') as typeof import('electron');
    return electron.BrowserWindow?.getAllWindows() ?? null;
  } catch {
    return null;
  }
}
