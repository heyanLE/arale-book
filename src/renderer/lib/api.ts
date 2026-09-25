/**
 * 渲染进程访问主进程的**唯一**入口。
 *
 * 为什么要 `call` / `run` 这层包装：`ipcRenderer.invoke` 返回的 Promise 一旦被拒绝而没人
 * catch，就变成 unhandledrejection —— Electron 里它既不弹窗也不写状态栏，用户只看到
 * 「点了没反应」。所以本文件立一条规矩：**任何** `window.arale.*` 调用都必须经过
 * `call`（拿结果或 null）或 `run`（fire-and-forget），失败统一进错误横幅总线。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AraleApi, AraleEvents, ShellCommand } from '@shared/ipc';
import type { ImportOutcome } from '@shared/types';

/** `window.arale` 的直接别名。preload 没跑起来时它会是 undefined —— 所有调用点都写成
 *  `() => api.x.y()` 的惰性形式，`call`/`run` 里同步抛出的 TypeError 一样会被 catch 住。 */
export const api: AraleApi = window.arale;

// ---------------------------------------------------------------------------
// 错误总线
// ---------------------------------------------------------------------------

export type ApiErrorListener = (message: string) => void;

const errorListeners = new Set<ApiErrorListener>();

/** 订阅全局错误（App 用它渲染顶部错误横幅）。返回取消订阅函数。 */
export function subscribeApiErrors(listener: ApiErrorListener): () => void {
  errorListeners.add(listener);
  return () => {
    errorListeners.delete(listener);
  };
}

function emitApiError(message: string): void {
  for (const listener of errorListeners) listener(message);
}

/** 把一个异常转成给人看的中文消息并广播。 */
export function reportApiError(label: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  const message = detail ? `${label}失败：${detail}` : `${label}失败`;
  // 控制台留全量堆栈，横幅只给人看一句话。
  console.error(`[arale] ${message}`, error);
  emitApiError(message);
}

/** 包装一次 IPC 调用：失败时广播错误并返回 null，绝不向外抛。 */
export async function call<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    reportApiError(label, error);
    return null;
  }
}

/** fire-and-forget 版本：不关心结果，只保证失败不会变成 unhandledrejection。 */
export function run(label: string, fn: () => Promise<unknown>): void {
  void call(label, fn);
}

/** `window.arale.notify` 是同步的，单独包一层 try/catch。 */
export function notifyMain(
  channel: 'renderer:ready' | 'reader:opened' | 'reader:closed',
  payload?: unknown,
): void {
  try {
    window.arale.notify(channel, payload);
  } catch (error) {
    reportApiError('通知主进程', error);
  }
}

/**
 * `arale://` 资源 URL。它是**同步**的纯字符串拼接，正常不会失败，但 preload 缺失时会抛
 * TypeError，所以照样兜住，返回 null 让调用方走占位图。
 */
export function assetUrl(bookId: string, rel: string | null | undefined): string | null {
  if (!rel) return null;
  try {
    return window.arale.book.assetUrl(bookId, rel);
  } catch (error) {
    reportApiError('解析资源地址', error);
    return null;
  }
}

/** 把一批导入结果压成一行状态栏文案（LibraryView 与 App 都要用）。 */
export function summarizeImportOutcome(outcomes: ImportOutcome[]): string {
  if (outcomes.length === 0) return '已取消导入';
  const ok = outcomes.filter((o) => o.ok);
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length === 0) return `已导入 ${ok.length} 本`;
  const first = failed[0]?.error ?? '未知原因';
  if (ok.length === 0) return `导入失败：${first}`;
  return `已导入 ${ok.length} 本，${failed.length} 本失败（${first}）`;
}

// ---------------------------------------------------------------------------
// 主进程 → 渲染进程的事件
// ---------------------------------------------------------------------------

/**
 * 订阅主进程推来的事件。
 *
 * **协议**：`window.arale.on(event, handler)` 返回一个数字订阅号，`off(id)` 退订
 * （见 `shared/ipc.ts` 的 `AraleApi.on`）。**不是** CustomEvent —— 早期版本这里监听的是
 * `window` 上的 `arale:<event>` DOM 事件，而 preload 从来没派发过它们，结果是
 * `library:changed` 永远到不了，导入完书架不刷新。
 *
 * handler 存在 ref 里，所以调用方不必 memo 化回调，重复订阅也不会因为闭包变化而重建。
 */
export function useIpcEvent<K extends keyof AraleEvents>(
  event: K,
  handler: (payload: AraleEvents[K]) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    // preload 没挂上时（开发期配错）静默跳过，让 UI 能起来而不是整页崩。
    if (typeof window.arale?.on !== 'function') return;
    const subscriptionId = window.arale.on(event, (payload) => handlerRef.current(payload));
    return () => {
      try {
        window.arale.off(subscriptionId);
      } catch {
        /* 卸载竞态：preload 已经没了 */
      }
    };
  }, [event]);
}

/** `shell:command` 的便捷订阅（主进程菜单触发的命令）。 */
export function useShellCommand(handler: (command: ShellCommand) => void): void {
  useIpcEvent('shell:command', (payload) => {
    if (payload && typeof payload.command === 'string') handler(payload.command);
  });
}

// ---------------------------------------------------------------------------
// 数据加载
// ---------------------------------------------------------------------------

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

/**
 * 极简数据加载 hook（不引第三方库）。
 *
 * 三个刻意的取舍：
 * - 失败同时写进 `error` 和全局错误总线 —— 前者给内联空态用，后者保证「失败一定看得见」；
 * - reload 时**保留旧 data**，避免刷新书库列表时整页闪空；
 * - 卸载后不再 setState，否则切视图时会报 "state update on unmounted component" 类噪音。
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{ data: T | null; error: Error | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });

  useEffect(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    let pending: Promise<T>;
    try {
      pending = fnRef.current();
    } catch (error) {
      // fn 里同步抛（例如 preload 缺失）也要走同一条错误路径。
      const err = error instanceof Error ? error : new Error(String(error));
      reportApiError('加载', err);
      setState((prev) => ({ ...prev, loading: false, error: err }));
      return () => {
        alive = false;
      };
    }

    pending.then(
      (data) => {
        if (alive) setState({ data, error: null, loading: false });
      },
      (error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        reportApiError('加载', err);
        if (alive) setState((prev) => ({ data: prev.data, error: err, loading: false }));
      },
    );

    return () => {
      alive = false;
    };
    // deps 由调用方给出，加上 nonce 让 reload() 生效。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data: state.data, error: state.error, loading: state.loading, reload };
}
