import { parseOcrStreamLine } from '@shared/ocr-protocol';
import { blocksFromLines } from '@core/ocr/blocks';
import { parseMangaJson, serializeMangaJson, type MokuroPage } from '@core/comic/mokuro';
import type { BookRecord, ComicPage } from '@shared/types';

type Native = (channel: string, ...args: unknown[]) => Promise<any>;
export interface PendingOcr { token: string; book: BookRecord & { pages: ComicPage[] }; raw: (string | null)[]; old: unknown; provider: string }

// Use the same geometry, ordering, merge and serialization rules as the shared rules.
export function convertOcr(input: PendingOcr) {
  const old = new Map(parseMangaJson(JSON.stringify(input.old)).map(page => [page.url, page.blocks]));
  let freshPages = 0; let freshBlocks = 0;
  const pages: MokuroPage[] = input.book.pages.map((page, index) => {
    const event = parseOcrStreamLine(input.raw[index] ?? '');
    const fresh = event.kind === 'page' && event.page.ok ? blocksFromLines(event.page.lines, input.book.direction) : [];
    if (fresh.length) { freshPages++; freshBlocks += fresh.length; }
    return { ...page, blocks: fresh.length ? fresh : old.get(page.url) ?? [] };
  });
  const layer = JSON.parse(serializeMangaJson(pages, {
    engine: input.provider, engineSignature: `${input.provider}:${input.provider === 'arale_onnx_v1' ? 'v2' : 'v1'}`, schemaVersion: 1,
  }));
  return { layer, freshPages, freshBlocks };
}

export class TauriOcr {
  private active = new Map<string, Promise<void>>();
  constructor(private native: Native) {}
  async finalize(): Promise<void> {
    const pending = await this.native('ocr:pending') as PendingOcr | null;
    if (!pending) return;
    const existing = this.active.get(pending.token); if (existing) return existing;
    const work = (async () => {
      let payload: unknown;
      try { payload = convertOcr(pending); } catch (error) { payload = { error: String(error) }; }
      await this.native('ocr:commit', pending.token, payload);
    })();
    this.active.set(pending.token, work);
    try { await work; } finally { this.active.delete(pending.token); }
  }
}
