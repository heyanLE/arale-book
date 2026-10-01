/**
 * 扩展下载器：HTTPS 取文件 → 流式落盘 → sha256 校验。
 *
 * ## 三条不可妥协的规则
 *
 * 1. **只允许 https**。清单是远端来的，明文 http 等于谁都能在中间改包。
 * 2. **sha256 必填且必须校验通过**。没有校验的下载器就是把「用户磁盘上跑什么代码」
 *    的决定权交给网络中间人。校验不过就删掉写下来的文件，绝不留下半份。
 * 3. **流式落盘**。扩展归档在 700 MB 级别，整个读进内存再写盘会在低配机器上直接 OOM。
 *
 * 另外还有两条是「用户体验」而不是「安全」：
 * - 失败时把 HTTP 状态码、URL、已下字节一起报出来。只报「下载失败」的话，用户既不知道
 *   是网络问题还是文件没了，也不知道该不该重试。
 * - 进度回调按节流发（默认 250 ms 一次），否则 700 MB 会产生上万次事件把 IPC 打满。
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';

export interface DownloadOptions {
  url: string;
  /** 落盘路径（调用方负责目录已存在）。 */
  dest: string;
  /** 进度节流间隔（ms）。 */
  throttleMs?: number;
  onProgress?: (received: number, total: number) => void;
  /** 取消检查：为真时中止并抛 `DownloadCancelledError`。 */
  isCancelled?: () => boolean;
}

export class DownloadError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

/** 用户主动取消（不算失败，调用方要区别对待）。 */
export class DownloadCancelledError extends Error {
  constructor() {
    super('已取消下载');
    this.name = 'DownloadCancelledError';
  }
}

/** 同一时刻只允许一个扩展在装：并发下载几个 700 MB 的包只会互相拖慢。 */

const MAX_REDIRECTS = 5;

export async function downloadToFile(options: DownloadOptions): Promise<{ bytes: number; sha256: string }> {
  const throttleMs = options.throttleMs ?? 250;
  let url = options.url;
  let response: IncomingMessage | null = null;

  // Node 分支手动跟重定向；Electron 分支在 requestOnce 内检查并跟随。
  // GitHub Releases 会 302 到资产服务器，两条路径都限制 HTTPS 与跳转次数。
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (options.isCancelled?.()) throw new DownloadCancelledError();
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      throw new DownloadError('扩展下载只允许 HTTPS', `被拒绝的地址：${url}`);
    }
    response = await requestOnce(parsed, options.isCancelled);
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      const location = response.headers.location;
      response.resume();
      if (hop === MAX_REDIRECTS) {
        response.destroy();
        throw new DownloadError('重定向次数过多', options.url);
      }
      if (typeof location !== 'string' || location === '') {
        throw new DownloadError('重定向没有给出新地址', `HTTP ${status} @ ${url}`);
      }
      url = new URL(location, parsed).toString();
      continue;
    }
    if (status !== 200) {
      const body = await readSome(response, 512);
      response.resume();
      throw new DownloadError(
        `服务器返回 HTTP ${status}`,
        [`URL: ${url}`, body.trim() !== '' ? `响应片段：${body.trim()}` : '（空响应）'].join('\n'),
      );
    }
    break;
  }

  if (response === null) throw new DownloadError('下载没有开始', options.url);

  // Chromium 自动解压 HTTP gzip；响应头的长度是压缩前的传输体积，不能用于校验落盘长度。
  const total = process.versions.electron && response.headers['content-encoding']
    ? 0 : Number(response.headers['content-length'] ?? 0) || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(options.dest);
  let received = 0;
  let lastTick = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      // 断流/取消不能依赖下一个 data 事件，否则服务器停住时界面一直等待。
      let lastActivity = Date.now();
      let ended = false;
      const watchdog = setInterval(() => {
        const error = options.isCancelled?.() ? new DownloadCancelledError()
          : Date.now() - lastActivity > 30_000 ? new DownloadError('下载超时', `URL: ${url}\n已下载 ${received} 字节，30 秒未收到数据`) : null;
        if (error) { response?.destroy(); out.destroy(); reject(error); }
      }, 250);
      const cleanup = (): void => { clearInterval(watchdog); };
      out.once('close', cleanup);
      response.once('close', () => {
        if (!ended) {
          out.destroy();
          reject(new DownloadError('下载中断', `URL: ${url}\n已下载 ${received} 字节`));
        }
      });
      const onData = (chunk: Buffer): void => {
        lastActivity = Date.now();
        if (options.isCancelled?.() === true) {
          response?.destroy();
          out.destroy();
          reject(new DownloadCancelledError());
          return;
        }
        received += chunk.length;
        hash.update(chunk);
        if (!out.write(chunk)) {
          // 背压：等的过程中不要继续读，否则内存里会堆一大坨。
          response?.pause();
          out.once('drain', () => response?.resume());
        }
        const now = Date.now();
        if (now - lastTick >= throttleMs) {
          lastTick = now;
          options.onProgress?.(received, total);
        }
      };
      response.on('data', onData);
      response.on('end', () => {
        ended = true;
        cleanup();
        out.end(() => {
          options.onProgress?.(received, total);
          resolve();
        });
      });
      response.on('error', (error: Error) => {
        out.destroy();
        reject(new DownloadError('下载中断', error.message));
      });
      out.on('error', (error: Error) => {
        response.destroy();
        reject(new DownloadError('写入失败', error.message));
      });
    });
  } catch (error) {
    // 失败就删掉半份文件：留着它会让下一次「继续下载」的判断变得含糊。
    try {
      fs.rmSync(options.dest, { force: true });
    } catch {
      /* 删不掉也无所谓，下次会覆盖 */
    }
    throw error;
  }

  if (total > 0 && received !== total) {
    fs.rmSync(options.dest, { force: true });
    throw new DownloadError('下载不完整', `期望 ${total} 字节，实际 ${received} 字节`);
  }

  return { bytes: received, sha256: hash.digest('hex') };
}

function requestOnce(url: URL, isCancelled?: () => boolean): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const headers = { 'user-agent': 'ARaLeBook/0.1 (+https://github.com/)', accept: '*/*' };
    // Electron 网络栈使用系统代理/PAC；纯 Node 测试保留 https 实现。
    // 两种 response 都提供 Node readable 的 data/end/error 与状态、响应头。
    const request = process.versions.electron
      ? (require('electron') as typeof import('electron')).net.request({ url: url.toString(), redirect: 'manual' })
      : https.get(url, { headers });
    const stop = (): void => { request.abort(); };
    const deadline = setTimeout(() => {
      reject(new DownloadError('连接超时（30 秒）', url.toString()));
      stop();
    }, 30_000);
    const cancellation = setInterval(() => {
      if (isCancelled?.()) { reject(new DownloadCancelledError()); stop(); }
    }, 250);
    const cleanup = (): void => { clearTimeout(deadline); clearInterval(cancellation); };
    (request as EventEmitter).once('response', (response: IncomingMessage) => { cleanup(); resolve(response); });
    request.once('abort', cleanup);
    request.once('close', cleanup);
    request.on('error', (error) => {
      cleanup();
      reject(new DownloadError('无法连接下载服务器', `${url.toString()}\n${error.message}`));
    });
    if (process.versions.electron) {
      let redirects = 0;
      (request as EventEmitter).on('redirect', (_status: number, _method: string, redirectUrl: string) => {
        if (++redirects > MAX_REDIRECTS || new URL(redirectUrl).protocol !== 'https:') {
          cleanup();
          reject(new DownloadError('重定向地址被拒绝', redirectUrl));
          stop();
          return;
        }
        (request as import('electron').ClientRequest).followRedirect();
      });
      for (const [key, value] of Object.entries(headers)) request.setHeader(key, value);
      request.end();
    }
  });
}

/** 读响应体的前 N 字节（用于把服务器的错误信息带给用户）。 */
async function readSome(response: IncomingMessage, limit: number): Promise<string> {
  return await new Promise<string>((resolve) => {
    let text = '';
    const onData = (chunk: Buffer): void => {
      text += chunk.toString('utf8');
      if (text.length >= limit) {
        response.off('data', onData);
        resolve(text.slice(0, limit));
      }
    };
    response.on('data', onData);
    response.on('end', () => resolve(text.slice(0, limit)));
    response.on('error', () => resolve(text));
  });
}
