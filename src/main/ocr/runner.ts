/**
 * OCR 运行进程的**通用启动器**。
 *
 * 系统 OCR（Vision 小工具）与扩展提供的 runner 都从这里走：它们说的是同一种
 * NDJSON（见 `shared/ocr-protocol.ts`），所以主进程只需要一个启动器。
 *
 * 这一层负责四件引擎实现不该各自重复的事：
 * 1. **分片安全的行解析**（子进程输出按任意边界分片）；
 * 2. **进度回调**（每页一行 → 一次 `onPage`）；
 * 3. **取消**（kill 掉整棵进程树，而不是只 kill 父进程——runner 往往是个 shell 脚本，
 *    真正的 Python/二进制是它的子进程，只 kill 父进程会留下孤儿继续烧 CPU）；
 * 4. **stderr 收集**（进程失败时把最后几行日志一起报出来，否则用户只看得到
 *    「退出码 1」，完全不知道发生了什么）。
 */

import { spawn } from 'node:child_process';

import {
  parseOcrStreamLine,
  splitOcrStreamChunk,
  type OcrPageOut,
  type OcrProbeOut,
} from '../../shared/ocr-protocol';

export interface RunOcrProcessOptions {
  program: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 每页一次。返回的 Promise 会被 await，便于调用方做背压（比如写盘）。 */
  onPage?: (page: OcrPageOut) => void | Promise<void>;
  /** 首行元信息。 */
  onMeta?: (meta: { engine: string; languages: string[]; requested: string[] }) => void;
  /** 认不出来的行（调试用）。 */
  onUnknownLine?: (line: string) => void;
  /** 自检结果（`--probe` 模式）。 */
  onProbe?: (probe: OcrProbeOut) => void;
  /** 运行进程自报的致命错误。 */
  onFatal?: (error: string) => void;
  isCancelled?: () => boolean;
  /** stderr 保留多少行（默认 40）。日志可能很长，只留尾部。 */
  stderrLines?: number;
}

export interface RunOcrProcessResult {
  /** 进程退出码。被我们 kill 掉时是 null（signal）。 */
  code: number | null;
  signal: NodeJS.Signals | null;
  /** 是否由调用方取消。 */
  cancelled: boolean;
  /** 正常结束的页数。 */
  pages: number;
  /** 单页失败的页数（不算整本失败）。 */
  failedPages: number;
  /** stderr 的尾部若干行，用于报错。 */
  stderr: string;
  /** 认不出来的行数。 */
  unknownLines: number;
  fatal: string | null;
  /** 自检结果；没跑 `--probe` 时是 null。 */
  probe: OcrProbeOut | null;
}

/**
 * 跑一个 OCR 进程，边收边回调。
 *
 * **永不抛**：所有失败都归到返回值里。调用方（引擎）再决定怎么变成用户看到的错误。
 */
export async function runOcrProcess(
  options: RunOcrProcessOptions,
): Promise<RunOcrProcessResult> {
  const keepLines = options.stderrLines ?? 40;

  return await new Promise<RunOcrProcessResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.program, options.args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        // stdin 关掉：没有引擎需要它，留着反而会让子进程以为可以交互式提问。
        stdio: ['ignore', 'pipe', 'pipe'],
        // 自己起进程组，取消时能整组 kill（见文件头第 3 条）。
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        cancelled: false,
        pages: 0,
        failedPages: 0,
        stderr: error instanceof Error ? error.message : String(error),
        unknownLines: 0,
        fatal: '启动 OCR 进程失败',
        probe: null,
      });
      return;
    }

    const state: RunOcrProcessResult = {
      code: null,
      signal: null,
      cancelled: false,
      pages: 0,
      failedPages: 0,
      stderr: '',
      unknownLines: 0,
      fatal: null,
      probe: null,
    };
    const stderrTail: string[] = [];
    let stdoutRest = '';
    let settled = false;
    // stdout 的事件是按 chunk 同步回调的，而 onPage 可能是异步的（写盘、发进度）。
    // 串成一条 Promise 链，保证「回调按行顺序执行完」；否则第 3 页的写盘可能
    // 早于第 2 页完成，最终文字层的页序会错。
    let chain: Promise<void> = Promise.resolve();

    const killTree = (): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') child.kill();
        // 负 pid = 整个进程组。
        else process.kill(-child.pid, 'SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {
          /* 已经退出了 */
        }
      }
    };

    const cancelPoll = setInterval(() => {
      if (options.isCancelled?.() === true && !state.cancelled) {
        state.cancelled = true;
        killTree();
      }
    }, 200);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      const { lines, rest } = splitOcrStreamChunk(stdoutRest + chunk);
      stdoutRest = rest;
      for (const line of lines) {
        const event = parseOcrStreamLine(line);
        if (event.kind === 'unknown') {
          state.unknownLines += 1;
          options.onUnknownLine?.(line);
          continue;
        }
        if (event.kind === 'meta') {
          void chain.then(() => options.onMeta?.(event.meta));
          continue;
        }
        if (event.kind === 'probe') {
          state.probe = event.probe;
          options.onProbe?.(event.probe);
          continue;
        }
        if (event.kind === 'fatal') {
          state.fatal = event.error;
          options.onFatal?.(event.error);
          continue;
        }
        if (event.page.ok) state.pages += 1;
        else state.failedPages += 1;
        const page = event.page;
        chain = chain.then(() => options.onPage?.(page));
      }
    });

    let stderrRest = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      const { lines, rest } = splitOcrStreamChunk(stderrRest + chunk);
      stderrRest = rest;
      for (const line of lines) stderrTail.push(line);
      // 只留尾部：日志可能有几万行（torch 的警告），而报错时用户只需要看最后几行。
      while (stderrTail.length > keepLines) stderrTail.shift();
    });

    const flushStderrRest = (): void => {
      if (stderrRest.trim() !== '') stderrTail.push(stderrRest);
      stderrRest = '';
      while (stderrTail.length > keepLines) stderrTail.shift();
      state.stderr = stderrTail.join('\n').trim();
    };

    child.on('error', (error) => {
      // 进程根本没起来（ENOENT：runner 不存在 / 没有执行权限）。
      if (settled) return;
      settled = true;
      clearInterval(cancelPoll);
      flushStderrRest();
      state.stderr = `${state.stderr}\n${error.message}`.trim();
      state.fatal = state.fatal ?? '无法启动 OCR 运行进程';
      resolve(state);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearInterval(cancelPoll);
      // 最后一行的尾巴还没有换行符时也算完整的一行。
      if (stdoutRest.trim() !== '') {
        const event = parseOcrStreamLine(stdoutRest);
        if (event.kind === 'page') {
          if (event.page.ok) state.pages += 1;
          else state.failedPages += 1;
          chain = chain.then(() => options.onPage?.(event.page));
        } else if (event.kind === 'probe') {
          state.probe = event.probe;
          options.onProbe?.(event.probe);
        } else if (event.kind === 'fatal') {
          state.fatal = event.error;
        } else if (event.kind === 'meta') {
          chain = chain.then(() => options.onMeta?.(event.meta));
        }
      }
      flushStderrRest();
      state.code = code;
      state.signal = signal;
      // 等回调链跑完再 resolve，否则调用方一拿到结果就去读文字层，
      // 最后几页可能还没写进去。
      void chain.then(() => resolve(state));
    });
  });
}
