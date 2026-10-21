import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from './app';
function argument(name: string, fallback?: string) { const index = process.argv.indexOf(`--${name}`); if (index < 0)
    return fallback; const value = process.argv[index + 1]; if (!value || value.startsWith('--'))
    throw new Error(`Missing --${name} value`); return value; }
const root = process.cwd();
const platform = `${process.platform}-${process.arch}`;
const autoManifest = resolve(root, 'engines/arale_onnx_v1/build', `dev-${platform}`, 'extension.json');
const tokenFile=process.env.ARALE_SERVER_TOKEN_FILE;
if(tokenFile && process.env.ARALE_SERVER_TOKEN)throw new Error('Configure either ARALE_SERVER_TOKEN or ARALE_SERVER_TOKEN_FILE');
const accessToken=tokenFile?(await readFile(tokenFile,'utf8')).trim():process.env.ARALE_SERVER_TOKEN;
if(tokenFile && (!accessToken || accessToken.length<16))throw new Error('Access token file must contain at least 16 characters');
const server = await createServer({ data: argument('data', process.env.ARALE_SERVER_DATA ?? resolve(root, '.arale-server'))!, library: argument('library', process.env.ARALE_SERVER_LIBRARY ?? resolve(root, 'server-library'))!,
    extractor: argument('extractor', process.env.ARALE_EXTRACTOR ?? resolve(root, 'native/arale-native/target/release', process.platform === 'win32' ? 'arale-native.exe' : 'arale-native'))!,
    ocrManifest: argument('ocr-manifest', process.env.ARALE_OCR_MANIFEST ?? (existsSync(autoManifest) ? autoManifest : undefined)), token: accessToken, name: process.env.ARALE_SERVER_NAME, logger: true });
const host = argument('host', process.env.ARALE_SERVER_HOST ?? '127.0.0.1')!;
const port = Number(argument('port', process.env.ARALE_SERVER_PORT ?? '3737'));
try {
    await server.app.listen({ host, port });
}
catch (error) {
    await server.app.close();
    throw error;
}
console.log(`Arale Server ready. Access token: ${resolve(argument('data', process.env.ARALE_SERVER_DATA ?? resolve(root, '.arale-server'))!, 'access-token')} (unless supplied through ARALE_SERVER_TOKEN or ARALE_SERVER_TOKEN_FILE)`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => { void server.app.close().then(() => process.exit(0), () => process.exit(1)); });
