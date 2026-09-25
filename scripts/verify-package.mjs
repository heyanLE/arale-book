/**
 * 验证**打包后**的应用真的能跑。
 *
 * 这一步不能省：打包最容易坏的不是源码，而是**运行时按路径找东西**的那三处——
 * Rust sidecar、Python 桥、`data/ja-transforms.json`。它们在开发态从仓库根找得到，
 * 进了 `.app` 之后分别落在 `Contents/Resources/native/`、`Contents/Resources/scripts/`
 * 和 `app.asar/data/`。开发态的测试**一个都覆盖不到**这些路径。
 *
 * 所以这里直接启动 `release/.../ARaLeBook.app`，用 CDP 连进渲染进程，把三处都戳一遍。
 *
 * 用法：`node scripts/verify-package.mjs [--app <path-to-.app>]`
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 9336;

function findApp() {
  const explicit = process.argv.indexOf('--app');
  if (explicit >= 0 && process.argv[explicit + 1]) return process.argv[explicit + 1];
  const releaseDir = join(root, 'release');
  if (!existsSync(releaseDir)) return null;
  for (const entry of readdirSync(releaseDir)) {
    const candidate = join(releaseDir, entry, 'ARaLeBook.app');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const appPath = findApp();
if (!appPath) {
  console.error('找不到打包产物。先跑 `npm run pack:dir`。');
  process.exit(2);
}

const executable = join(appPath, 'Contents', 'MacOS', 'ARaLeBook');
const userDataDir = mkdtempSync(join(os.tmpdir(), 'arale-packaged-'));
const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok });
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  — ${detail}` : ''}`);
}

console.log(`▸ 启动 ${appPath}\n`);
const child = spawn(
  executable,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    // DSH 的 seatbelt 沙箱会挡掉 Chromium 自己的沙箱；只在受限环境里需要。
    '--no-sandbox',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-dev-shm-usage',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
let exited = false;
child.on('exit', () => {
  exited = true;
});

async function waitForTarget(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) throw new Error('应用在暴露调试端口前就退出了');
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 还没起来 */
    }
    await delay(300);
  }
  throw new Error('等 CDP 端点超时');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    socket.addEventListener('error', () => reject(new Error('CDP 出错')));
    socket.addEventListener('open', () => {
      const send = (method, params = {}) =>
        new Promise((res) => {
          const id = nextId++;
          pending.set(id, res);
          socket.send(JSON.stringify({ id, method, params }));
        });
      const evaluate = async (expression) => {
        const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (reply.result?.exceptionDetails) {
          throw new Error(reply.result.exceptionDetails.exception?.description ?? 'evaluate 失败');
        }
        return reply.result?.result?.value;
      };
      resolve({ send, evaluate, close: () => socket.close() });
    });
  });
}

let client = null;
try {
  client = await connect((await waitForTarget()).webSocketDebuggerUrl);
  await client.send('Runtime.enable');

  let mounted = false;
  for (let i = 0; i < 50 && !mounted; i += 1) {
    mounted = await client.evaluate("!!document.querySelector('#root')?.children.length");
    if (!mounted) await delay(250);
  }
  check('打包后的应用能启动并渲染出界面', !!mounted);
  check('preload 挂上了 window.arale', (await client.evaluate('typeof window.arale')) === 'object');

  const title = await client.evaluate('document.title');
  check('窗口标题是 あられブック', typeof title === 'string' && title.includes('あられブック'), String(title));

  const info = await client.evaluate('window.arale.library.info()');
  check('数据目录落在 userData 下（不是只读的 app 包内）', typeof info?.dir === 'string' && !info.dir.includes('.app/'), String(info?.dir));

  // ★ 关键：Rust sidecar 从 Contents/Resources/native/ 被找到
  const cbz = join(root, 'samples', 'サンプル漫画 v01.cbz');
  const disguised = join(userDataDir, 'packaged-check.cbr');
  copyFileSync(cbz, disguised);
  const imported = await client.evaluate(`window.arale.library.importPaths(${JSON.stringify([disguised])})`);
  const first = Array.isArray(imported) ? imported[0] : null;
  check(
    'Rust sidecar 在包里被找到并解开 .cbr（Contents/Resources/native/）',
    first?.ok === true && first?.format === 'comic',
    JSON.stringify({ ok: first?.ok, format: first?.format, error: first?.error }),
  );

  // ★ 关键：Python 桥从 Contents/Resources/scripts/ 被找到
  const capability = await client.evaluate('window.arale.ocr.capability()');
  const mangaAnki = capability?.providers?.find((p) => p.id === 'manga-anki');
  check(
    'Python 桥在包里被找到（Contents/Resources/scripts/ocr-bridge.py）',
    mangaAnki?.available === true,
    mangaAnki?.available ? '可用' : (mangaAnki?.reason ?? '未探测到'),
  );

  // ★ 关键：data/ja-transforms.json 在 asar 里被找到（去屈折数据）
  const inflected = await client.evaluate(`window.arale.dict.lookup('食べました', 0)`);
  check(
    '去屈折数据（data/ja-transforms.json）随包可用',
    Array.isArray(inflected?.results),
    'lookup 没抛异常',
  );

  client.close();
} catch (error) {
  check('打包验证执行完成', false, error instanceof Error ? error.message : String(error));
} finally {
  child.kill('SIGTERM');
  await delay(800);
  if (!exited) child.kill('SIGKILL');
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(60)}\n通过 ${results.length - failures} / ${results.length}`);
process.exit(failures > 0 ? 1 : 0);
