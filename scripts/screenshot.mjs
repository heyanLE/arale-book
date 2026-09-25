/**
 * 截屏工具：把应用真实渲染出来的界面存成 PNG。
 *
 * 用途有两个：
 * 1. 人工核对视觉（是不是「像 Calibre 的桌面软件」而不是「一个网页」）；
 * 2. 改了 CSS / 布局之后，跑一次就能拿到前后对比图。
 *
 * 用法：`node scripts/screenshot.mjs [输出目录]`（默认 `screenshots/`）
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = process.argv[2] ? join(root, process.argv[2]) : join(root, 'screenshots');
const userDataDir = join(root, '.screenshot-userdata');
const PORT = 9334;

if (!existsSync(join(root, 'dist', 'main', 'index.js'))) {
  console.error('缺少 dist/main/index.js，请先跑 npm run build');
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
rmSync(userDataDir, { recursive: true, force: true });
mkdirSync(userDataDir, { recursive: true });

const child = spawn(
  join(root, 'node_modules', '.bin', 'electron'),
  [
    '.',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-dev-shm-usage',
  ],
  { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] },
);

let exited = false;
child.on('exit', () => {
  exited = true;
});

async function waitForTarget(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) throw new Error('Electron 提前退出');
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
  const target = await waitForTarget();
  client = await connect(target.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  await client.send('Page.enable');

  // 等 React 挂载。
  for (let i = 0; i < 40; i += 1) {
    const ready = await client.evaluate("!!document.querySelector('#root')?.children.length");
    if (ready) break;
    await delay(250);
  }

  const epub = join(root, 'samples', '吾輩は猫である.epub');
  const cbz = join(root, 'samples', 'サンプル漫画 v01.cbz');
  if (!existsSync(epub) || !existsSync(cbz)) {
    throw new Error('缺少示例书，先跑 `npm run samples`');
  }
  const imageNovel = join(root, 'samples', '画像小説サンプル.epub');
  const toImport = [epub, cbz];
  if (existsSync(imageNovel)) toImport.push(imageNovel);
  await client.evaluate(`window.arale.library.importPaths(${JSON.stringify(toImport)})`);
  await delay(1200);

  async function shoot(name, prepare, settleMs = 900) {
    if (prepare) {
      await client.evaluate(prepare);
      await delay(settleMs);
    }
    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const data = shot.result?.data;
    if (!data) {
      console.error(`截屏失败：${name}`);
      return;
    }
    const file = join(outDir, `${name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`wrote ${file}`);
  }

  await shoot('01-library', null);

  await shoot('02-library-list', `(() => {
    const btn = [...document.querySelectorAll('.seg-btn')].find(b => b.textContent.includes('列表') || b.textContent.includes('List'));
    if (btn) btn.click();
    return 'ok';
  })()`);

  await shoot('03-book-detail', `(() => {
    const list = document.querySelector('.book-row, .book-tile');
    if (list) list.click();
    return 'ok';
  })()`);

  await shoot('04-comic-reader', `(() => {
    const tiles = Array.from(document.querySelectorAll('.book-tile, .book-row'));
    const target = tiles.find(t => t.textContent.includes('サンプル漫画'));
    if (!target) return 'not-found';
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    return 'ok';
  })()`, 2000);

  await shoot('05-epub-reader', `(() => {
    const back = [...document.querySelectorAll('button')].find(b => b.textContent.includes('书库'));
    if (back) back.click();
    return 'ok';
  })()`, 700);

  await shoot('06-epub-reader-open', `(() => {
    const tiles = Array.from(document.querySelectorAll('.book-tile, .book-row'));
    const target = tiles.find(t => t.textContent.includes('吾輩は猫である'));
    if (!target) return 'not-found';
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    return 'ok';
  })()`, 2500);

  // 图片型小说：书库里显示为 EPUB，打开用漫画阅读器
  await shoot('08-image-novel-reader', `(() => {
    const back = [...document.querySelectorAll('button')].find(b => b.textContent.includes('书库'));
    if (back) back.click();
    return 'ok';
  })()`, 700);
  await shoot('09-image-novel-open', `(() => {
    const tiles = Array.from(document.querySelectorAll('.book-tile, .book-row'));
    const target = tiles.find(t => t.textContent.includes('画像小説'));
    if (!target) return 'not-found';
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    return 'ok';
  })()`, 2500);

  await shoot('07-settings', `(() => {
    const back = [...document.querySelectorAll('button')].find(b => b.textContent.includes('书库'));
    if (back) back.click();
    return 'ok';
  })()`, 700);
  await shoot('07-settings-open', `(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /词典|设置/.test(b.textContent) && b.textContent.length < 8);
    if (btn) btn.click();
    return btn ? 'ok' : 'not-found';
  })()`, 1200);

  client.close();
} catch (error) {
  console.error('截屏失败：', error);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  await delay(600);
  if (!exited) child.kill('SIGKILL');
  rmSync(userDataDir, { recursive: true, force: true });
}
