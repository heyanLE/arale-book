import { readFile, realpath, stat, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { Store, atomicFile, sha256 } from './storage';
import type { ServerBook, ServerJob } from '../../src/shared/server';
import { parseOcrStreamLine } from '../../src/shared/ocr-protocol';
import { convertOcr } from '../../src/core/ocr/convert';
export interface Runner {
    root: string;
    program: string;
    args: string[];
    env: Record<string, string>;
    signature: string;
}
export async function loadRunner(manifest: string | undefined): Promise<Runner | null> {
    if (!manifest)
        return null;
    const file = await realpath(manifest);
    const root = dirname(file);
    const bytes = await readFile(file);
    const value = JSON.parse(bytes.toString());
    if (value.kind !== 'ocr-engine' || value.provides !== 'arale_onnx_v1' || typeof value.runner?.program !== 'string' || !Array.isArray(value.runner.args) || value.runner.args.some((arg: unknown) => typeof arg !== 'string'))
        throw new Error('Unsupported OCR runner manifest');
    const program = value.runner.program.includes('/') || value.runner.program.includes('\\') ? resolve(root, value.runner.program) : value.runner.program;
    if (isAbsolute(program))
        await stat(program);
    // Fingerprint actual model/runner bytes so restarting after an engine change cannot
    // reuse checkpoints produced by different code or weights.
    const hashes: string[] = [];
    const hashTree = async (directory: string) => { let files; try {
        files = await readdir(directory, { withFileTypes: true });
    }
    catch (e: any) {
        if (e.code === 'ENOENT')
            return;
        throw e;
    } for (const entry of files.sort((a, b) => a.name.localeCompare(b.name))) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory())
            await hashTree(path);
        else if (entry.isFile() && !entry.name.endsWith('.pyc')) {
            const { hashFile } = await import('./library');
            hashes.push(entry.name + ':' + await hashFile(path));
        }
    } };
    await hashTree(resolve(root, 'models'));
    await hashTree(resolve(root, 'ocr'));
    let runtimeLock='';
    try {runtimeLock=await readFile(resolve(root,'requirements-linux.lock'),'utf8');} catch(error:any){if(error.code!=='ENOENT')throw error;}
    const model = hashes.join(':')+runtimeLock;
    return { root, program, args: value.runner.args, env: value.runner.env ?? {}, signature: sha256(Buffer.concat([bytes, Buffer.from(model + ':postprocess-v2:' + (process.env.ARALE_OCR_THREADS ?? '4') + ':cache=' + (process.env.ARALE_OCR_KV_CACHE ?? '1'))])) };
}
export class OcrQueue {
    private child: ChildProcess | null = null;
    private pumping = false;
    private stopped = false;
    private active: ServerJob | null = null;
    private work: Promise<void> = Promise.resolve();
    constructor(readonly store: Store, readonly runner: Runner | null, private changed: () => void) {
        for (const row of store.db.prepare("SELECT json FROM jobs WHERE state='running'").all()) {
            const job: ServerJob = JSON.parse(row.json);
            job.state = 'queued';
            job.error = '服务重启，继续未完成页';
            job.updatedAt = Date.now();
            store.saveJob(job);
        }
    }
    start() { if (!this.pumping && !this.stopped)
        this.work = this.pump(); }
    enqueue(id: string, operationId: string, force: boolean): {
        job: ServerJob | null;
        skipped: boolean;
    } {
        const book = this.store.book(id);
        if (!/^[\w-]{1,100}$/.test(operationId))
            throw Object.assign(new Error('Invalid operation ID'), { statusCode: 400 });
        const receipt=this.store.db.prepare('SELECT * FROM job_receipts WHERE operation_id=?').get(operationId);
        if(receipt&&receipt.book_id!==id)throw Object.assign(new Error('Operation belongs to another book'),{statusCode:409});
        if(receipt&&!receipt.job_id)return {job:null,skipped:true};
        const prior = this.store.db.prepare('SELECT json FROM jobs WHERE operation_id=? OR id=?').get(operationId,receipt?.job_id??'');
        if (prior) {
            const job = JSON.parse(prior.json);
            if (job.bookId !== id)
                throw Object.assign(new Error('Operation belongs to another book'), { statusCode: 409 });
            return { job, skipped: false };
        }
        const active = this.store.db.prepare("SELECT json FROM jobs WHERE book_id=? AND revision=? AND state IN ('queued','running') LIMIT 1").get(id, book.revision);
        if (active){
            const job=JSON.parse(active.json);this.store.db.prepare('INSERT INTO job_receipts VALUES (?,?,?)').run(operationId,id,job.id);
            return {job,skipped:false};
        }
        if (!force && book.ocrRevision > 0){
            this.store.db.prepare('INSERT INTO job_receipts VALUES (?,?,NULL)').run(operationId,id);
            return {job:null,skipped:true};
        }
        if (!this.runner)
            throw Object.assign(new Error('服务器未配置 OCR 引擎'), { statusCode: 503 });
        if (force)
            this.store.db.prepare('DELETE FROM ocr_pages WHERE book_id=? AND revision=? AND engine=?').run(id, book.revision, this.runner.signature);
        const job: ServerJob = { id: randomUUID(), bookId: id, revision: book.revision, title: book.title, state: 'queued', done: 0, total: book.pages.length, error: null, createdAt: Date.now(), updatedAt: Date.now(), attempt: 0 };
        this.store.saveJob(job, operationId);
        this.changed();
        this.start();
        return { job, skipped: false };
    }
    cancel(id: string) {
        const row = this.store.db.prepare('SELECT json FROM jobs WHERE id=?').get(id);
        if (!row)
            throw Object.assign(new Error('Job not found'), { statusCode: 404 });
        const job: ServerJob = JSON.parse(row.json);
        if (job.state === 'queued' || job.state === 'running') {
            job.state = 'cancelled';
            job.updatedAt = Date.now();
            this.store.saveJob(job);
            if (this.active?.id === id)
                this.kill();
            this.changed();
        }
    }
    private kill() {
        if (!this.child?.pid)
            return;
        try {
            if (process.platform !== 'win32')
                process.kill(-this.child.pid, 'SIGTERM');
            else
                this.child.kill('SIGTERM');
        }
        catch { /* already exited */ }
        const child = this.child;
        const timer = setTimeout(() => { if (child.exitCode !== null || child.signalCode !== null)
            return; try {
            if (child.pid && process.platform !== 'win32')
                process.kill(-child.pid, 'SIGKILL');
            else
                child.kill('SIGKILL');
        }
        catch { } }, 2000);
        timer.unref();
    }
    async close() { this.stopped = true; this.kill(); await this.work; }
    private async pump() {
        if (this.pumping || this.stopped)
            return;
        this.pumping = true;
        try {
            while (!this.stopped) {
                const row = this.store.db.prepare("SELECT json FROM jobs WHERE state='queued' ORDER BY rowid LIMIT 1").get();
                if (!row)
                    break;
                const job: ServerJob = JSON.parse(row.json);
                job.state = 'running';
                job.attempt++;
                job.updatedAt = Date.now();
                job.error = null;
                this.store.saveJob(job);
                this.active = job;
                this.changed();
                try {
                    await this.run(job);
                }
                catch (error) {
                    const current: ServerJob = JSON.parse(this.store.db.prepare('SELECT json FROM jobs WHERE id=?').get(job.id).json);
                    if (current.state === 'running') {
                        current.state = this.stopped ? 'queued' : 'failed';
                        current.error = this.stopped ? '服务停止，待恢复' : error instanceof Error ? error.message.slice(0, 300) : 'OCR failed';
                        current.updatedAt = Date.now();
                        this.store.saveJob(current);
                    }
                }
                finally {
                    this.child = null;
                    this.active = null;
                    this.changed();
                }
            }
        }
        finally {
            this.pumping = false;
        }
    }
    private current(job: ServerJob): boolean {
        const row = this.store.db.prepare('SELECT json FROM jobs WHERE id=?').get(job.id);
        if (!row)
            return false;
        const current: ServerJob = JSON.parse(row.json);
        return current.state === 'running' && current.attempt === job.attempt && !this.stopped;
    }
    private async run(job: ServerJob) {
        const runner = this.runner!;
        const book = this.store.book(job.bookId);
        if (book.revision !== job.revision)
            throw new Error('漫画原图已变化，请重新提交 OCR');
        const checkpoints = () => this.store.db.prepare('SELECT page_id,json FROM ocr_pages WHERE book_id=? AND revision=? AND engine=?').all(book.id, book.revision, runner.signature);
        const completed = new Set(checkpoints().map((row: any) => row.page_id));
        job.done = completed.size;
        const remaining = book.pages.filter(page => !completed.has(page.id));
        if (remaining.length) {
            const pagesFile = resolve(this.store.root, 'jobs', job.id, `attempt-${job.attempt}.json`);
            await atomicFile(pagesFile, JSON.stringify({ pages: remaining.map(page => ({ rel: page.url, absPath: this.store.asset(book, page.url), width: page.width, height: page.height })) }));
            if(!this.current(job))return;
            const env = { ...process.env };
            for (const [key, value] of Object.entries(runner.env))
                env[key] = key === 'PYTHONPATH' ? resolve(runner.root, value) : value;
            const child = spawn(runner.program, runner.args.map(arg => arg.replaceAll('{pagesFile}', pagesFile)), { cwd: runner.root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
            this.child = child;
            let fatal = '';
            let tail = '';
            let bytes = 0;
            child.stderr!.on('data', chunk => { tail = (tail + chunk.toString()).slice(-1000); });
            const exited = new Promise<void>((accept, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? accept() : reject(new Error(`OCR 进程退出 ${code}: ${tail.replaceAll(runner.root, '<engine>').replaceAll(this.store.root, '<data>').slice(-250)}`))); });
            // Attach a handler immediately, including spawn errors before stdout emits any line.
            void exited.catch(() => undefined);
            const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
            for await (const line of lines) {
                bytes += Buffer.byteLength(line);
                if (bytes > 128 * 1024 * 1024 || line.length > 16 * 1024 * 1024) {
                    this.kill();
                    fatal = 'OCR 输出超过限制';
                    break;
                }
                if (!this.current(job)) {
                    this.kill();
                    continue;
                }
                const event = parseOcrStreamLine(line);
                if (event.kind === 'fatal') {
                    fatal = event.error;
                    continue;
                }
                if (event.kind !== 'page')
                    continue;
                const page = remaining.find(page => page.url === event.page.file);
                if (!page || completed.has(page.id))
                    continue;
                if (!event.page.ok) {
                    fatal = event.page.error ?? 'Page OCR failed';
                    continue;
                }
                if (event.page.width !== page.width || event.page.height !== page.height) {
                    fatal = 'OCR 图像尺寸与原图不符';
                    continue;
                }
                this.store.db.prepare('INSERT OR REPLACE INTO ocr_pages VALUES (?,?,?,?,?)').run(book.id, book.revision, page.id, runner.signature, line);
                completed.add(page.id);
                job.done = completed.size;
                job.updatedAt = Date.now();
                this.store.saveJob(job);
                this.changed();
            }
            await exited;
            if (fatal)
                throw new Error(fatal);
        }
        if (!this.current(job))
            return;
        if (completed.size !== book.pages.length)
            throw new Error(`OCR 未返回所有页：${completed.size}/${book.pages.length}`);
        const currentBook = this.store.book(book.id);
        if (currentBook.revision !== book.revision)
            throw new Error('OCR 期间漫画已变更，拒绝旧结果');
        const raw = new Map(checkpoints().map((row: any) => [row.page_id, row.json]));
        const converted = convertOcr({ book, raw: book.pages.map(page => raw.get(page.id) as string ?? null), old: await this.store.ocr(book), provider: 'arale_onnx_v1' });
        await atomicFile(this.store.asset(book, 'manga.json'), JSON.stringify(converted.layer));
        if (!this.current(job))
            return;
        if (this.store.book(book.id).revision !== book.revision)
            throw new Error('OCR 期间漫画已变更，拒绝旧结果');
        currentBook.ocrRevision++;
        const source = this.store.db.prepare('SELECT path,original_hash FROM books WHERE id=?').get(book.id);
        this.store.saveBook(currentBook, source.path, source.original_hash);
        job.blocks=converted.layer.pages.reduce((sum:number,page:any)=>sum+page.blocks.length,0);
        job.done = job.total;
        job.state = 'succeeded';
        job.updatedAt = Date.now();
        this.store.saveJob(job);
    }
}
