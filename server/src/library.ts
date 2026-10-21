import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store, atomicFile, inside, sha256 } from './storage';
import { naturalCompare } from '../../src/core/util/natural-sort';
import { probeOrientedImageSize } from '../../src/core/comic/image-size';
import { parseMangaJson, serializeMangaJson } from '../../src/core/comic/mokuro';
import type { ServerBook } from '../../src/shared/server';
const exec = promisify(execFile);
const image = /\.(png|jpe?g|webp|gif|bmp)$/i;
const archive = /\.(cbz|zip|cbr|rar|7z|cb7|cbt|tar)$/i;
export async function hashFile(file: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file))
        hash.update(chunk);
    return hash.digest('hex');
}
export class Library {
    private seen = new Set<string>();
    private scanning: Promise<{
        imported: number;
        errors: string[];
    }> | null = null;
    constructor(readonly store: Store, readonly root: string, readonly extractor: string) { }
    scan() {
        this.scanning ??= this.run().finally(() => { this.scanning = null; });
        return this.scanning;
    }
    private async run() {
        this.seen.clear();
        const result = { imported: 0, errors: [] as string[] };
        const sources: string[] = [];
        const walk = async (directory: string, depth: number) => {
            if (depth > 12)
                throw new Error('Library nesting exceeds 12 levels');
            const entries = await readdir(directory, { withFileTypes: true });
            if (entries.some(entry => entry.isFile() && image.test(entry.name))) {
                sources.push(directory);
                return;
            }
            for (const entry of entries.sort((a, b) => naturalCompare(a.name, b.name))) {
                if (entry.isSymbolicLink())
                    continue;
                if (entry.isDirectory())
                    await walk(join(directory, entry.name), depth + 1);
                else if (entry.isFile() && archive.test(entry.name))
                    sources.push(join(directory, entry.name));
            }
        };
        await walk(await realpath(this.root), 0);
        for (const source of sources) {
            try {
                await this.import(source, 0, source, result.errors);
                result.imported++;
            }
            catch (error) {
                result.errors.push(`${basename(source)}: ${error instanceof Error ? error.message.replaceAll(this.store.root, '<data>').replaceAll(this.root, '<library>') : 'Import failed'}`);
            }
        }
        // Missing source files become unavailable; progress and OCR artifacts are retained.
        for (const row of this.store.db.prepare('SELECT id,path FROM books WHERE available=1').all()) {
            try {
                if (resolve(row.path.split('::')[0]) !== await realpath(this.root))
                    await inside(this.root, relative(this.root, row.path.split('::')[0]));
                if (!this.seen.has(row.id) && !result.errors.length)
                    this.store.db.prepare('UPDATE books SET available=0 WHERE id=?').run(row.id);
            }
            catch {
                this.store.db.prepare('UPDATE books SET available=0 WHERE id=?').run(row.id);
            }
        }
        return result;
    }
    private async import(source: string, depth: number, identity = source, errors: string[] = []): Promise<void> {
        if (depth > 6)
            throw new Error('Archive collection nesting exceeds 6 levels');
        if (depth === 0 && resolve(source) !== await realpath(this.root))
            await inside(this.root, relative(this.root, source));
        const sourceStat = await stat(source);
        const sourceHash = sourceStat.isFile() ? await hashFile(source) : null;
        let directory = source;
        let temporary: string | undefined;
        try {
            if (sourceStat.isFile()) {
                temporary = await mkdtemp(join(this.store.root, 'import-'));
                const { stdout } = await exec(this.extractor, ['extract', '--input', source, '--out', temporary], { maxBuffer: 32 * 1024 * 1024, timeout: 300000 });
                const report = JSON.parse(stdout);
                if (!report.ok)
                    throw new Error(report.error || 'Archive extraction failed');
                directory = temporary;
            }
            const files: string[] = [];
            const walk = async (path: string, level: number) => {
                if (level > 20)
                    throw new Error('Page nesting exceeds 20 levels');
                for (const entry of await readdir(path, { withFileTypes: true })) {
                    if (entry.isSymbolicLink())
                        continue;
                    if (entry.isDirectory())
                        await walk(join(path, entry.name), level + 1);
                    else if (entry.isFile())
                        files.push(join(path, entry.name));
                }
            };
            await walk(directory, 0);
            const images = files.filter(file => image.test(file)).sort((a, b) => naturalCompare(relative(directory, a), relative(directory, b)));
            if (!images.length) {
                const volumes = files.filter(file => archive.test(file)).sort(naturalCompare);
                if (!volumes.length)
                    throw new Error('No readable comic pages');
                for (const volume of volumes) {
                    try {
                        await this.import(volume, depth + 1, `${identity}::${relative(directory, volume).replaceAll('\\', '/')}`, errors);
                    }
                    catch (error) {
                        errors.push(`${basename(volume)}: ${error instanceof Error ? error.message.replaceAll(this.store.root, '<data>') : 'Import failed'}`);
                    }
                }
                return;
            }
            if (images.length > 10000)
                throw new Error('Comic exceeds 10000 pages');
            const contents = [];
            for (let index = 0; index < images.length; index++) {
                const file = await inside(directory, relative(directory, images[index]!));
                const size = await stat(file);
                if (size.size > 64 * 1024 * 1024)
                    throw new Error('Page exceeds 64 MiB');
                const bytes = await readFile(file);
                const dimensions = probeOrientedImageSize(bytes);
                if (!dimensions)
                    throw new Error(`Unsupported page: ${basename(file)}`);
                const hash = sha256(bytes);
                const page = { id: `p_${index}_${hash.slice(0, 16)}`, url: `pages/${String(index + 1).padStart(6, '0')}${extname(file).toLowerCase()}`, ...dimensions, sha256: hash, bytes: bytes.length };
                contents.push({ page, file, original: relative(directory, file).replaceAll('\\', '/') });
            }
            const revision = sha256(JSON.stringify(contents.map(item => [item.page.sha256, item.page.url])));
            const originalHash = sourceHash ?? revision;
            const oldRow = this.store.db.prepare('SELECT id,json FROM books WHERE path=? OR original_hash=? ORDER BY CASE WHEN path=? THEN 0 ELSE 1 END LIMIT 1').get(identity, originalHash, identity);
            const old: ServerBook | undefined = oldRow && JSON.parse(oldRow.json);
            if (old?.revision === revision) {
                this.store.saveBook(old, identity, originalHash);
                this.seen.add(old.id);
                return;
            }
            const id = old?.id ?? `bk_${randomUUID().replaceAll('-', '')}`;
            const now = Date.now();
            const book: ServerBook = { id, revision, format: 'comic', title: basename(source, extname(sourceStat.isFile() ? source : '')), titleSort: basename(source).toLowerCase(), author: '', series: null, volume: null, language: 'ja', publisher: null, description: null, tags: [],
                coverRel: contents[0]!.page.url, coverSha256: contents[0]!.page.sha256, addedAt: old?.addedAt ?? now, updatedAt: now, lastOpenedAt: null, direction: 'rtl', spine: null, toc: null, opfRel: null, pages: contents.map(item => item.page), pageCount: contents.length, ocrRevision: 0 };
            for (const item of contents) {
                // The server owns immutable page copies; replacing a source cannot alter an active revision.
                const bytes = await readFile(item.file);
                if (sha256(bytes) !== item.page.sha256)
                    throw new Error('Source page changed during import');
                await atomicFile(this.store.asset(book, item.page.url), bytes);
            }
            const ocrFile = files.find(file => basename(file) === 'manga.json') ?? files.find(file => file.endsWith('.mokuro'));
            if (ocrFile && (await stat(ocrFile)).size <= 32 * 1024 * 1024) {
                const originalPages = parseMangaJson(await readFile(ocrFile, 'utf8'));
                const byPath = new Map(originalPages.map(page => [page.url, page.blocks]));
                const layer = contents.map(item => ({ ...item.page, blocks: byPath.get(item.original) ?? [] }));
                if (layer.some(page => page.blocks.length)) {
                    book.ocrRevision = 1;
                    await atomicFile(this.store.asset(book, 'manga.json'), serializeMangaJson(layer));
                }
            }
            // Verify the source did not change during import before publishing the manifest.
            if (sourceStat.isFile() && originalHash !== await hashFile(source))
                throw new Error('Source changed during import');
            this.store.saveBook(book, identity, originalHash);
            this.seen.add(book.id);
        }
        finally {
            if (temporary)
                await rm(temporary, { recursive: true, force: true });
        }
    }
}
