/**
 * `arale://` 自定义协议 —— 阅读器资源的唯一入口。
 *
 * URL 形状：`arale://<bookId>/<content 内的相对路径>`
 * （`arale://` 注册为 standard scheme，所以 `<bookId>` 是 hostname、其余是 pathname。）
 *
 * 为什么不起本地 HTTP 服务器：起服务器要挑端口、要处理端口占用、要给 127.0.0.1 配
 * 访问控制，而且任何本机进程都能访问那个端口。自定义协议没有这些面。Fushi 用的是
 * 「拦截虚拟 host」的同类做法（analysis 02 §5）。
 *
 * 安全边界只有一条：解析后的路径必须仍在 `<library>/<bookId>/content/` 之内。
 * 所有穿越尝试（`..`、绝对路径、URL 编码、大小写变体）都归这一句拦。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { protocol } from 'electron';

import type { BookRecord } from '../../shared/types';
import { bookAssetUrl } from '../../shared/ipc';
import { READER_BRIDGE_JS } from '../../shared/reader-bridge';
import { sanitizeRelSegments } from '../../core/util/paths';
import { bookContentDir } from '../paths';
import { buildChapterDocument, CHAPTER_CSP, isMarkup, mimeFor } from './html-inject';

export const BOOK_SCHEME = 'arale';

/**
 * 必须在 `app.whenReady()` **之前**调用。
 *
 * `standard: true` 让 `arale://a/b` 有正常的 host/path 语义（否则 hostname 是空的，
 * 相对链接解析全废）；`secure: true` 让它被当成可信来源，否则 Chromium 会把它当
 * 不安全上下文，`@font-face`、`fetch` 等一堆能力直接不可用。
 */
export function registerBookSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: BOOK_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** 由 id 取书。协议层不直接依赖 store，方便测试注入。 */
export type BookLookup = (bookId: string) => BookRecord | null;

export function installBookProtocol(lookup: BookLookup): void {
  protocol.handle(BOOK_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad book URL', { status: 400 });
    }

    const bookId = url.hostname;
    const book = lookup(bookId);
    if (!book) return new Response('Unknown book', { status: 404 });

    const segments = sanitizeRelSegments(decodeURIComponent(url.pathname));
    if (segments === null || segments.length === 0) {
      return new Response('Forbidden', { status: 403 });
    }

    const contentRoot = path.resolve(bookContentDir(bookId));
    const target = path.resolve(contentRoot, ...segments);
    if (target !== contentRoot && !target.startsWith(contentRoot + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      return new Response('Not found', { status: 404 });
    }
    if (!stat.isFile()) return new Response('Not found', { status: 404 });

    const mime = mimeFor(target);

    // `Access-Control-Allow-Origin: *` 是给 `@font-face` 用的：字体是 CORS 受限资源，
    // 没有这个头，EPUB 自带的字体在 iframe 里静默不生效（只有控制台报错）。
    const baseHeaders: Record<string, string> = {
      'Content-Type': mime,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    };

    try {
      if (isMarkup(mime)) {
        const raw = fs.readFileSync(target, 'utf8');
        const document = buildChapterDocument(raw, { bridgeSource: READER_BRIDGE_JS });
        return new Response(document, {
          status: 200,
          headers: { ...baseHeaders, 'Content-Security-Policy': CHAPTER_CSP },
        });
      }
      const bytes = fs.readFileSync(target);
      return new Response(bytes, { status: 200, headers: baseHeaders });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(`Read failed: ${message}`, { status: 500 });
    }
  });
}

/**
 * 拼一个 `arale://` URL。
 *
 * 实现放在 `shared/ipc.ts`（`bookAssetUrl`），因为渲染进程也要拼同样的 URL，而预加载
 * 脚本在 `sandbox: true` 下拿不到 `node:path`。这里只做转发，保证「拼 URL 的规则」
 * 只有一份。
 */
export function bookUrl(bookId: string, rel: string): string {
  return bookAssetUrl(bookId, rel);
}
