import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, rename, realpath, writeFile, open } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { ServerBook, ServerJob, ServerPosition } from '../../src/shared/server';
const require = createRequire(import.meta.url);
export const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export async function atomicFile(file: string, content: string | Uint8Array) {
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
        const handle = await open(temp, 'wx', 0o600);
        try {
            await handle.writeFile(content);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await rename(temp, file);
    }
    catch (error) {
        const { rm } = await import('node:fs/promises');
        await rm(temp, { force: true });
        throw error;
    }
}
export async function inside(root: string, path: string): Promise<string> {
    const base = await realpath(root);
    const target = await realpath(resolve(base, path));
    const rel = relative(base, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel))
        throw new Error('Path escapes configured directory');
    return target;
}
export class Store {
    readonly db: any;
    readonly serverId: string;
    constructor(readonly root: string) {
        const { DatabaseSync } = require('node:sqlite');
        this.db = new DatabaseSync(resolve(root, 'arale.sqlite'));
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS books(id TEXT PRIMARY KEY,path TEXT NOT NULL,original_hash TEXT NOT NULL,json TEXT NOT NULL,available INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS books_path ON books(path); CREATE INDEX IF NOT EXISTS books_hash ON books(original_hash);
      CREATE TABLE IF NOT EXISTS progress(book_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS progress_receipts(operation_id TEXT PRIMARY KEY,book_id TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,book_id TEXT NOT NULL,revision TEXT NOT NULL,state TEXT NOT NULL,operation_id TEXT UNIQUE NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_receipts(operation_id TEXT PRIMARY KEY,book_id TEXT NOT NULL,job_id TEXT);
      CREATE TABLE IF NOT EXISTS ocr_pages(book_id TEXT NOT NULL,revision TEXT NOT NULL,page_id TEXT NOT NULL,engine TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(book_id,revision,page_id,engine));`);
        this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('schemaVersion', '1');
        if (this.db.prepare('SELECT value FROM meta WHERE key=?').get('schemaVersion').value !== '1') {
            this.db.close();
            throw new Error('Unsupported server database version');
        }
        this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('serverId', randomUUID());
        this.serverId = this.db.prepare('SELECT value FROM meta WHERE key=?').get('serverId').value;
    }
    books(): ServerBook[] { return this.db.prepare('SELECT json FROM books WHERE available=1 ORDER BY id').all().map((r: any) => JSON.parse(r.json)); }
    book(id: string): ServerBook {
        const row = this.db.prepare('SELECT json FROM books WHERE id=? AND available=1').get(id);
        if (!row)
            throw Object.assign(new Error('Book not found'), { statusCode: 404 });
        return JSON.parse(row.json);
    }
    saveBook(book: ServerBook, path: string, hash: string) {
        this.db.prepare('INSERT INTO books VALUES (?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET path=excluded.path,original_hash=excluded.original_hash,json=excluded.json,available=1').run(book.id, path, hash, JSON.stringify(book));
    }
    position(id: string): ServerPosition { return JSON.parse(this.db.prepare('SELECT json FROM progress WHERE book_id=?').get(id)?.json ?? JSON.stringify({ revision: 0, contentRevision: this.book(id).revision, position: null, deviceId: '' })); }
    savePosition(id: string, input: any): ServerPosition {
        const book = this.book(id);
        if (typeof input.operationId !== 'string' || !/^[\w-]{1,100}$/.test(input.operationId) || typeof input.deviceId !== 'string' || !/^[\w-]{1,100}$/.test(input.deviceId))
            throw Object.assign(new Error('Invalid progress operation'), { statusCode: 400 });
        const receipt = this.db.prepare('SELECT book_id,json FROM progress_receipts WHERE operation_id=?').get(input.operationId);
        if (receipt) {
            if (receipt.book_id !== id)
                throw Object.assign(new Error('Operation belongs to another book'), { statusCode: 409 });
            return JSON.parse(receipt.json);
        }
        const current = this.position(id);
        const index = input.position?.pageIndex;
        if (!Number.isSafeInteger(index) || index < 0 || index >= book.pages.length || input.position.bookId !== id)
            throw Object.assign(new Error('Invalid reading position'), { statusCode: 400 });
        if(input.contentRevision===book.revision && current.contentRevision===book.revision && current.position?.pageIndex===index){
            this.db.prepare('INSERT INTO progress_receipts VALUES (?,?,?)').run(input.operationId,id,JSON.stringify(current));
            return current;
        }
        if(input.contentRevision!==book.revision || input.baseRevision!==current.revision)
            throw Object.assign(new Error('Progress conflict'),{statusCode:409,current:{...current,bookRevision:book.revision}});
        const next = { revision: current.revision + 1, contentRevision: book.revision, deviceId: input.deviceId,
            position: { bookId: id, pageIndex: index, updatedAt: Date.now() } };
        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.db.prepare('INSERT INTO progress VALUES (?,?,?) ON CONFLICT(book_id) DO UPDATE SET revision=excluded.revision,json=excluded.json').run(id, next.revision, JSON.stringify(next));
            this.db.prepare('INSERT INTO progress_receipts VALUES (?,?,?)').run(input.operationId, id, JSON.stringify(next));
            this.db.exec('COMMIT');
            return next;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    jobs(): ServerJob[] { return this.db.prepare("SELECT json FROM jobs WHERE state IN ('queued','running') OR rowid IN (SELECT rowid FROM jobs ORDER BY rowid DESC LIMIT 100) ORDER BY rowid DESC").all().map((r: any) => JSON.parse(r.json)); }
    saveJob(job: ServerJob, operationId?: string) {
        if (operationId)
            this.db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?)').run(job.id, job.bookId, job.revision, job.state, operationId, JSON.stringify(job));
        else
            this.db.prepare('UPDATE jobs SET state=?,json=? WHERE id=?').run(job.state, JSON.stringify(job), job.id);
    }
    asset(book: ServerBook, path: string) { return resolve(this.root, 'books', book.id, book.revision, path); }
    async ocr(book: ServerBook): Promise<any> {
        try {
            return JSON.parse(await readFile(this.asset(book, 'manga.json'), 'utf8'));
        }
        catch (error: any) {
            if (error.code === 'ENOENT')
                return { pages: book.pages.map(page => ({ url: page.url, width: page.width, height: page.height, blocks: [] })) };
            throw error;
        }
    }
    close() { this.db.close(); }
}
