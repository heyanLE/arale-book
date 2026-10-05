import { parseEpub, extractText } from '@core/epub/parser';
import { findEntry, type ZipEntry } from '@core/epub/zip-memory';
import { contentSpineItems, scanChapter, judgeImageNovel } from '@core/epub/image-novel';
import { buildChapterDocument } from '../../core/epub/html-inject';
import type { ImportOutcome } from '@shared/types';

type Native = (channel: string, ...args: unknown[]) => Promise<any>;
interface Staged { id: string; entries: Array<{ name: string; rawName: string; text: string | null }>; }

async function importEpub(native: Native, path: string): Promise<string> {
  const staged = await native('epub:stage', path) as Staged;
  try {
    // Binary resources stay in Rust; OPF/navigation/chapter text is sufficient for these pure algorithms.
    const entries: ZipEntry[] = staged.entries.map(entry => ({ ...entry, isDir: false,
      text: () => entry.text ?? '', bytes: () => { throw new Error('EPUB 二进制资源由 Rust 管理'); },
    }));
    const parsed = parseEpub(entries);
    const chapters = new Map(entries.filter(entry => /\.(?:xhtml|html|htm)$/i.test(entry.name)).map(entry => [entry.name, entry.text()]));
    for (const item of parsed.spine) {
      if (!chapters.has(item.href)) {
        const existing = findEntry(entries, item.href);
        if (existing) {
          chapters.set(item.href, existing.text() || await native('epub:text', staged.id, existing.name) as string);
          continue;
        }
        const escaped = item.href.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
        chapters.set(item.href, `<p>（找不到章节文件：${escaped}）</p>`);
      }
    }
    const verdict = judgeImageNovel(contentSpineItems(parsed.spine).map(item => scanChapter(
      parsed.spine.indexOf(item), item.href, chapters.get(item.href) ?? '', extractText,
    )));
    let documentBytes = 0;
    const encoder = new TextEncoder();
    const documents = [...chapters].map(([href, raw]) => {
      // Native injects one trusted script when serving a chapter; don't duplicate it in the book cache/IPC.
      const html = buildChapterDocument(raw, { bridge: false, bridgeSource: '' });
      const plainText = extractText(raw);
      documentBytes += encoder.encode(html).length + encoder.encode(plainText).length;
      if (documentBytes > 64 * 1024 * 1024) throw new Error('EPUB 预处理文档超过 64 MiB');
      return { href, html, plainText };
    });
    await native('epub:commit', staged.id, { parsed, documents,
      imagePages: verdict.isImageNovel ? verdict.pages.map(href => findEntry(entries, href)?.name ?? href) : [],
    });
    return staged.id;
  } catch (error) {
    await native('epub:discard', staged.id).catch(() => undefined);
    throw error;
  }
}

export async function importBooks(native: Native, paths: string[]): Promise<ImportOutcome[]> {
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) throw new Error('导入路径必须为文本数组');
  const results: ImportOutcome[] = [];
  for (const path of paths) {
    if (/\.epub$/i.test(path)) {
      try { results.push({ ok: true, source: path, bookId: await importEpub(native, path), format: 'epub', error: null }); }
      catch (error) { results.push({ ok: false, source: path, bookId: null, format: null, error: String(error) }); }
    } else results.push(...await native('library:import', [path]) as ImportOutcome[]);
  }
  return results;
}
