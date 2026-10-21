import { parseOcrStreamLine } from '../../shared/ocr-protocol';
import { blocksFromLines } from './blocks';
import { parseMangaJson, serializeMangaJson, type MokuroPage } from '../comic/mokuro';
import type { BookRecord, ComicPage } from '../../shared/types';
export interface OcrConversionInput {
    book: Pick<BookRecord, 'direction'> & {
        pages: ComicPage[];
    };
    raw: (string | null)[];
    old: unknown;
    provider: string;
}
// Use the same geometry, ordering, merge and serialization rules as the shared rules.
export function convertOcr(input: OcrConversionInput) {
    const old = new Map(parseMangaJson(JSON.stringify(input.old)).map(page => [page.url, page.blocks]));
    let freshPages = 0;
    let freshBlocks = 0;
    const pages: MokuroPage[] = input.book.pages.map((page, index) => {
        const event = parseOcrStreamLine(input.raw[index] ?? '');
        const fresh = event.kind === 'page' && event.page.ok ? blocksFromLines(event.page.lines, input.book.direction) : [];
        if (fresh.length) {
            freshPages++;
            freshBlocks += fresh.length;
        }
        return { ...page, blocks: fresh.length ? fresh : old.get(page.url) ?? [] };
    });
    const layer = JSON.parse(serializeMangaJson(pages, {
        engine: input.provider, engineSignature: `${input.provider}:${input.provider === 'arale_onnx_v1' ? 'v2' : 'v1'}`, schemaVersion: 1,
    }));
    return { layer, freshPages, freshBlocks };
}
