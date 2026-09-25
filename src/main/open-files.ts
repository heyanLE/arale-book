/**
 * 「用 aralebook 打开这些文件」的接收与派发。
 *
 * 三个来源都要接住（这是桌面应用区别于网页的地方）：
 * - macOS 的 `open-file`：在 Dock 上把文件拖到图标、右键「打开方式」；
 * - Windows/Linux 的命令行参数：`aralebook book.epub`；
 * - 第二个实例被启动时，由单实例锁转发的参数。
 *
 * **队列是必须的**：macOS 上 `open-file` 经常在窗口建好之前就到达，那时候派发事件
 * 没有任何人听。所以先攒着，等渲染进程 `did-finish-load` 再一次性送过去。
 *
 * 抽成独立模块（而不是写在 index.ts 里）是为了能单测：`index.ts` 一被 import 就会
 * 注册协议、建窗口，没法在测试里碰。
 */

import * as fs from 'node:fs';

/**
 * 从 `process.argv` 里挑出可能的书路径。
 *
 * `slice(1)` 跳过可执行文件本身（在开发模式下它是 `electron` 二进制，生产模式下是
 * 应用路径）。以 `-` 开头的都是 Chromium/Electron 开关，不是文件。
 */
export function openFilesFromArgv(argv: readonly string[]): string[] {
  return argv
    .slice(1)
    .filter((arg) => typeof arg === 'string' && arg.length > 0 && !arg.startsWith('-') && arg !== '.');
}

export interface OpenFileQueueOptions {
  /** 存在性判定。默认 `fs.existsSync`；测试可注入。 */
  exists?: (filePath: string) => boolean;
}

export class OpenFileQueue {
  private readonly pending: string[] = [];
  private readonly exists: (filePath: string) => boolean;
  private sink: ((paths: string[]) => void) | null = null;
  private ready = false;

  constructor(options: OpenFileQueueOptions = {}) {
    this.exists = options.exists ?? ((filePath) => {
      try {
        return fs.existsSync(filePath);
      } catch {
        return false;
      }
    });
  }

  /** 渲染进程是否已经能收事件。 */
  setReady(ready: boolean): void {
    this.ready = ready;
    if (ready) this.flush();
  }

  /** 设置派发目标（主进程里就是 `emitEvent('shell:openFiles', …)`）。 */
  setSink(sink: (paths: string[]) => void): void {
    this.sink = sink;
    this.flush();
  }

  /**
   * 入队。不存在的路径**直接丢弃**：命令行里带 Chromium 开关、或者系统给了个已经被
   * 删掉的文件，都不该让 UI 弹一个「导入失败」。
   */
  push(paths: readonly string[]): void {
    for (const filePath of paths) {
      if (typeof filePath !== 'string' || filePath.length === 0) continue;
      if (!this.exists(filePath)) continue;
      this.pending.push(filePath);
    }
    this.flush();
  }

  /** 当前攒了多少（测试用）。 */
  get size(): number {
    return this.pending.length;
  }

  /** 条件不满足就继续攒着——下次 `setReady`/`setSink`/`push` 会再试。 */
  private flush(): void {
    if (!this.ready || !this.sink || this.pending.length === 0) return;
    const paths = this.pending.splice(0, this.pending.length);
    this.sink(paths);
  }
}
