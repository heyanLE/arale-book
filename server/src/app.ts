import Fastify from 'fastify';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { extname, relative, resolve, isAbsolute } from 'node:path';
import { acquireLock } from './lock';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Store, inside, sha256 } from './storage';
import { Library } from './library';
import { OcrQueue, loadRunner } from './ocr';
import { SERVER_API_VERSION } from '../../src/shared/server';
export interface ServerOptions {
    data: string;
    library: string;
    extractor: string;
    ocrManifest?: string;
    token?: string;
    name?: string;
    scanOnStart?: boolean;
    logger?: boolean;
}
export async function createServer(options: ServerOptions) {
    await mkdir(resolve(options.data), { recursive: true, mode: 0o700 });
    await mkdir(resolve(options.library), { recursive: true });
    const data = await realpath(options.data), libraryRoot = await realpath(options.library);
    const rel = relative(libraryRoot, data);
    const reverse = relative(data, libraryRoot);
    if (!rel || (!rel.startsWith('..') && !isAbsolute(rel)) || (!reverse.startsWith('..') && !isAbsolute(reverse)))
        throw new Error('Server data and scanned library must be separate directories');
    const unlock = await acquireLock(data, process.env.ARALE_SERVER_LOCK_WAIT === '1');
    let store: Store;
    try {
        store = new Store(data);
    }
    catch (error) {
        await unlock();
        throw error;
    }
    let token = options.token;
    try {
        if (!token) {
            try {
                token = (await readFile(resolve(data, 'access-token'), 'utf8')).trim();
            }
            catch (error: any) {
                if (error.code !== 'ENOENT')
                    throw error;
                token = randomBytes(32).toString('base64url');
                await writeFile(resolve(data, 'access-token'), token + '\n', { mode: 0o600, flag: 'wx' });
            }
        }
        if (token.length < 16)
            throw new Error('Access token must contain at least 16 characters');
    }
    catch (error) {
        store.close();
        await unlock();
        throw error;
    }
    let runner;
    try {
        runner = await loadRunner(options.ocrManifest);
    }
    catch (error) {
        store.close();
        await unlock();
        throw error;
    }
    const library = new Library(store, libraryRoot, resolve(options.extractor));
    let change = 0;
    let scanRunning = false;
    let scanCompletedAt = 0;
    let scanErrors: string[] = [];
    let scanWork: Promise<unknown> = Promise.resolve();
    const queue = new OcrQueue(store, runner, () => change++);
    const app = Fastify({ logger: options.logger ? { redact: ['req.headers.authorization'] } : false, bodyLimit: 1024 * 1024, requestTimeout: 30000 });
    const info = () => ({ apiVersion: SERVER_API_VERSION, serverId: store.serverId, userId: 'owner', name: options.name ?? 'Arale Server', capabilities: { formats: ['comic'], ocr: !!runner, engine: 'arale_onnx_v1', engineVersion: runner?.signature ?? '' } });
    const scan = () => { if (scanRunning)
        return; scanRunning = true; scanWork = library.scan().then(result => { scanErrors = result.errors; }).catch(error => { scanErrors = [error instanceof Error ? error.message : 'Scan failed']; }).finally(() => { scanRunning = false; scanCompletedAt = Date.now(); change++; }); };
    app.addHook('onRequest', async (request, reply) => {
        if (request.url === '/health')
            return;
        const value = request.headers.authorization ?? '';
        const received = Buffer.from(sha256(value));
        const expected = Buffer.from(sha256(`Bearer ${token}`));
        if (!timingSafeEqual(received, expected))
            return reply.code(401).send({ error: 'Unauthorized' });
    });
    app.setErrorHandler((error: any, _request, reply) => {
        if (error.statusCode === 409)
            return reply.code(409).send({ error: error.message, current: error.current ?? null });
        if (error.validation)
            return reply.code(400).send({ error: 'Invalid request' });
        if (error.statusCode && error.statusCode < 500)
            return reply.code(error.statusCode).send({ error: error.message });
        if (error.statusCode === 503)
            return reply.code(503).send({ error: 'OCR engine unavailable' });
        app.log.error(error);
        return reply.code(500).send({ error: 'Server operation failed' });
    });
    app.get('/health', async () => ({ ok: true }));
    app.get('/api/v1/info', async () => info());
    app.get('/api/v1/state', async () => ({ serverId: store.serverId, change, jobs: store.jobs(), scan: { running: scanRunning, completedAt: scanCompletedAt, errors: scanErrors } }));
    app.post('/api/v1/library/scan', async (_request, reply) => { scan(); return reply.code(202).send({ queued: true }); });
    app.get('/api/v1/books', async () => ({ books: store.books() }));
    const params = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' } }, additionalProperties: false };
    app.get<{
        Params: {
            id: string;
        };
    }>('/api/v1/books/:id', { schema: { params } }, async (request) => store.book(request.params.id));
    const revision = (book: any, query: any) => { if (query.revision && query.revision !== book.revision)
        throw Object.assign(new Error('Book revision changed'), { statusCode: 409 }); };
    const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };
    app.get<{
        Params: {
            id: string;
            page: string;
        };
        Querystring: {
            revision?: string;
        };
    }>('/api/v1/books/:id/pages/:page', async (request, reply) => {
        const book = store.book(request.params.id);
        revision(book, request.query);
        const page = book.pages.find(page => page.id === request.params.page);
        if (!page)
            return reply.code(404).send({ error: 'Page not found' });
        const etag = `"${page.sha256}"`;
        if (request.headers['if-none-match'] === etag)
            return reply.code(304).send();
        const path = await inside(resolve(data, 'books', book.id, book.revision), page.url);
        return reply.headers({ 'ETag': etag, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Length': page.bytes }).type(mime[extname(page.url)] ?? 'application/octet-stream').send(createReadStream(path));
    });
    app.get<{
        Params: {
            id: string;
        };
        Querystring: {
            revision?: string;
        };
    }>('/api/v1/books/:id/ocr', { schema: { params } }, async (request, reply) => {
        const book = store.book(request.params.id);
        revision(book, request.query);
        reply.header('ETag', `"${book.revision}:${book.ocrRevision}"`);
        return { revision: book.revision, ocrRevision: book.ocrRevision, layer: await store.ocr(book) };
    });
    app.get<{
        Params: {
            id: string;
        };
    }>('/api/v1/books/:id/progress', { schema: { params } }, async (request) => store.position(request.params.id));
    app.put<{
        Params: {
            id: string;
        };
        Body: any;
    }>('/api/v1/books/:id/progress', { schema: { params, body: { type: 'object', required: ['baseRevision', 'contentRevision', 'operationId', 'deviceId', 'position'], properties: { baseRevision: { type: 'integer', minimum: 0 }, contentRevision: { type: 'string', maxLength: 100 }, operationId: { type: 'string', maxLength: 100 }, deviceId: { type: 'string', maxLength: 100 }, position: { type: 'object' } } } } }, async (request) => store.savePosition(request.params.id, request.body));
    app.post<{
        Params: {
            id: string;
        };
        Body: {
            operationId: string;
            force?: boolean;
        };
    }>('/api/v1/books/:id/ocr-jobs', { schema: { params, body: { type: 'object', required: ['operationId'], properties: { operationId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' }, force: { type: 'boolean' } }, additionalProperties: false } } }, async (request, reply) => reply.code(202).send(queue.enqueue(request.params.id, request.body.operationId, request.body.force === true)));
    app.post<{
        Params: {
            id: string;
        };
    }>('/api/v1/jobs/:id/cancel', { schema: { params } }, async (request) => { queue.cancel(request.params.id); return { ok: true }; });
    app.addHook('onClose', async () => { await queue.close(); await scanWork; store.close(); await unlock(); });
    await app.ready();
    if (options.scanOnStart !== false)
        scan();
    queue.start();
    return { app, store, library, queue, scan, info, waitForScan: () => scanWork };
}
