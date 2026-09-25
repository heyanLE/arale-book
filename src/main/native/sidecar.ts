/**
 * `arale-native` sidecar 的 Node 侧客户端。
 *
 * 设计要点：
 * - **异步 spawn，不用 `spawnSync`**：解一个几 GB 的漫画包会阻塞主进程事件循环，
 *   整个窗口包括关闭按钮都会卡住。
 * - **stdout 只当 JSON 读**：协议保证 stdout 只有一行 JSON，日志全在 stderr。
 *   所以 stderr 被收集起来，只在失败时拼进错误消息给用户看。
 * - **二进制缺失不是崩溃，是功能降级**：`.zip/.cbz` 走纯 JS 的 fflate，本来就不需要
 *   原生层。所以缺二进制时抛一个带「怎么修」的 `NativeUnavailableError`，导入器把它
 *   变成一条人话错误，而不是让整个应用挂掉。
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { NativeExtractResult, NativeProbeResult } from '../../shared/native-protocol';

/** 找不到原生二进制时抛它——调用方据此给出「怎么修」的提示。 */
export class NativeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeUnavailableError';
  }
}

/** sidecar 自己报告的失败（退出码 1，stdout 里带 `ok:false`）。 */
export class NativeCommandError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = 'NativeCommandError';
  }
}

let cachedBinary: string | null | undefined;

/**
 * 解析原生二进制的路径。
 *
 * 搜索顺序（打包与开发两种布局都要能跑）：
 * 1. `ARALE_NATIVE_BIN` 环境变量（测试与排障用）；
 * 2. 打包后的 `resources/native/arale-native`（electron-builder 的 extraResources）；
 * 3. 开发态的 `native/arale-native/target/release/arale-native`。
 *
 * 找不到返回 `null` 并**缓存**结果，避免每次导入都去 stat 一遍文件系统。
 */
export function resolveNativeBinary(): string | null {
  if (cachedBinary !== undefined) return cachedBinary;

  const exeName = process.platform === 'win32' ? 'arale-native.exe' : 'arale-native';
  const candidates: string[] = [];

  const fromEnv = process.env['ARALE_NATIVE_BIN'];
  if (fromEnv) candidates.push(fromEnv);

  // 打包后：<resources>/native/arale-native
  candidates.push(path.join(process.resourcesPath ?? '', 'native', exeName));
  // 开发态：dist/main/native/sidecar.js → ../../../native/arale-native/target/release/
  candidates.push(path.join(__dirname, '..', '..', '..', 'native', 'arale-native', 'target', 'release', exeName));
  // 保险：从 cwd 找
  candidates.push(path.join(process.cwd(), 'native', 'arale-native', 'target', 'release', exeName));

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.statSync(candidate).isFile()) {
        cachedBinary = candidate;
        return candidate;
      }
    } catch {
      /* 试下一个 */
    }
  }
  cachedBinary = null;
  return null;
}

/** 测试用：清掉二进制路径缓存。 */
export function resetNativeBinaryCache(): void {
  cachedBinary = undefined;
}

function unavailableMessage(): string {
  return [
    '缺少原生解包组件，无法读取 .rar / .cbr / .7z / .cb7。',
    '修复：安装 Rust 后运行 `npm run build:native`（详见 README 的「原生 sidecar」一节）。',
    '或者：把压缩包转成 .cbz / .zip 再导入（这两种格式不需要原生组件）。',
  ].join(' ');
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 跑一次 sidecar。
 *
 * `maxBuffer` 不设：`extract` 的输出可能很大（几千个条目），但我们只读 JSON，
 * 而 Node 的 spawn 是流式的，不存在缓冲区上限问题——所以这里手动累积并设个上限
 * 防止 stderr 无限增长（真出问题时要的是那句话，不是整本日志）。
 */
function runNative(args: string[], timeoutMs = 30 * 60 * 1000): Promise<RunResult> {
  const binary = resolveNativeBinary();
  if (!binary) return Promise.reject(new NativeUnavailableError(unavailableMessage()));

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`原生解包超时（${Math.round(timeoutMs / 1000)} 秒）：${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      // 只留最后 32KB：真出问题时有用的是结尾那段。
      stderrBytes += chunk.length;
      stderrChunks.push(chunk);
      while (stderrBytes > 32 * 1024 && stderrChunks.length > 0) {
        stderrBytes -= stderrChunks.shift()?.length ?? 0;
      }
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动原生解包组件：${error.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

/** 从 sidecar 的 stdout 里取那唯一一个 JSON 对象。 */
function parseJsonStdout<T>(result: RunResult, what: string): T {
  const text = result.stdout.trim();
  if (text === '') {
    throw new NativeCommandError(
      `${what}失败：原生组件没有任何输出（退出码 ${result.code}）`,
      result.stderr.trim(),
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new NativeCommandError(
      `${what}失败：原生组件输出了无法解析的内容`,
      `${result.stderr.trim()}\n--- stdout 前 500 字节 ---\n${text.slice(0, 500)}`,
    );
  }
}

/** 探测压缩包。失败时抛 `NativeCommandError`（`ok:false`）或 `NativeUnavailableError`。 */
export async function probeArchive(input: string): Promise<NativeProbeResult> {
  const result = await runNative(['probe', '--input', input], 2 * 60 * 1000);
  const parsed = parseJsonStdout<NativeProbeResult>(result, '探测压缩包');
  if (!parsed.ok) {
    throw new NativeCommandError(parsed.error ?? '原生组件报告探测失败', result.stderr.trim());
  }
  return parsed;
}

/** 解包。`imagesOnly` 时只写页图。 */
export async function extractArchive(
  input: string,
  outDir: string,
  imagesOnly: boolean,
): Promise<NativeExtractResult> {
  const args = ['extract', '--input', input, '--out', outDir];
  if (imagesOnly) args.push('--images-only');
  const result = await runNative(args);
  const parsed = parseJsonStdout<NativeExtractResult>(result, '解包');
  if (!parsed.ok) {
    throw new NativeCommandError(parsed.error ?? '原生组件报告解包失败', result.stderr.trim());
  }
  return parsed;
}

/** 原生层是否可用（UI 用它决定是否把 .rar/.7z 显示成可导入）。 */
export function isNativeAvailable(): boolean {
  return resolveNativeBinary() !== null;
}
