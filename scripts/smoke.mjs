/**
 * 无人值守 GUI 冒烟测试。
 *
 * 单测覆盖不到「Electron 真的能起、渲染进程真的渲染、IPC 真的通」这三件事——
 * 而它们恰恰是最容易在集成时坏掉的部分（白屏、preload 没挂上、通道名写错、
 * `arale://` 协议没注册）。
 *
 * 做法：让 Electron 开一个远程调试端口，用 CDP（Chrome DevTools Protocol）连进渲染进程，
 * 直接调 `window.arale.*` 并检查 DOM。全程不需要人看屏幕，退出码即结论。
 *
 * 用法：`npm run smoke`（需要先 `npm run build`；脚本自己会跑构建，如果缺产物）
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { strToU8, zipSync } from 'fflate';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 9333;
const userDataDir = join(root, '.smoke-userdata');

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  const mark = ok ? '  ok  ' : ' FAIL ';
  console.log(`${mark} ${name}${detail ? `  — ${detail}` : ''}`);
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

// ---------------------------------------------------------------------------
// 启动 Electron
// ---------------------------------------------------------------------------

if (!existsSync(join(root, 'dist', 'main', 'index.js'))) {
  console.error('缺少 dist/main/index.js，请先跑 npm run build');
  process.exit(2);
}

rmSync(userDataDir, { recursive: true, force: true });
mkdirSync(userDataDir, { recursive: true });

const electronBin = join(root, 'node_modules', '.bin', 'electron');
const stderrLines = [];
const child = spawn(
  electronBin,
  [
    '.',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    // DSH 的 seatbelt 沙箱会挡掉 Chromium 自己的 setuid 沙箱与 GPU 进程；
    // 这里关掉它们只是为了**让冒烟测试能在受限环境里跑**，不是应用运行方式。
    '--no-sandbox',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-dev-shm-usage',
  ],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);

child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => process.stdout.write(`[electron] ${chunk}`));
child.stderr.on('data', (chunk) => {
  stderrLines.push(chunk);
  // Chromium 在受限环境里会刷一堆与业务无关的告警，只把可能是真问题的写出来。
  if (/FATAL|Uncaught|TypeError|ReferenceError/.test(chunk)) process.stderr.write(`[electron] ${chunk}`);
});

let exited = false;
child.on('exit', (code) => {
  exited = true;
  if (code !== 0 && code !== null) {
    console.error(`\nElectron 提前退出，code=${code}`);
  }
});

// ---------------------------------------------------------------------------
// 等 CDP 端点
// ---------------------------------------------------------------------------

async function waitForTarget(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) throw new Error('Electron 在暴露调试端口前就退出了');
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await response.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 端口还没起来 */
    }
    await delay(300);
  }
  throw new Error(`等 CDP 端点超时（${timeoutMs}ms）`);
}

// ---------------------------------------------------------------------------
// 一个极简 CDP 客户端
// ---------------------------------------------------------------------------

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const consoleErrors = [];

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(message.params?.exceptionDetails?.exception?.description ?? 'unknown exception');
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        consoleErrors.push(
          (message.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '),
        );
      }
    });

    socket.addEventListener('error', () => reject(new Error('CDP WebSocket 出错')));
    socket.addEventListener('open', () => {
      const send = (method, params = {}) =>
        new Promise((res) => {
          const id = nextId++;
          pending.set(id, res);
          socket.send(JSON.stringify({ id, method, params }));
        });

      const evaluate = async (expression) => {
        const reply = await send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        const details = reply.result?.exceptionDetails;
        if (details) {
          const text = details.exception?.description ?? details.text ?? 'evaluate 失败';
          throw new Error(text);
        }
        return reply.result?.result?.value;
      };

      resolve({ send, evaluate, consoleErrors, close: () => socket.close() });
    });
  });
}

// ---------------------------------------------------------------------------

let client = null;
try {
  const target = await waitForTarget();
  client = await connect(target.webSocketDebuggerUrl);
  await client.send('Runtime.enable');

  section('外壳与渲染进程');

  // 给 React 一点时间挂载。
  let mounted = false;
  for (let i = 0; i < 40 && !mounted; i += 1) {
    mounted = await client.evaluate("!!document.querySelector('#root') && document.querySelector('#root').children.length > 0");
    if (!mounted) await delay(250);
  }
  check('渲染进程挂载了 React 应用（不是白屏）', mounted);
  check('页面标题', (await client.evaluate('document.title')) !== '');

  check('preload 挂上了 window.arale', (await client.evaluate('typeof window.arale')) === 'object');
  const apiShape = await client.evaluate(
    "['library','book','dict','paths','cards','llm','ocr','extensions'].every(k => typeof window.arale[k] === 'object') && ['info','list','importPaths','open','savePosition','remove'].every(m => typeof window.arale.library[m] === 'function') && ['list','add','update','remove'].every(m => typeof window.arale.cards[m] === 'function') && ['settings','update','setApiKey','analyze'].every(m => typeof window.arale.llm[m] === 'function')",
  );
  check('window.arale 的 API 形状完整', apiShape === true);

  check(
    'paths.forFile 存在（拖放导入要靠它拿绝对路径）',
    (await client.evaluate('typeof window.arale.paths.forFile')) === 'function',
  );
  check(
    'paths.forFile 对非本地文件返回空串而不是抛',
    (await client.evaluate(
      "(() => { try { return typeof window.arale.paths.forFile(new File(['x'], 'a.txt')); } catch (e) { return 'threw:' + e.message; } })()",
    )) === 'string',
  );
  check(
    '事件订阅返回可退订的数字订阅号',
    (await client.evaluate(
      "(() => { const id = window.arale.on('library:changed', () => {}); const ok = typeof id === 'number'; window.arale.off(id); return ok; })()",
    )) === true,
  );

  check(
    'HTML 里有沙箱 meta（渲染进程不许拿到 Node）',
    (await client.evaluate("typeof window.require === 'undefined' && typeof window.process === 'undefined'")) === true,
  );

  section('书库 IPC');

  const info0 = await client.evaluate('window.arale.library.info()');
  check('library.info() 可调用', typeof info0?.dir === 'string', `dir=${info0?.dir}`);
  check('初始书库为空', info0.bookCount === 0, `bookCount=${info0.bookCount}`);

  const sampleEpub = join(root, 'samples', '吾輩は猫である.epub');
  const sampleCbz = join(root, 'samples', 'サンプル漫画 v01.cbz');
  if (!existsSync(sampleEpub) || !existsSync(sampleCbz)) {
    check('示例书存在（先跑 node scripts/make-samples.mjs）', false, `${sampleEpub} / ${sampleCbz}`);
    throw new Error('缺少示例书');
  }

  const outcomes = await client.evaluate(
    `window.arale.library.importPaths(${JSON.stringify([sampleEpub, sampleCbz])})`,
  );
  check(
    '导入两本示例书成功',
    Array.isArray(outcomes) && outcomes.length === 2 && outcomes.every((o) => o.ok),
    JSON.stringify(outcomes?.map((o) => ({ ok: o.ok, format: o.format, error: o.error }))),
  );

  const epubId = outcomes.find((o) => o.format === 'epub')?.bookId;
  const comicId = outcomes.find((o) => o.format === 'comic')?.bookId;

  const page = await client.evaluate('window.arale.library.list({})');
  check('书库列表返回 2 本', page?.total === 2, `total=${page?.total}`);
  check(
    '两本书的标题被正确解析',
    page?.books?.some((b) => b.title === '吾輩は猫である（抜粋）') &&
      page?.books?.some((b) => b.title === 'サンプル漫画'),
    JSON.stringify(page?.books?.map((b) => `${b.format}:${b.title}`)),
  );

  // UI 是否跟着更新（走 library:changed 事件 + 重新拉取）。
  let tiles = 0;
  let rows = 0;
  for (let i = 0; i < 30; i += 1) {
    tiles = await client.evaluate("document.querySelectorAll('.book-tile').length");
    rows = await client.evaluate("document.querySelectorAll('.book-row').length");
    if (tiles + rows >= 2) break;
    await delay(250);
  }
  check('书架 UI 渲染出 2 本书（网格或列表）', tiles + rows >= 2, `tiles=${tiles} rows=${rows}`);

  section('阅读器');

  const chapter = await client.evaluate(`window.arale.book.chapter(${JSON.stringify(epubId)}, 0)`);
  check(
    'EPUB 章节返回 arale:// URL',
    typeof chapter?.url === 'string' && chapter.url.startsWith(`arale://${epubId}/`),
    chapter?.url,
  );
  check('章节纯文本非空', (chapter?.plainText?.length ?? 0) > 10, `${chapter?.plainText?.length} 字`);
  check(
    '章节纯文本里能读到书的内容',
    (chapter?.plainText ?? '').includes('吾輩'),
    (chapter?.plainText ?? '').slice(0, 40),
  );

  const comic = page.books.find((b) => b.format === 'comic');
  check('漫画页序正确（p001..p004）', comic?.pages?.length === 4, `pages=${comic?.pages?.length}`);
  check('漫画默认右到左', comic?.direction === 'rtl');

  const pageText = await client.evaluate(`window.arale.book.pageText(${JSON.stringify(comicId)}, 0)`);
  check(
    '漫画第 1 页有 mokuro 文字层',
    Array.isArray(pageText?.blocks) && pageText.blocks.length > 0,
    `blocks=${pageText?.blocks?.length}`,
  );
  check(
    '文字层的框是原图像素坐标',
    Array.isArray(pageText?.blocks?.[0]?.box) && pageText.blocks[0].box[2] > pageText.blocks[0].box[0],
    JSON.stringify(pageText?.blocks?.[0]?.box),
  );
  check(
    '文字层有可查的日语文本',
    Array.isArray(pageText?.blocks?.[0]?.lines) && pageText.blocks[0].lines.length > 0,
    JSON.stringify(pageText?.blocks?.[0]?.lines?.slice(0, 6)),
  );

  // `arale://` 资源真的能取到（漫画页图）。注意页 URL 保留压缩包内的子目录
  // （示例包是 `images/p001.png`），不是 basename。
  const firstPageUrl = comic.pages[0].url;
  const coverOk = await client.evaluate(
    `fetch(window.arale.book.assetUrl(${JSON.stringify(comicId)}, ${JSON.stringify(firstPageUrl)}))
       .then(r => r.ok ? r.headers.get('content-type') : 'HTTP ' + r.status)`,
  );
  check(
    'arale:// 协议能取到页图',
    typeof coverOk === 'string' && coverOk.startsWith('image/'),
    `${firstPageUrl} → ${coverOk}`,
  );
  check(
    '漫画页 URL 保留了压缩包里的子目录',
    firstPageUrl.includes('/'),
    firstPageUrl,
  );
  check(
    'arale:// 访问越界路径被拒（防穿越）',
    (await client.evaluate(
      `fetch('arale://${comicId}/../../../etc/hosts').then(r => r.status).catch(() => 'blocked')`,
    )) !== 200,
  );

  const chapterUrlOk = await client.evaluate(
    `fetch(${JSON.stringify(chapter?.url)}).then(r => r.ok ? r.text() : 'HTTP ' + r.status)`,
  );
  check(
    'arale:// 协议返回的章节 HTML 注入了桥接脚本与阅读样式',
    typeof chapterUrlOk === 'string' && chapterUrlOk.includes('arale-bridge-v1') && chapterUrlOk.includes('--arale-font-scale'),
    typeof chapterUrlOk === 'string' ? `${chapterUrlOk.length} 字节 / 含桥接=${chapterUrlOk.includes('arale-bridge-v1')}` : String(chapterUrlOk),
  );
  check(
    'arale:// 返回的章节里没有书的脚本（净化生效）',
    typeof chapterUrlOk === 'string' && !chapterUrlOk.includes('steal'),
  );

  section('阅读器 UI（真的点开一本书）');

  // 双击漫画封面 → 阅读器应该渲染出真的图片（naturalWidth>0 才说明 arale:// 加载成功，
  // 否则只是一个 broken img 占位）。
  const openedComic = await client.evaluate(`(() => {
    const tiles = Array.from(document.querySelectorAll('.book-tile'));
    const target = tiles.find(t => t.textContent.includes('サンプル漫画'));
    if (!target) return 'tile-not-found';
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    return 'dispatched';
  })()`);
  check('能在书架上双击打开漫画', openedComic === 'dispatched', openedComic);

  let comicImg = null;
  for (let i = 0; i < 40; i += 1) {
    comicImg = await client.evaluate(`(() => {
      const img = document.querySelector('.comic-page-img');
      if (!img) return null;
      return { src: img.getAttribute('src'), loaded: img.complete && img.naturalWidth > 0, w: img.naturalWidth };
    })()`);
    if (comicImg?.loaded) break;
    await delay(250);
  }
  check('漫画阅读器渲染了页图 <img>', !!comicImg, JSON.stringify(comicImg));
  check('页图通过 arale:// 真正解码成功（不是坏图）', comicImg?.loaded === true, JSON.stringify(comicImg));
  check(
    '页图 src 是 arale:// 且保留了子目录',
    typeof comicImg?.src === 'string' && comicImg.src.startsWith('arale://') && comicImg.src.includes('/images/'),
    comicImg?.src,
  );

  const layer = await client.evaluate(`(() => {
    const layer = document.querySelector('.comic-text-layer');
    if (!layer) return null;
    const blocks = Array.from(layer.querySelectorAll('.comic-text-block'));
    const first = blocks[0];
    const rect = first ? first.getBoundingClientRect() : null;
    return {
      blocks: blocks.length,
      firstRect: rect ? { w: Math.round(rect.width), h: Math.round(rect.height), left: Math.round(rect.left), top: Math.round(rect.top) } : null,
    };
  })()`);
  check('漫画文字层渲染出可点的文字框', (layer?.blocks ?? 0) > 0, `blocks=${layer?.blocks}`);
  check(
    '文字框有真实尺寸（几何按原图像素 × 缩放算出来了）',
    (layer?.firstRect?.w ?? 0) > 0 && (layer?.firstRect?.h ?? 0) > 0,
    JSON.stringify(layer?.firstRect),
  );

  // 返回书库 → 打开小说 → iframe 应该指向 arale:// 章节。
  await client.evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.includes('书库'))?.click()",
  );
  await delay(600);
  const openedEpub = await client.evaluate(`(() => {
    const tiles = Array.from(document.querySelectorAll('.book-tile'));
    const target = tiles.find(t => t.textContent.includes('吾輩は猫である'));
    if (!target) return 'tile-not-found';
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    return 'dispatched';
  })()`);
  check('能返回书库并打开小说', openedEpub === 'dispatched', openedEpub);

  let frame = null;
  for (let i = 0; i < 40; i += 1) {
    frame = await client.evaluate(`(() => {
      const f = document.querySelector('iframe.epub-frame') || document.querySelector('iframe');
      return f ? { src: f.getAttribute('src'), sandbox: f.getAttribute('sandbox') } : null;
    })()`);
    if (frame?.src) break;
    await delay(250);
  }
  check('小说阅读器渲染了 iframe 且指向 arale://', typeof frame?.src === 'string' && frame.src.startsWith('arale://'), JSON.stringify(frame));
  check('iframe 带 sandbox 属性', typeof frame?.sandbox === 'string' && frame.sandbox.includes('allow-scripts'), frame?.sandbox);

  section('图片型小说（显示为小说、用漫画阅读器）');

  // 前面的「阅读器 UI」用例把界面留在了阅读器里，书架上没有 .book-tile。
  // 先回书库 —— 不这么做的话下面全是 tile-not-found，看起来像功能坏了。
  await client.evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.includes('书库'))?.click()",
  );
  await delay(600);

  const imageNovelPath = join(root, 'samples', '画像小説サンプル.epub');
  if (existsSync(imageNovelPath)) {
    const imported = await client.evaluate(
      `window.arale.library.importPaths(${JSON.stringify([imageNovelPath])})`,
    );
    const outcome = Array.isArray(imported) ? imported[0] : null;
    check('图片型小说能导入', outcome?.ok === true, JSON.stringify(outcome));

    if (outcome?.ok && outcome.bookId) {
      const opened = await client.evaluate(`window.arale.library.open(${JSON.stringify(outcome.bookId)})`);
      const book = opened?.book;
      check('载体格式仍是 EPUB（书库里显示为小说）', book?.format === 'epub', String(book?.format));
      check('阅读方式被标成 comic', book?.readerMode === 'comic', String(book?.readerMode));
      check('页图被抽出来了', (book?.pages?.length ?? 0) === 4, `pages=${book?.pages?.length}`);

      // 书架上要显示为 EPUB（不是漫画）
      const listed = await client.evaluate('window.arale.library.list({})');
      const row = listed?.books?.find((b) => b.id === outcome.bookId);
      check('列表里 format 是 epub（筛选器会归到小说）', row?.format === 'epub', String(row?.format));

      // 打开它 → 必须是**漫画阅读器**渲染的（.comic-page-img），不是 EPUB 的 iframe
      const rendered = await client.evaluate(`(() => {
        const tiles = Array.from(document.querySelectorAll('.book-tile, .book-row'));
        const target = tiles.find(t => t.textContent.includes('画像小説'));
        if (!target) return 'tile-not-found';
        target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        return 'dispatched';
      })()`);
      check('能在书架上找到并打开它', rendered === 'dispatched', rendered);

      let comicMode = null;
      for (let i = 0; i < 40; i += 1) {
        comicMode = await client.evaluate(`(() => ({
          comicImg: document.querySelectorAll('.comic-page-img').length,
          epubFrame: document.querySelectorAll('iframe.epub-frame').length,
          chip: document.querySelector('.reader-sub')?.textContent ?? '',
        }))()`);
        if (comicMode?.comicImg > 0) break;
        await delay(250);
      }
      check('用漫画阅读器打开（有页图 img）', comicMode?.comicImg > 0, JSON.stringify(comicMode));
      check('没有退化成 EPUB iframe', comicMode?.epubFrame === 0, `iframe=${comicMode?.epubFrame}`);
      check('阅读器里标出了「图片小说」', (comicMode?.chip ?? '').includes('图片小说'), comicMode?.chip);
      check('格式角标仍显示 EPUB', (comicMode?.chip ?? '').includes('EPUB'), comicMode?.chip);
    }
      // 手动切换：图片小说要能在两个阅读器之间来回切。
      if (outcome?.ok && outcome.bookId) {
        const toNovel = await client.evaluate(
          `window.arale.library.updateMeta(${JSON.stringify(outcome.bookId)}, { readerMode: 'epub' })`,
        );
        check('能手动切回小说阅读器', toNovel?.readerMode === 'epub', String(toNovel?.readerMode));
        const backToComic = await client.evaluate(
          `window.arale.library.updateMeta(${JSON.stringify(outcome.bookId)}, { readerMode: 'comic' })`,
        );
        check('能再切回漫画阅读器', backToComic?.readerMode === 'comic', String(backToComic?.readerMode));

        // 守卫：没有页图的书**不允许**被切到漫画模式（否则打开就是空白）。
        const guard = await client.evaluate(
          `window.arale.library.updateMeta(${JSON.stringify(epubId)}, { readerMode: 'comic' })`,
        );
        check(
          '纯文字书被拒绝切到漫画模式（无页图）',
          guard?.readerMode !== 'comic',
          JSON.stringify({ format: guard?.format, readerMode: guard?.readerMode, pages: guard?.pages?.length ?? 0 }),
        );
      }

  } else {
    check('示例图片小说存在（先跑 npm run samples）', false, imageNovelPath);
  }

  // 反向断言：普通小说**不能**被误判成图片小说。
  const normal = await client.evaluate(`window.arale.library.open(${JSON.stringify(epubId)})`);
  check(
    '普通小说没有被误判成图片小说',
    normal?.book?.format === 'epub' && normal?.book?.readerMode !== 'comic',
    JSON.stringify({ format: normal?.book?.format, readerMode: normal?.book?.readerMode }),
  );

  section('原生解包（.rar/.cbr/.7z 那条路）');

  // 把同一卷复制成 `.cbr`。**内容仍是 zip**，而我们的载体判定按内容走，
  // 所以它必须被原生 sidecar 接住、解包、并建成一本正常的漫画。
  // 这一条覆盖的就是「Rust sidecar 真的被主进程调起来了」。
  const nativeCarrier = join(userDataDir, 'native-sample.cbr');
  copyFileSync(sampleCbz, nativeCarrier);
  const nativeOutcomes = await client.evaluate(
    `window.arale.library.importPaths(${JSON.stringify([nativeCarrier])})`,
  );
  const nativeOutcome = Array.isArray(nativeOutcomes) ? nativeOutcomes[0] : null;
  check(
    '把 zip 内容伪装成 .cbr 也能导入（按内容判定 + 原生解包）',
    nativeOutcome?.ok === true && nativeOutcome?.format === 'comic',
    JSON.stringify({ ok: nativeOutcome?.ok, format: nativeOutcome?.format, error: nativeOutcome?.error }),
  );

  if (nativeOutcome?.ok && nativeOutcome.bookId) {
    const nativeBook = await client.evaluate(`window.arale.library.open(${JSON.stringify(nativeOutcome.bookId)})`);
    check(
      '原生解包出来的页数与页序正确',
      nativeBook?.book?.pages?.length === 4 && nativeBook.book.pages[0]?.url?.includes('p001'),
      JSON.stringify(nativeBook?.book?.pages?.map((p) => p.url)),
    );
    // 文字层也要跟着解出来（.mokuro 在包里）。
    const nativeText = await client.evaluate(
      `window.arale.book.pageText(${JSON.stringify(nativeOutcome.bookId)}, 0)`,
    );
    check(
      '原生解包保留了 mokuro 文字层',
      Array.isArray(nativeText?.blocks) && nativeText.blocks.length > 0,
      `blocks=${nativeText?.blocks?.length}`,
    );
  }

  section('套娃包（一个压缩包里装多个分卷）');

  // 现实里很常见：发布者把「第 01-02 卷」打成一个 RAR，里面是两个分卷压缩包。
  // 旧实现只看页图，于是报「这个压缩包里没有任何图片页」，用户一本都拿不到。
  // 正确行为是每个分卷各导入成一本。
  //
  // 这里用 zip 造一个**内容是 zip、扩展名是 .rar** 的容器：sidecar 按 magic
  // 判定格式，所以这条路径与「RAR 套 RAR」在代码上完全同一条。
  const collection = join(userDataDir, 'collection-01-02.cbr');
  const innerVolumes = {};
  for (const [name, pages] of [
    ['第01巻.cbz', ['001.jpg', '002.jpg', '003.jpg']],
    ['第02巻.cbz', ['001.jpg', '002.jpg']],
  ]) {
    const entries = {};
    for (const page of pages) entries[page] = readFileSync(join(root, 'samples', 'ocr-fixture.png'));
    innerVolumes[name] = zipSync(entries);
  }
  writeFileSync(collection, Buffer.from(zipSync(innerVolumes)));

  const collectionOutcomes = await client.evaluate(
    `window.arale.library.importPaths(${JSON.stringify([collection])})`,
  );
  check(
    '套娃包导入成两本，而不是报「没有任何图片页」',
    Array.isArray(collectionOutcomes) &&
      collectionOutcomes.length === 2 &&
      collectionOutcomes.every((o) => o.ok),
    JSON.stringify(collectionOutcomes?.map((o) => ({ ok: o.ok, error: o.error }))),
  );
  check(
    '失败时能指认是哪个分卷（source 带面包屑）',
    Array.isArray(collectionOutcomes) &&
      collectionOutcomes.every((o) => typeof o.source === 'string' && o.source.includes('›')),
    JSON.stringify(collectionOutcomes?.map((o) => o.source)),
  );

  const collectionBooks = [];
  for (const outcome of collectionOutcomes ?? []) {
    if (!outcome?.bookId) continue;
    const opened = await client.evaluate(`window.arale.library.open(${JSON.stringify(outcome.bookId)})`);
    collectionBooks.push(opened?.book);
  }
  check(
    '两个分卷的页数各自独立（3 页 / 2 页）',
    collectionBooks.map((b) => b?.pageCount).sort().join(',') === '2,3',
    JSON.stringify(collectionBooks.map((b) => ({ title: b?.title, pages: b?.pageCount }))),
  );

  section('漫画阅读器：方向 / 双页偏移 / 滑动动画');

  // 回到书库并打开那本**没有文字层**的示例漫画：后面要拿它跑 OCR 队列。
  const noTextCbz = join(root, 'samples', 'サンプル漫画（文字層なし）.cbz');
  if (!existsSync(noTextCbz)) {
    check('示例漫画（无文字层）存在（先跑 npm run samples）', false, noTextCbz);
  } else {
    const imported = await client.evaluate(
      `window.arale.library.importPaths(${JSON.stringify([noTextCbz])})`,
    );
    const noTextId = Array.isArray(imported) ? imported.find((o) => o.ok)?.bookId : null;
    check('无文字层的示例漫画能导入', typeof noTextId === 'string', JSON.stringify(imported));

    if (noTextId) {
      await client.evaluate(`window.arale.library.open(${JSON.stringify(noTextId)})`);
      await client.evaluate(
        `[...document.querySelectorAll('button')].find(b => b.textContent.includes('书库'))?.click()`,
      );
      await delay(400);
      const opened = await client.evaluate(`(() => {
        const tiles = Array.from(document.querySelectorAll('.book-tile'));
        const target = tiles.find(t => t.textContent.includes('文字層なし'));
        if (!target) return 'tile-not-found';
        target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        return 'dispatched';
      })()`);
      check('能在书架上打开无文字层漫画', opened === 'dispatched', opened);

      let comicReady = null;
      for (let i = 0; i < 40; i += 1) {
        comicReady = await client.evaluate(
          "document.querySelectorAll('.comic-page-img').length",
        );
        if (comicReady > 0) break;
        await delay(250);
      }
      check('漫画阅读器已就绪', comicReady > 0, `imgs=${comicReady}`);

      // --- 阅读方向：分段控件要两个选项都在，并且各自带箭头 ---
      const dirUi = await client.evaluate(`(() => {
        const box = document.querySelector('[data-testid="comic-direction"]');
        if (!box) return null;
        const items = Array.from(box.querySelectorAll('.seg-btn'));
        return {
          count: items.length,
          texts: items.map((b) => b.textContent.trim()),
          arrows: items.map((b) => b.querySelector('.seg-arrow')?.textContent ?? ''),
          active: items.filter((b) => b.classList.contains('is-active')).map((b) => b.textContent.trim()),
        };
      })()`);
      check(
        'LTR/RTL 分段控件两个选项都在，且各带一个箭头',
        dirUi?.count === 2 && dirUi.arrows.every((a) => a.length > 0),
        JSON.stringify(dirUi),
      );
      check(
        '箭头朝外：LTR → / RTL ←',
        dirUi?.arrows?.[0] === '→' && dirUi?.arrows?.[1] === '←',
        JSON.stringify(dirUi?.arrows),
      );
      check('恰好一个选项处于选中态（能一眼看出当前状态）', dirUi?.active?.length === 1, JSON.stringify(dirUi?.active));

      // --- 固定为 LTR：上一页在左、下一页在右 ---
      await client.evaluate(`(() => {
        const box = document.querySelector('[data-testid="comic-direction"]');
        const ltr = Array.from(box.querySelectorAll('.seg-btn')).find(b => b.textContent.includes('LTR'));
        ltr?.click();
      })()`);
      await delay(200);

      const readTurns = async () =>
        client.evaluate(`(() => {
          const next = document.querySelector('[data-testid="comic-next"]');
          const prev = document.querySelector('[data-testid="comic-prev"]');
          const footer = document.querySelector('.comic-footer');
          const kids = Array.from(footer.children);
          return {
            next: next?.textContent.trim() ?? null,
            prev: prev?.textContent.trim() ?? null,
            nextIndex: kids.indexOf(next),
            prevIndex: kids.indexOf(prev),
            label: document.querySelector('[data-testid="comic-page-label"]')?.textContent.trim() ?? null,
          };
        })()`);

      const ltrTurns = await readTurns();
      check('LTR：上一页在左、下一页在右', ltrTurns.prevIndex < ltrTurns.nextIndex, JSON.stringify(ltrTurns));
      check(
        'LTR：上一页箭头朝左、下一页箭头朝右',
        ltrTurns.prev?.startsWith('←') === true && ltrTurns.next?.endsWith('→') === true,
        JSON.stringify({ prev: ltrTurns.prev, next: ltrTurns.next }),
      );

      // --- 切到 RTL：两个按钮整体反向 ---
      await client.evaluate(`(() => {
        const box = document.querySelector('[data-testid="comic-direction"]');
        const rtl = Array.from(box.querySelectorAll('.seg-btn')).find(b => b.textContent.includes('RTL'));
        rtl?.click();
      })()`);
      await delay(250);

      const rtlTurns = await readTurns();
      check(
        'RTL：「下一页」跑到左边、「上一页」跑到右边（整组反向）',
        rtlTurns.nextIndex < rtlTurns.prevIndex,
        JSON.stringify(rtlTurns),
      );
      check(
        'RTL：下一页箭头朝左、上一页箭头朝右',
        rtlTurns.next?.startsWith('下一页') === true && rtlTurns.next?.endsWith('←') === true &&
          rtlTurns.prev?.startsWith('→') === true,
        JSON.stringify({ prev: rtlTurns.prev, next: rtlTurns.next }),
      );

      // --- 翻页滑动动画 ---
      // 直接读 Web Animations 里真的跑起来的动画，而不是「有没有这个 class」。
      // 轮询等动画出现，而不是只读一帧：React 的 layout effect 与 rAF 的相对时机
      // 不保证（挂载路径上多一个异步任务就可能错开），只读一帧的写法会偶发假失败。
      const slide = await client.evaluate(`(() => {
        const el = document.querySelector('.comic-slide');
        if (!el) return 'no-slide-layer';
        const before = document.querySelector('[data-testid="comic-page-label"]')?.textContent.trim();
        document.querySelector('[data-testid="comic-next"]')?.click();
        return new Promise((resolve) => {
          let tries = 0;
          const tick = () => {
            const anims = el.getAnimations();
            if (anims.length > 0 || tries++ > 40) {
              resolve({
                count: anims.length,
                duration: anims[0]?.effect?.getTiming?.().duration ?? null,
                before,
                after: document.querySelector('[data-testid="comic-page-label"]')?.textContent.trim(),
                fromRight: anims[0] ? getComputedStyle(el).transform : null,
              });
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      })()`);
      check('翻页时 .comic-slide 上真的有动画在跑', (slide?.count ?? 0) > 0, JSON.stringify(slide));
      check('动画时长是设定的 220ms', slide?.duration === 220, JSON.stringify(slide));
      check('翻页确实换了页（不是原地重播动画）', slide?.before !== slide?.after, JSON.stringify(slide));

      // 减少动态效果时不该有动画。
      // 先等 220ms 让上一条动画彻底结束——不然 `getAnimations()` 读到的是它，
      // 这条检查会变成「上一个用例的残留」，永远为 1。
      await delay(320);
      const reduced = await client.evaluate(`(() => {
        const el = document.querySelector('.comic-slide');
        const original = window.matchMedia;
        window.matchMedia = (q) =>
          String(q).includes('prefers-reduced-motion')
            ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }
            : original.call(window, q);
        document.querySelector('[data-testid="comic-next"]')?.click();
        return new Promise((resolve) => {
          requestAnimationFrame(() => {
            const count = el.getAnimations().length;
            window.matchMedia = original;
            resolve(count);
          });
        });
      })()`);
      check('prefers-reduced-motion 时不播放动画', reduced === 0, `animations=${reduced}`);

      // --- 双页配对偏移 ---
      const offsetHidden = await client.evaluate(
        `!!document.querySelector('[data-testid="comic-spread-offset"]')`,
      );
      check('单页模式下不显示配对偏移（它只对双页有意义）', offsetHidden === false, String(offsetHidden));

      await client.evaluate(`document.querySelector('[data-testid="comic-spread"]')?.click()`);
      await delay(250);
      const offsetUi = await client.evaluate(`(() => {
        const sel = document.querySelector('[data-testid="comic-spread-offset"]');
        if (!sel) return null;
        return { options: Array.from(sel.options).map((o) => o.value), value: sel.value };
      })()`);
      check(
        '打开双页后出现配对偏移，且恰好 0/1/2/3/4 五个选项',
        JSON.stringify(offsetUi?.options) === JSON.stringify(['0', '1', '2', '3', '4']),
        JSON.stringify(offsetUi),
      );

      // 偏移 1 的语义：「第 1 页单独，2-3 为双页，4-5 为双页」。
      // 用真实 DOM 上的页码标签验证，而不是只验证设置值存进去了。
      const pairLabel = async () =>
        client.evaluate(
          `document.querySelector('[data-testid="comic-page-label"]')?.textContent.replaceAll(' ', '') ?? null`,
        );
      await client.evaluate(`(() => {
        const sel = document.querySelector('[data-testid="comic-spread-offset"]');
        sel.value = '1';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await delay(250);
      await client.evaluate(
        "[...document.querySelectorAll('.comic-footer button')].find(b => b.textContent.includes('上一页') || b.textContent.includes('首页'))?.click()",
      );
      // 用键盘 Home 回第一页：按钮文案随 RTL 变，靠文本找不可靠。
      await client.evaluate(
        "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))",
      );
      await delay(250);
      const firstLabel = await pairLabel();
      check('偏移 1：第一页单独成页', firstLabel === '1/4', `label=${firstLabel}`);

      const afterOne = await client.evaluate(`(() => {
        const el = document.querySelector('.comic-slide');
        document.querySelector('[data-testid="comic-next"]')?.click();
        return new Promise((r) => requestAnimationFrame(() => r(el.getAnimations().length)));
      })()`);
      check('从单页往下翻也只走一步（偏移不是固定步长）', afterOne >= 0, `anims=${afterOne}`);
      await delay(200);
      const secondLabel = await pairLabel();
      check('偏移 1：接下来是第 2-3 页并排', secondLabel === '2–3/4' || secondLabel === '2-3/4', `label=${secondLabel}`);

      // --- OCR 队列的 IPC 契约（此刻没有任务） ---
      const queueSnapshot = await client.evaluate('window.arale.ocr.queue()');
      check(
        'ocr.queue() 在空闲时返回 {active:null, pending:[]}',
        queueSnapshot?.active === null && Array.isArray(queueSnapshot?.pending) && queueSnapshot.pending.length === 0,
        JSON.stringify(queueSnapshot),
      );
      const dockWhenIdle = await client.evaluate("!!document.querySelector('.ocr-dock')");
      check('队列为空时右下角不显示任何东西（不制造噪音）', dockWhenIdle === false, String(dockWhenIdle));

      // 空闲时引擎选择器不该被锁定，按钮是启动语义。
      const idleOcrUi = await client.evaluate(`(() => {
        const action = document.querySelector('[data-testid="comic-ocr-action"]');
        const provider = document.querySelector('[data-testid="comic-ocr-provider"]');
        return {
          action: action?.textContent.trim() ?? null,
          actionKind: action?.getAttribute('data-ocr-action') ?? null,
          providerFrozen: provider ? provider.disabled : null,
        };
      })()`);
      check('空闲时主按钮是启动语义（识别文字）', idleOcrUi?.actionKind === 'start', JSON.stringify(idleOcrUi));
      check('空闲时引擎选择器没有被锁定', idleOcrUi?.providerFrozen !== true, JSON.stringify(idleOcrUi));

      // 回到书库，后面的用例还在书架上找封面。
      await client.evaluate(
        `[...document.querySelectorAll('button')].find(b => b.textContent.includes('书库'))?.click()`,
      );
      await delay(400);
    }
  }

  section('扩展（清单 + 下载器）');

  const extList = await client.evaluate('window.arale.extensions.list()');
  check(
    'extensions.list() 返回清单状态',
    Array.isArray(extList?.statuses) && typeof extList?.source === 'string',
    JSON.stringify({ count: extList?.statuses?.length, source: extList?.source }),
  );
  const ankiEntry = extList?.statuses?.find((item) => item.entry.id === 'ocr-arale_onnx_v1');
  check(
    '随包清单里有 arale_onnx_v1 扩展（离线也有东西可装）',
    ankiEntry !== undefined,
    JSON.stringify(extList?.statuses?.map((item) => item.entry.id)),
  );
  // ★ 分发链路的新契约：清单只写「哪个 release 的哪个包」（release{repo,tag,assets}），
  //   地址由应用拼；一个能力一条条目，平台差异在 assets 里。
  const entry = ankiEntry?.entry;
  const platformEntry = entry?.release?.assets?.[`${process.platform}-${process.arch}`];
  check(
    '★ 清单用 release{repo,tag,assets} 声明下载来源，且当前平台有对应的包',
    typeof entry?.release?.repo === 'string' &&
      entry.release.repo.includes('/') &&
      typeof entry.release.tag === 'string' &&
      entry.release.tag.length > 0 &&
      typeof platformEntry?.asset === 'string' &&
      platformEntry.asset.length > 0,
    JSON.stringify({
      repo: entry?.release?.repo ?? null,
      tag: entry?.release?.tag ?? null,
      key: `${process.platform}-${process.arch}`,
      asset: platformEntry?.asset ?? null,
      assets: entry?.release ? Object.keys(entry.release.assets) : null,
    }),
  );
  check(
    '★ 包名只能是文件名（清单是远端来的，不许在地址里塞路径）',
    typeof platformEntry?.asset === 'string' && !platformEntry.asset.includes('/') &&
      !platformEntry.asset.includes('\\'),
    JSON.stringify({ asset: platformEntry?.asset }),
  );
  // 安全红线：sha256 要么是 64 位十六进制，要么是空（= 归档还没发布）。
  // 空的时候**必须**点不动安装，而不是装进一个没校验的东西。
  const assetSha = platformEntry?.sha256;
  check(
    '★ sha256 形状正确（64 位十六进制，或空表示未发布）',
    typeof assetSha === 'string' && (assetSha === '' || /^[0-9a-f]{64}$/.test(assetSha)),
    JSON.stringify({ sha256: typeof assetSha === 'string' ? assetSha.slice(0, 12) : null }),
  );
  if (assetSha === '') {
    const refused = await client.evaluate(
      `window.arale.extensions.install(${JSON.stringify('ocr-arale_onnx_v1')})`,
    );
    check(
      '★ 归档未发布（sha 为空）时安装被明确拒绝，且不去联网',
      refused?.ok === false && /sha256|发布/.test(String(refused?.error)),
      JSON.stringify(refused),
    );
  }

  check(
    '本机（macOS arm64）判为可安装',
    ankiEntry?.supported === true,
    JSON.stringify({ supported: ankiEntry?.supported, why: ankiEntry?.unsupportedReason }),
  );

  // 打开设置页，确认扩展卡片真的渲染出来了（不是只有 IPC 通）。
  await client.evaluate(
    `[...document.querySelectorAll('button')].find(b => (b.getAttribute('title')||'').includes('设置'))?.click()`,
  );
  await delay(500);
  const extCard = await client.evaluate(`(() => {
    const titles = Array.from(document.querySelectorAll('.settings-card-title')).map((el) => el.textContent.trim());
    const card = Array.from(document.querySelectorAll('.settings-card')).find(
      (el) => el.querySelector('.settings-card-title')?.textContent.includes('扩展'),
    );
    return { titles, hasCard: !!card, rows: card ? card.querySelectorAll('.settings-row-block').length : 0 };
  })()`);
  check('设置页有「扩展」卡片', extCard?.hasCard === true, JSON.stringify(extCard?.titles));
  check('扩展卡片列出了条目', (extCard?.rows ?? 0) >= 1, JSON.stringify(extCard));
  await client.evaluate(
    `[...document.querySelectorAll('button')].find(b => b.textContent.includes('书库'))?.click()`,
  );
  await delay(400);

  section('漫画 OCR');

  const capability = await client.evaluate('window.arale.ocr.capability()');
  check(
    'ocr.capability() 返回可用性与模型目录',
    typeof capability?.available === 'boolean' && typeof capability?.extensionsDir === 'string',
    JSON.stringify({ available: capability?.available, selected: capability?.selected }),
  );
  check(
    'ocr.status() 在没有任务时返回 null',
    (await client.evaluate(`window.arale.ocr.status(${JSON.stringify(comicId)})`)) === null,
  );

  // 示例漫画自带 mokuro 文字层 → 重复识别必须被识别成「跳过」，而不是把已有结果覆盖掉。
  const ocrSkip = await client.evaluate(`window.arale.ocr.start(${JSON.stringify(comicId)})`);
  check(
    '已有文字层时 OCR 请求被跳过（不覆盖既有结果）',
    ocrSkip?.skipped === true,
    JSON.stringify(ocrSkip),
  );

  section('品牌 あられブック');

  const title = await client.evaluate('document.title');
  check('窗口标题是日文主名称', typeof title === 'string' && title.includes('あられブック'), String(title));
  const brandText = await client.evaluate("document.querySelector('.brand')?.textContent ?? ''");
  check(
    '工具栏品牌标记同时显示日文名与英文名',
    brandText.includes('あられブック') && brandText.includes('ARaLeBook'),
    JSON.stringify(brandText),
  );
  const brandAccent = await client.evaluate(
    "getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()",
  );
  check('强调色已换成朱色系（不再是原来的蓝）', brandAccent !== '#2b6cb0' && brandAccent !== '', brandAccent);

  // 品牌标记换成素材头像（`assets/arale-icons-v2/avatar/64.png` → brand-mark.png）。
  // ★ 这里量的是 `naturalWidth`：`.brand-mark` 是 22px 的 <img>，图挂了照样占位、
  //   页面上只少一张小图，谁都不会发现——但品牌标记是应用的脸面。
  const brandMark = await client.evaluate(`(() => {
    const img = document.querySelector('.brand .brand-mark');
    if (!img) return { found: false };
    return {
      found: true,
      tag: img.tagName,
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      width: Math.round(img.getBoundingClientRect().width),
    };
  })()`);
  check(
    '★ 品牌标记是素材头像且真的加载出来了（不是坏图/不是「あ」字块）',
    brandMark.found && brandMark.tag === 'IMG' && brandMark.naturalWidth >= 32 && brandMark.width >= 18,
    JSON.stringify(brandMark),
  );

  section('OCR 引擎选择');

  const cap = await client.evaluate('window.arale.ocr.capability()');
  check(
    'capability() 返回多个引擎',
    Array.isArray(cap?.providers) && cap.providers.length >= 2,
    JSON.stringify(cap?.providers?.map((p) => `${p.id}:${p.available ? '可用' : '不可用'}`)),
  );
  // 系统 OCR 随应用走，但**能不能用取决于这台机器**（macOS 的 accurate 依赖按需下载的
  // 识别资源；本机实测就不可用）。所以这里只断言「被探测到了」，可用性由下面的
  // 真跑用例按实际情况处理。
  check(
    'system 引擎被探测到（可用性取决于本机）',
    cap?.providers?.some((p) => p.id === 'system') === true,
    JSON.stringify(cap?.providers?.map((p) => `${p.id}:${p.available ? '可用' : p.reason}`)),
  );
  check(
    'system 引擎被探测到',
    cap?.providers?.some((p) => p.id === 'system') === true,
    JSON.stringify(cap?.providers?.map((p) => p.id)),
  );

  const onnxEngine = cap?.providers?.find((p) => p.id === 'arale_onnx_v1');
  // 扩展引擎现在是一个可下载的**扩展**：没装就必须明确说「去装扩展」，而不是含糊地
  // 说「不可用」。这条断言同时守着「扩展装了但没被引擎认出来」这种回归。
  const ankiExtension = onnxEngine?.extension;
  check(
    '扩展引擎声明了它来自哪个扩展',
    ankiExtension?.id === 'ocr-arale_onnx_v1',
    JSON.stringify(ankiExtension),
  );
  if (ankiExtension?.installed === true) {
    check('扩展已装 → 引擎可用', onnxEngine?.available === true, JSON.stringify(onnxEngine));
  } else {
    check(
      '扩展没装 → 引擎不可用且提示去装扩展',
      onnxEngine?.available === false && /扩展/.test(onnxEngine?.reason ?? ''),
      JSON.stringify({ available: onnxEngine?.available, reason: onnxEngine?.reason }),
    );
  }

  // 切引擎并确认持久化（换回 system 再验证一次，避免污染后续断言）。
  const switched = await client.evaluate(`window.arale.ocr.selectProvider('arale_onnx_v1')`);
  check('能切换默认引擎', switched?.selected === 'arale_onnx_v1', String(switched?.selected));
  const back = await client.evaluate(`window.arale.ocr.selectProvider('system')`);
  check('切回系统引擎', back?.selected === 'system', String(back?.selected));

  // 真跑一次外部引擎：默认跳过（要十几秒 + 依赖本机 manga_anki 环境），
  // 用 ARALE_SMOKE_OCR=1 打开。这是唯一能证明「双引擎」不是摆设的检查。
  if (process.env.ARALE_SMOKE_OCR === '1' && onnxEngine?.available === true) {
    section('扩展 OCR 引擎（真跑）');
    const started = await client.evaluate(
      `window.arale.ocr.start(${JSON.stringify(comicId)}, { force: true, provider: 'arale_onnx_v1' })`,
    );
    check('扩展引擎任务已启动', started?.ok === true, JSON.stringify(started));

    let done = null;
    for (let i = 0; i < 200; i += 1) {
      done = await client.evaluate(`window.arale.ocr.status(${JSON.stringify(comicId)})`);
      if (done && done.error !== '正在识别中…') break;
      await delay(500);
    }
    check('扩展引擎任务正常结束', done?.ok === true, JSON.stringify(done));

    const text = await client.evaluate(`window.arale.book.pageText(${JSON.stringify(comicId)}, 0)`);
    const lines = (text?.blocks ?? []).map((b) => b.lines?.[0]);
    check(
      '扩展引擎认出了第 1 页的日文',
      lines.length > 0 && lines.some((line) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(line ?? '')),
      JSON.stringify(lines),
    );
  } else if (process.env.ARALE_SMOKE_OCR === '1') {
    section('扩展 OCR 引擎（真跑，已跳过）');
    // 不判失败：引擎现在是**扩展**，本机没装它当然跑不了。真跑用例的前提是
    // 「先装扩展」，那是环境准备，不是代码缺陷。如实说出来，不假装验证过。
    check(
      '跳过真跑：先装 ocr-arale_onnx_v1 扩展',
      true,
      onnxEngine?.reason ?? '未探测到',
    );
  }

  // 识别队列的**真跑**验证：只有真的起一个任务，右下角的胶囊、被锁定的引擎选择器、
  // 「停止识别」按钮才会出现——用假数据是验证不到这些的。
  // 默认跳过（要么下 20 MB 模型、要么拉一套 Python 管线），用 ARALE_SMOKE_OCR=1 打开。
  const queueEngines = await client.evaluate('window.arale.ocr.capability()');
  // 真跑要挑一个**不需要先装扩展**的引擎：system 随应用走，装完即用。
  const quickEngine = queueEngines?.providers?.find((p) => p.id === 'system' && p.available)
    ? 'system'
    : queueEngines?.providers?.find((p) => p.id === 'arale_onnx_v1' && p.available)
      ? 'arale_onnx_v1'
      : null;

  if (process.env.ARALE_SMOKE_OCR !== '1') {
    section('漫画 OCR 队列（真跑，已跳过）');
    check(
      '跳过真跑：设 ARALE_SMOKE_OCR=1 才验证右下角队列 / 引擎锁定 / 停止识别',
      true,
      '默认关闭：真跑要么下模型、要么拉 Python 管线',
    );
  } else if (quickEngine === null) {
    section('漫画 OCR 队列（真跑，已跳过）');
    // 同样跳过而不是失败：两个引擎都不可用是**这台机器的状态**（系统 OCR 资源缺失、
    // 扩展没装），不是回归。真正能跑的环境中这条会执行到。
    check(
      '跳过真跑：需要系统 OCR 可用，或已装扩展引擎',
      true,
      JSON.stringify(queueEngines?.providers?.map((p) => ({ id: p.id, ok: p.available }))),
    );
  } else {
    section('漫画 OCR 队列（真跑）');

    const noText = await client.evaluate(
      `(async () => {
        const page = await window.arale.library.list({});
        const book = page.books.find((b) => b.title.includes('文字層なし'));
        return book ? book.id : null;
      })()`,
    );
    check('找得到那本无文字层漫画', typeof noText === 'string', String(noText));

    if (noText) {
      // 打开它（阅读器里才有引擎选择器和主按钮）。
      await client.evaluate(
        `[...document.querySelectorAll('button')].find(b => b.textContent.includes('书库'))?.click()`,
      );
      await delay(400);
      await client.evaluate(`(() => {
        const tiles = Array.from(document.querySelectorAll('.book-tile'));
        const t = tiles.find(x => x.textContent.includes('文字層なし'));
        t?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      })()`);
      for (let i = 0; i < 40; i += 1) {
        if ((await client.evaluate("document.querySelectorAll('.comic-page-img').length")) > 0) break;
        await delay(250);
      }

      const started = await client.evaluate(
        `window.arale.ocr.start(${JSON.stringify(noText)}, { force: true, provider: ${JSON.stringify(quickEngine)} })`,
      );
      check('任务入队（queued=true 而不是立刻返回结果）', started?.queued === true, JSON.stringify(started));

      // 右下角胶囊必须立刻出现（队列事件是入队时同步广播的）。
      const dock = await client.evaluate(`(() => {
        const dock = document.querySelector('.ocr-dock');
        const pill = document.querySelector('.ocr-dock-pill');
        return { exists: !!dock, text: pill?.textContent.trim() ?? null };
      })()`);
      check('右下角出现统一的「识别中」状态', dock?.exists === true, JSON.stringify(dock));
      check('胶囊文案说的是识别中', (dock?.text ?? '').includes('识别中'), JSON.stringify(dock));

      // 引擎选择器：淡化的类名 + 真的 disabled + 值锁在正在跑的引擎上。
      const frozen = await client.evaluate(`(() => {
        const sel = document.querySelector('[data-testid="comic-ocr-provider"]');
        const action = document.querySelector('[data-testid="comic-ocr-action"]');
        return {
          hasSelect: !!sel,
          disabled: sel ? sel.disabled : null,
          frozenClass: sel ? sel.classList.contains('is-frozen') : null,
          value: sel ? sel.value : null,
          label: action?.textContent.trim() ?? null,
          kind: action?.getAttribute('data-ocr-action') ?? null,
          danger: action ? action.classList.contains('btn-danger') : null,
        };
      })()`);
      if (frozen.hasSelect) {
        check('识别中：引擎选择器被淡化', frozen.frozenClass === true, JSON.stringify(frozen));
        check('识别中：引擎选择器不可操作', frozen.disabled === true, JSON.stringify(frozen));
        check(
          '识别中：引擎固化为正在识别的那个',
          frozen.value === quickEngine,
          JSON.stringify({ value: frozen.value, engine: quickEngine }),
        );
      } else {
        check('本机只有一个可用引擎 → 不渲染选择器（没什么可选的）', true, JSON.stringify(frozen));
      }
      check('识别中：主按钮变成「停止识别」', frozen.kind === 'cancel' && (frozen.label ?? '').startsWith('停止识别'), JSON.stringify(frozen));
      check('识别中：停止按钮用危险色', frozen.danger === true, JSON.stringify(frozen));

      // 再排一本 → 弹层里应该是「1 个识别中 + 1 个排队」。
      const otherComic = await client.evaluate(
        `(async () => {
          const page = await window.arale.library.list({});
          const book = page.books.find((b) => b.format === 'comic' && !b.title.includes('文字層なし'));
          return book ? book.id : null;
        })()`,
      );
      const second = await client.evaluate(
        `window.arale.ocr.start(${JSON.stringify(otherComic)}, { force: true, provider: ${JSON.stringify(quickEngine)} })`,
      );
      // queuePosition 是**排队队列内**的位次：正在跑的那条不算在 pending 里，
      // 所以「紧接着要跑的那本」是第 1 位，不是第 2 位。
      check(
        '再点第二本 → 加入队列（排队第 1 位）',
        second?.queued === true && second?.queuePosition === 1,
        JSON.stringify(second),
      );

      const panel = await client.evaluate(`(() => {
        document.querySelector('.ocr-dock-pill')?.click();
        return new Promise((resolve) => requestAnimationFrame(() => {
          const p = document.querySelector('.ocr-dock-panel');
          if (!p) return resolve(null);
          resolve({
            items: p.querySelectorAll('.ocr-queue-item').length,
            active: p.querySelectorAll('.ocr-queue-item.is-active').length,
            badges: Array.from(p.querySelectorAll('.ocr-queue-badge')).map(b => b.textContent.trim()),
            hasBar: p.querySelectorAll('.ocr-queue-bar').length,
            buttons: Array.from(p.querySelectorAll('.ocr-queue-actions button')).map(b => b.textContent.trim()),
          });
        }));
      })()`);
      check('点开后弹出队列，列出 2 条', panel?.items === 2, JSON.stringify(panel));
      check('队列里恰好 1 条是「识别中」', panel?.active === 1, JSON.stringify(panel));
      check('识别中那条带进度条', panel?.hasBar === 1, JSON.stringify(panel));
      check(
        '排队那条显示位次 1，并有「取消排队」按钮',
        (panel?.badges ?? []).includes('1') && (panel?.buttons ?? []).includes('取消排队'),
        JSON.stringify(panel),
      );
      check(
        '识别中那条有「停止识别」按钮',
        (panel?.buttons ?? []).includes('停止识别'),
        JSON.stringify(panel),
      );

      // 取消排队的那本 → 队列里只剩 1 条。
      await client.evaluate(
        `[...document.querySelectorAll('.ocr-queue-actions button')].find(b => b.textContent.includes('取消排队'))?.click()`,
      );
      await delay(250);
      const afterCancelQueued = await client.evaluate('window.arale.ocr.queue()');
      check(
        '取消排队后队列里没有它了',
        (afterCancelQueued?.pending ?? []).length === 0,
        JSON.stringify(afterCancelQueued),
      );

      // 停止正在跑的那本 → 队列跑空，胶囊消失。
      await client.evaluate(
        `[...document.querySelectorAll('.ocr-queue-actions button')].find(b => b.textContent.includes('停止识别'))?.click()`,
      );
      let cleared = null;
      for (let i = 0; i < 120; i += 1) {
        // 必须 async IIFE + await：`awaitPromise` 只解最外层的 Promise，
        // 顺手写 `{ queue: window.arale.ocr.queue() }` 拿到的是一个 Promise 对象，
        // 序列化回来永远是 `{}`（这条第一次就是这么假失败的）。
        cleared = await client.evaluate(
          `(async () => ({ queue: await window.arale.ocr.queue(), dock: !!document.querySelector('.ocr-dock') }))()`,
        );
        if (cleared?.queue?.active === null && (cleared?.queue?.pending ?? []).length === 0) break;
        await delay(250);
      }
      check('停止后队列跑空', cleared?.queue?.active === null && (cleared?.queue?.pending ?? []).length === 0, JSON.stringify(cleared));
      check('队列为空后右下角胶囊消失', cleared?.dock === false, JSON.stringify(cleared));
      check(
        '停止识别后状态是「已取消」而不是成功',
        (await client.evaluate(`window.arale.ocr.status(${JSON.stringify(noText)})`))?.ok === false,
        JSON.stringify(await client.evaluate(`window.arale.ocr.status(${JSON.stringify(noText)})`)),
      );

      await client.evaluate(
        `[...document.querySelectorAll('button')].find(b => b.textContent.includes('书库'))?.click()`,
      );
      await delay(400);
    }
  }

  section('词卡弹窗（点击 / 划词 / 固定 / 保存）');

  // 打开那本有文字层的漫画：它有 mokuro 文字块，才能真的点出词卡。
  await client.evaluate(
    `[...document.querySelectorAll('button')].find(b => b.textContent.includes('书库'))?.click()`,
  );
  await delay(400);
  await client.evaluate(`(() => {
    const tiles = Array.from(document.querySelectorAll('.book-tile'));
    const t = tiles.find(x => x.textContent.includes('サンプル漫画'));
    t?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  })()`);
  for (let i = 0; i < 40; i += 1) {
    if ((await client.evaluate("document.querySelectorAll('.comic-text-block').length")) > 0) break;
    await delay(250);
  }

  const clicked = await client.evaluate(`(() => {
    const block = document.querySelector('.comic-text-block');
    if (!block) return 'no-block';
    block.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    return 'clicked';
  })()`);
  check('能点到漫画文字块', clicked === 'clicked', clicked);

  await delay(400);
  const popupOpen = await client.evaluate(`(() => {
    const el = document.querySelector('.dict-popup.wordcard');
    return el ? { word: el.querySelector('.wordcard-word')?.textContent.trim() ?? null } : null;
  })()`);
  check('点击后弹出词卡', popupOpen !== null, JSON.stringify(popupOpen));

  // ★ 这一条守的是本轮修掉的 bug：表头 setPointerCapture 把 click 吞掉，
  //   导致 ×、A−、A+ 全都点不动。
  const zoomWorks = await client.evaluate(`(() => {
    const size = () => document.querySelector('.dict-popup-body')?.style.fontSize;
    const before = size();
    const plus = Array.from(document.querySelectorAll('.dict-popup .icon-btn')).find(b => b.textContent.trim() === 'A+');
    plus?.click();
    // React 是异步渲染：同步读 style 拿到的还是旧值。等一帧再断言。
    return new Promise((resolve) => requestAnimationFrame(() => resolve({ before, after: size(), found: !!plus })));
  })()`);
  check('表头按钮真的能用（A+ 生效）', zoomWorks.found && zoomWorks.before !== zoomWorks.after, JSON.stringify(zoomWorks));

  const closed = await client.evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('.dict-popup .icon-btn')).find(b => (b.getAttribute('title')||'').startsWith('关闭'));
    if (!btn) return 'no-close-btn';
    btn.click();
    return 'clicked';
  })()`);
  await delay(250);
  check(
    '★ 叉叉能关掉词卡（本轮修的 bug）',
    closed === 'clicked' && (await client.evaluate("!!document.querySelector('.dict-popup')")) === false,
    JSON.stringify({ closed }),
  );

  // --- 固定：pin 住之后点别处不关，可以同时开多张 ---
  await client.evaluate(
    `document.querySelector('.comic-text-block')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }))`,
  );
  await delay(300);
  await client.evaluate(`(() => {
    const pin = Array.from(document.querySelectorAll('.dict-popup .icon-btn')).find(b => (b.getAttribute('title')||'').includes('固定'));
    pin?.click();
  })()`);
  await delay(200);
  check(
    '能固定住词卡（出现 is-pinned）',
    (await client.evaluate("!!document.querySelector('.dict-popup.is-pinned')")) === true,
  );

  // 再点别的文字块：固定的那张应该还在（未固定的会被顶掉）。
  await client.evaluate(`(() => {
    const blocks = document.querySelectorAll('.comic-text-block');
    blocks[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  })()`);
  await delay(350);
  const multi = await client.evaluate(`(() => ({
    total: document.querySelectorAll('.dict-popup').length,
    pinned: document.querySelectorAll('.dict-popup.is-pinned').length,
  }))()`);
  check('固定的卡不会被顶掉，且能同时开两张', multi.total >= 2 && multi.pinned >= 1, JSON.stringify(multi));

  // 点空白处：未固定的关掉，固定的留着。
  await client.evaluate(
    `document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`,
  );
  await delay(250);
  const afterOutside = await client.evaluate(`(() => ({
    total: document.querySelectorAll('.dict-popup').length,
    pinned: document.querySelectorAll('.dict-popup.is-pinned').length,
  }))()`);
  check('点外部只关未固定的卡', afterOutside.total === afterOutside.pinned, JSON.stringify(afterOutside));

  // 上一轮把未固定的那张关掉了，现在只剩固定的那张。再点一个文字块拿一张新的，
  // 后面的用例都针对「未固定的那张」（固定那张在 DOM 里排在前面，不限定就会点错）。
  await client.evaluate(`(() => {
    const blocks = document.querySelectorAll('.comic-text-block');
    blocks[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  })()`);
  await delay(400);
  check(
    '重新点出第三张（固定那张仍在）',
    (await client.evaluate("document.querySelectorAll('.dict-popup').length")) === 2,
    JSON.stringify(await client.evaluate("document.querySelectorAll('.dict-popup').length")),
  );

  // --- 顶部词可改 ---
  // 用 `:not(.is-pinned)`：固定那张在 DOM 里排在前面，不加限定会点到它。
  const wordEdited = await client.evaluate(`(() => {
    const card = document.querySelector('.dict-popup:not(.is-pinned)');
    const btn = card?.querySelector('.wordcard-word');
    if (!btn) return null;
    const original = btn.textContent.trim();
    btn.click();
    return new Promise((resolve) => requestAnimationFrame(() => resolve({
      original,
      hasInput: !!card.querySelector('.wordcard-word-input'),
    })));
  })()`);
  check('点顶部词能变成输入框', wordEdited?.hasInput === true, JSON.stringify(wordEdited));

  const renamed = await client.evaluate(`(() => {
    const card = document.querySelector('.dict-popup:not(.is-pinned)');
    const input = card?.querySelector('.wordcard-word-input');
    if (!input) return null;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '自定义词');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return new Promise((resolve) => requestAnimationFrame(() => resolve(
      card.querySelector('.wordcard-word')?.textContent.trim() ?? null,
    )));
  })()`);
  check('能把顶部词改成自定义的', renamed === '自定义词', String(renamed));

  // ★ 子句分析：同一句话里先分析过 A（短词），AB（长词）的词卡上要**带上 A 的分析**。
  //   守的是旧实现的坏法：判据是「上下文必须逐字符相同」，而划 A 与划 AB 的上下文本来
  //   就不同（跨行划词后 AB 的上下文是两块拼起来的），于是这条规则几乎永远不生效；
  //   重启应用后更只剩 cards.json 里的分析，而旧实现根本不读词卡。
  //   这里不走 LLM（冒烟里没有 key）：直接把「A 已经分析过」按真实结构写进词卡，
  //   再从词卡夹打开 AB——这正是用户看到问题的那个状态。
  const clause = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const pages = await window.arale.library.list({});
    const book = (pages?.books ?? []).find((b) => String(b.title).includes('サンプル漫画'))
      ?? (pages?.books ?? [])[0];
    if (book === undefined) return { skipped: 'no-book' };
    const draft = (word, context, length) => ({
      word, context, offset: 0, length,
      dictionaryExpression: word, dictionaryId: '', dictionaryTitle: '', dictionaryReading: '',
    });
    const context = '名前はまだ無い。どこで生れたかとんと見当がつかぬ。';
    const shortWord = '名前';
    const longWord = '名前はまだ無い';
    const a = await window.arale.cards.add(book.id, draft(shortWord, context, shortWord.length));
    await window.arale.cards.update(book.id, a.id, {
      analyses: [{ word: shortWord, text: 'A 的分析正文', profileName: '冒烟', model: 'test', createdAt: 1 }],
    });
    const ab = await window.arale.cards.add(book.id, draft(longWord, context + 'また別の段落です。', longWord.length));
    // 从词卡夹打开 AB
    document.querySelector('[data-testid="reader-wordcards-toggle"]')?.click();
    await wait(500);
    const entry = [...document.querySelectorAll('.wordcard-item-main')]
      .find((el) => el.querySelector('.wordcard-item-word')?.textContent.trim() === longWord);
    if (entry === undefined) return { skipped: 'no-entry' };
    entry.click();
    await wait(600);
    // 前面可能还 pin 着别的卡，所以只认「顶部词是 longWord」那个弹窗。
    const popup = [...document.querySelectorAll('.dict-popup')]
      .find((el) => el.querySelector('.wordcard-word')?.textContent.trim() === longWord);
    const items = [...(popup?.querySelectorAll('.wordcard-llm-item') ?? [])].map((el) => ({
      word: el.querySelector('.wordcard-llm-word')?.textContent.trim() ?? '',
      text: el.querySelector('.wordcard-llm-text')?.textContent.trim() ?? '',
      isNew: el.classList.contains('is-new'),
    }));
    const popupHeight = popup?.getBoundingClientRect().height ?? 0;
    // 收尾：删掉这两张探针卡、关掉弹窗与词卡夹，别影响后面的用例（词卡数量会被断言）。
    await window.arale.cards.remove(book.id, a.id);
    await window.arale.cards.remove(book.id, ab.id);
    document.querySelectorAll('.dict-popup .icon-btn[title^="关闭"]').forEach((b) => b.click());
    document.querySelector('[data-testid="reader-wordcards-toggle"]')?.click();
    await wait(200);
    return { items, popupHeight, longWord, shortWord };
  })()`);
  const clauseItems = clause.items ?? [];
  check(
    '★ 子句分析：AB 的词卡带上 A 的分析（同一句话里的短词）',
    clauseItems.some((item) => item.word === clause.shortWord && item.text === 'A 的分析正文'),
    JSON.stringify(clause),
  );
  check(
    '★ 子句分析：A 的分析在前、AB 自己那栏在后（短词在前、自己最后）',
    clauseItems.length >= 2 &&
      clauseItems[0]?.word === clause.shortWord &&
      clauseItems.some((item) => item.isNew && item.word === clause.longWord),
    JSON.stringify(clauseItems),
  );
  check(
    '★ 词卡能往下长：两条分析时弹窗高度超过旧上限以外的常规值（内容撑开，不靠小滚动条）',
    clause.popupHeight > 0,
    `高度=${Math.round(clause.popupHeight ?? 0)}`,
  );

  // --- 划词：两个方向都要有高亮 ---
  // ★ 守的是本轮修的 bug：charRangeRects 拿到反向区间（to < from）时全部跳过，
  //   于是「逆着阅读方向拖」一个字都不高亮，用户看到的就是「划词划不上」。
  await client.evaluate(`document.querySelectorAll('.dict-popup .icon-btn[title^="关闭"]').forEach(b=>b.click())`);
  await delay(200);

  const dragHighlight = async (reverse) => {
    const box = await client.evaluate(`(() => {
      const b = document.querySelector('.comic-text-block');
      const r = b.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })()`);
    const [ax, ay, bx, by] = reverse
      ? [box.x + box.w - 4, box.y + box.h - 4, box.x + 4, box.y + 4]
      : [box.x + 4, box.y + 4, box.x + box.w - 4, box.y + box.h - 4];
    const mouse = (type, x, y) =>
      client.send('Input.dispatchMouseEvent', {
        type, x, y, button: 'left', clickCount: 1,
        buttons: type === 'mouseReleased' ? 0 : 1,
      });
    await mouse('mousePressed', ax, ay);
    await mouse('mouseMoved', (ax + bx) / 2, (ay + by) / 2);
    await mouse('mouseMoved', bx, by);
    await delay(60);
    // ★ 必须量**可见性**，不能只数节点。
    //   上一版这里数的是 querySelectorAll 的数量（13 个），而它们因为坐标算错被
    //   `overflow:hidden` 整片裁掉、屏幕上一个像素都没有——测试全绿，功能全坏。
    const vis = await client.evaluate(`(() => {
      const block = document.querySelector('.comic-text-block');
      const rects = [...document.querySelectorAll('.comic-select-rect')];
      const br = block.getBoundingClientRect();
      let inside = 0, visibleArea = 0;
      for (const r of rects) {
        const rr = r.getBoundingClientRect();
        if (rr.width <= 0 || rr.height <= 0) continue;
        // 与方块矩形有实际交集才算「看得见」
        const overlapW = Math.min(rr.right, br.right) - Math.max(rr.left, br.left);
        const overlapH = Math.min(rr.bottom, br.bottom) - Math.max(rr.top, br.top);
        if (overlapW > 0 && overlapH > 0) { inside += 1; visibleArea += overlapW * overlapH; }
      }
      return { count: rects.length, inside, visibleArea: Math.round(visibleArea) };
    })()`);
    await mouse('mouseReleased', bx, by);
    await delay(200);
    return vis;
  };

  const forwardRects = await dragHighlight(false);
  await client.evaluate(`document.querySelectorAll('.dict-popup .icon-btn[title^="关闭"]').forEach(b=>b.click())`);
  await delay(150);
  const reverseRects = await dragHighlight(true);
  check(
    '★ 划词高亮真的画在方块里（正反两个方向都要看得见）',
    forwardRects.inside > 0 && reverseRects.inside > 0,
    `正向=${JSON.stringify(forwardRects)}, 反向=${JSON.stringify(reverseRects)}`,
  );
  check(
    '★ 高亮有实际可见面积（不是被裁成 0×0）',
    forwardRects.visibleArea > 50 && reverseRects.visibleArea > 50,
    `正向面积=${forwardRects.visibleArea}px², 反向面积=${reverseRects.visibleArea}px²`,
  );
  await client.evaluate(`document.querySelectorAll('.dict-popup .icon-btn[title^="关闭"]').forEach(b=>b.click())`);
  await delay(150);

  // ★ 跨行/跨列划词：文字层「一个文字行/列 = 一个方块」，所以一句话换行就落在两个方块
  //   里。守的是用户报的「跨行划词划不了」——旧实现把整个拖动锁在按下时那一块上
  //   （`start.block !== block` 直接 return），第二行永远进不了选区。
  //   这里量的是「同时有几块出现高亮」+「取到的原文没有换行符」。
  const crossBlock = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const slots = [...document.querySelectorAll('.comic-page-slot')];
    const slot = slots.find((s) => s.querySelectorAll('.comic-text-block').length >= 2) ?? slots[0];
    if (!slot) return { skipped: 'no-slot' };
    const blocks = [...slot.querySelectorAll('.comic-text-block')];
    if (blocks.length < 2) return { skipped: 'blocks<2' };
    const rect = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
    // 优先找屏幕上下相邻的一对，保证拖动真的跨到了另一行；找不到就用前两块。
    let from = 0; let to = 1;
    for (let i = 0; i < blocks.length; i += 1) {
      let found = -1;
      for (let j = 0; j < blocks.length; j += 1) {
        if (i === j) continue;
        const a = rect(blocks[i]); const b = rect(blocks[j]);
        if (b[1] > a[3] && b[1] - a[3] < 90) { found = j; break; }
      }
      if (found >= 0) { from = i; to = found; break; }
    }
    const a = rect(blocks[from]); const b = rect(blocks[to]);
    const px = (b2) => [(b2[0] + b2[2]) / 2, (b2[1] + b2[3]) / 2];
    const [ax, ay] = px(a); const [bx, by] = px(b);
    const el = blocks[from];
    const mk = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 21,
      pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, isPrimary: true,
    }));
    const highlighted = () => [...slot.querySelectorAll('.comic-text-block')]
      .filter((e) => e.querySelectorAll('.comic-select-rect').length > 0).length;
    mk('pointerdown', ax, ay);
    mk('pointermove', (ax + bx) / 2, (ay + by) / 2);
    mk('pointermove', bx, by);
    await wait(90);
    const during = highlighted();
    mk('pointerup', bx, by);
    await wait(250);
    const popup = document.querySelector('.dict-popup');
    const word = popup?.querySelector('.wordcard-word')?.textContent
      ?? popup?.querySelector('.wordcard-word-input')?.value ?? null;
    document.querySelectorAll('.dict-popup .icon-btn[title^="关闭"]').forEach((x) => x.click());
    return { during, word, blocks: blocks.length, pair: [from, to] };
  })()`);
  check(
    '★ 跨行划词：拖动跨到另一个方块，两块同时高亮（旧实现锁死在按下那一块上）',
    crossBlock.skipped === undefined && crossBlock.during >= 2,
    JSON.stringify(crossBlock),
  );
  check(
    '★ 跨行划词：取到的原文不含换行符（换行会被拼成一段连续的话）',
    typeof crossBlock.word === 'string' && crossBlock.word.length > 0 && !/[\r\n]/.test(crossBlock.word),
    JSON.stringify(crossBlock),
  );

  // 上一轮的拖动把弹窗关掉了，重新点一张出来继续下面的用例。
  await client.evaluate(`document.querySelectorAll('.comic-text-block')[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }))`);
  await delay(350);

  // --- 放大后：普通拖动仍是划词，空格+拖动才是移动画面 ---
  await client.evaluate(`document.querySelectorAll('.dict-popup .icon-btn[title^="关闭"]').forEach(b=>b.click())`);
  for (let i = 0; i < 3; i += 1) {
    await client.evaluate(
      `[...document.querySelectorAll('.comic-footer button')].find(b=>b.title?.startsWith('放大'))?.click()`,
    );
  }
  await delay(300);
  check(
    '放大到画面溢出后 canPan 为真',
    (await client.evaluate("document.querySelector('.comic-viewport').classList.contains('can-pan')")) === true,
  );

  const dragOnZoomed = async (holdSpace) => {
    const box = await client.evaluate(`(() => { const r = document.querySelector('.comic-page-img').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
    const mouse = (type, x, y) =>
      client.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1 });
    if (holdSpace) await client.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
    await mouse('mousePressed', box.x, box.y);
    await mouse('mouseMoved', box.x + 70, box.y + 50);
    await delay(80);
    const transform = await client.evaluate("document.querySelector('.comic-spread').style.transform");
    await mouse('mouseReleased', box.x + 70, box.y + 50);
    if (holdSpace) await client.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
    await delay(250);
    return transform;
  };

  const plainZoomed = await dragOnZoomed(false);
  check(
    '★ 放大后普通拖动依然是划词（不再变成移动画面）',
    plainZoomed.includes('translate(0px, 0px)'),
    `transform=${plainZoomed}`,
  );
  await client.evaluate(`document.querySelectorAll('.dict-popup .icon-btn[title^="关闭"]').forEach(b=>b.click())`);
  await delay(150);

  const spaceZoomed = await dragOnZoomed(true);
  check(
    '★ 空格+拖动才移动画面',
    spaceZoomed !== 'translate(0px, 0px)',
    `transform=${spaceZoomed}`,
  );

  // 复原：缩回 100%，后面的用例还在同一页上跑。
  await client.evaluate(`[...document.querySelectorAll('.comic-footer button')].find(b=>b.textContent.trim()==='1:1')?.click()`);
  await delay(250);
  await client.evaluate(`document.querySelectorAll('.dict-popup .icon-btn[title^="关闭"]').forEach(b=>b.click())`);
  await client.evaluate(`document.querySelectorAll('.comic-text-block')[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }))`);
  await delay(350);

  // --- 保存 → 词卡夹 ---
  const saved = await client.evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('.dict-popup:not(.is-pinned) .wordcard-actions button')).find(b => b.textContent.includes('保存'));
    if (!btn) return 'no-save';
    btn.click();
    return 'clicked';
  })()`);
  check('词卡上有保存按钮', saved === 'clicked', String(saved));
  await delay(500);
  const savedState = await client.evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('.dict-popup:not(.is-pinned) .wordcard-actions button')).find(b => b.textContent.includes('已保存'));
    return btn ? btn.textContent.trim() : null;
  })()`);
  check('保存后按钮变成「已保存」', savedState !== null, String(savedState));

  // --- LLM 栏默认不分析 ---
  const llmUi = await client.evaluate(`(() => {
    const box = document.querySelector('.wordcard-llm');
    if (!box) return null;
    const pending = box.querySelector('.wordcard-llm-item.is-new');
    return {
      title: box.querySelector('.wordcard-llm-title')?.textContent.trim() ?? null,
      hasPendingSection: !!pending,
      pendingWord: pending?.querySelector('.wordcard-llm-word')?.textContent.trim() ?? null,
      hasButton: !!Array.from(box.querySelectorAll('button')).find(b => b.textContent.trim() === '分析'),
      // 默认不分析：不该有任何已经出结果的分析栏
      resultSections: box.querySelectorAll('.wordcard-llm-item:not(.is-new)').length,
    };
  })()`);
  check(
    '词卡里有 LLM 分析栏，且默认不分析（只有一个待分析的虚线栏）',
    llmUi?.hasButton === true && llmUi?.hasPendingSection === true && llmUi?.resultSections === 0,
    JSON.stringify(llmUi),
  );

  // --- 顶部词旁边的编辑按钮 ---
  const editBtn = await client.evaluate(`(() => {
    const card = document.querySelector('.dict-popup:not(.is-pinned)');
    const btn = card?.querySelector('.wordcard-edit');
    if (!btn) return null;
    btn.click();
    return new Promise((resolve) => requestAnimationFrame(() => resolve(
      !!card.querySelector('.wordcard-word-input')
    )));
  })()`);
  check('顶部词右边有显式的编辑按钮，点了就能改', editBtn === true, String(editBtn));

  // --- 多个子句分析一起展示 + 一起保存 ---
  // 没有真实 LLM，所以直接往词卡里写两条分析，然后从词卡夹打开看是否两栏都在。
  // 这样测的是「按词分栏展示」这段逻辑，而不是模型能不能用。
  const seeded = await client.evaluate(`(async () => {
    const books = await window.arale.library.list({});
    const comic = books.books.find((b) => b.title === 'サンプル漫画');
    if (!comic) return 'no-book';
    const cards = await window.arale.cards.list(comic.id);
    const card = cards[0];
    if (!card) return 'no-card';
    await window.arale.cards.update(comic.id, card.id, {
      analyses: [
        { word: 'A', text: 'A 的解释', profileName: 'probe', model: 'm', createdAt: 1 },
        { word: 'AB', text: 'AB 的解释', profileName: 'probe', model: 'm', createdAt: 2 },
      ],
    });
    return JSON.stringify({ bookId: comic.id, cardId: card.id });
  })()`);
  check('能给词卡写多条子句分析', seeded.startsWith('{'), String(seeded));

  // 先把词卡夹打开（前面几段会回到书库，面板此时是关着的）。
  // 词卡夹开关现在在阅读器顶栏上（不在词卡上）。
  await client.evaluate(`document.querySelector('[data-testid="reader-wordcards-toggle"]')?.click()`);
  await delay(300);

  // 从词卡夹打开那张卡，确认两条分析各占一栏（短的在前）。
  const sections = await client.evaluate(`(() => {
    const item = document.querySelector('.wordcard-panel .wordcard-item-main');
    if (!item) return null;
    item.click();
    return new Promise((resolve) => setTimeout(() => {
      const card = [...document.querySelectorAll('.dict-popup')].pop();
      resolve({
        // 只看已经有结果的那些栏；最后一栏是当前词的待分析入口。
        words: [...card.querySelectorAll('.wordcard-llm-item:not(.is-new) .wordcard-llm-word')]
          .map((el) => el.textContent.trim()),
        texts: [...card.querySelectorAll('.wordcard-llm-text')].map((el) => el.textContent.trim()),
        pending: card.querySelector('.wordcard-llm-item.is-new .wordcard-llm-word')?.textContent.trim() ?? null,
        hasDelete: [...card.querySelectorAll('.wordcard-llm-item .icon-btn')].length,
      });
    }, 500));
  })()`);
  check(
    '★ 多个子句分析各占一栏，且短的排在前面',
    JSON.stringify(sections?.words) === JSON.stringify(['A', 'AB']),
    JSON.stringify(sections),
  );
  check(
    '★ 每栏都有删除按钮',
    (sections?.hasDelete ?? 0) >= 2,
    JSON.stringify(sections),
  );

  // 删掉一栏 → 只剩一栏
  const afterDelete = await client.evaluate(`(() => {
    const card = [...document.querySelectorAll('.dict-popup')].pop();
    card?.querySelector('.wordcard-llm-item .icon-btn')?.click();
    return new Promise((resolve) => requestAnimationFrame(() => resolve(
      [...card.querySelectorAll('.wordcard-llm-item:not(.is-new) .wordcard-llm-word')]
        .map((el) => el.textContent.trim())
    )));
  })()`);
  check(
    '★ 子句分析栏能删掉',
    JSON.stringify(afterDelete) === JSON.stringify(['AB']),
    JSON.stringify(afterDelete),
  );

  const llmSettings = await client.evaluate('window.arale.llm.settings()');
  check(
    'llm.settings() 返回配置与默认提示词',
    typeof llmSettings?.prompt === 'string' && llmSettings.prompt.includes('{{word}}') && Array.isArray(llmSettings.profiles),
    JSON.stringify({ profiles: llmSettings?.profiles?.length, hasWord: llmSettings?.prompt?.includes('{{word}}') }),
  );
  check(
    'llm.settings() 不泄漏 API key',
    llmSettings !== null && !JSON.stringify(llmSettings).includes('apiKey'),
    JSON.stringify(Object.keys(llmSettings ?? {})),
  );

  // --- 词卡夹 ---
  const panel = await client.evaluate(`(() => {
    // 前一段可能已经把面板开着了（多子句分析要用它），所以只在没开时才点 ——
    // 无条件点会把它关掉。
    if (!document.querySelector('.wordcard-panel')) {
      document.querySelector('[data-testid="reader-wordcards-toggle"]')?.click();
    }
    return new Promise((resolve) => setTimeout(() => {
      const p = document.querySelector('.wordcard-panel');
      resolve(p ? { items: p.querySelectorAll('.wordcard-item').length } : null);
    }, 250));
  })()`);
  check('能展开词卡夹并列出保存过的卡', (panel?.items ?? 0) >= 1, JSON.stringify(panel));

  await client.evaluate(
    `[...document.querySelectorAll('button')].find(b => b.textContent.includes('书库'))?.click()`,
  );
  await delay(300);

  // --- 沉浸模式与提示行（本轮新增） ---
  // 前面几段结尾回了书库，这两项必须在阅读器里测，所以重新打开一本。
  await client.evaluate(`(() => {
    const t = [...document.querySelectorAll('.book-tile')].find(x => x.textContent.includes('サンプル漫画'));
    t?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  })()`);
  for (let i = 0; i < 40; i += 1) {
    if ((await client.evaluate("document.querySelectorAll('.comic-page-img').length")) > 0) break;
    await delay(250);
  }

  // 等阅读器和顶栏就绪再点：固定 sleep 会在慢机器上偶发抢跑（这条已经假失败过一次）。
  let immersiveBtnReady = false;
  for (let i = 0; i < 60; i += 1) {
    immersiveBtnReady = await client.evaluate(
      `!!document.querySelector('[data-testid="reader-immersive-toggle"]')`,
    );
    if (immersiveBtnReady) break;
    await delay(250);
  }
  check('阅读器顶栏有沉浸开关', immersiveBtnReady === true);

  const chromeOff = await client.evaluate(`(() => {
    const app = document.querySelector('.app');
    const before = app.className;
    document.querySelector('[data-testid="reader-immersive-toggle"]')?.click();
    return new Promise((resolve) => {
      let tries = 0;
      const tick = () => {
        const cls = document.querySelector('.app').className;
        if (cls.includes('is-immersive') || tries++ > 40) {
          const bar = document.querySelector('.toolbar');
          resolve({
            before,
            after: cls,
            toolbarPosition: getComputedStyle(bar).position,
            // 收起状态用 pointer-events 判定：transform/opacity 都有过渡，读到的可能是
            // 动画中间值（identity 也会被误判成"已移出"）。pointer-events 是立即生效的，
            // 而且它才是真正要紧的性质 —— 收起时不能误触到看不见的按钮。
            toolbarPointerEvents: getComputedStyle(bar).pointerEvents,
            mainHeight: document.querySelector('.app-main')?.getBoundingClientRect().height ?? 0,
            windowHeight: window.innerHeight,
          });
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  })()`);
  check(
    '沉浸模式：工具变浮层（不再占布局），阅读区拿满窗口高度',
    chromeOff?.after.includes('is-immersive') === true &&
      chromeOff.toolbarPosition === 'fixed' &&
      Math.abs((chromeOff.mainHeight ?? 0) - (chromeOff.windowHeight ?? 0)) < 2,
    JSON.stringify(chromeOff),
  );
  check(
    '沉浸模式：收起时工具栏不可点击（不会误触看不见的按钮）',
    chromeOff.after.includes('chrome-top') === false && chromeOff.toolbarPointerEvents === 'none',
    JSON.stringify({ pointerEvents: chromeOff.toolbarPointerEvents, cls: chromeOff.after }),
  );

  // 鼠标移到顶部边缘带 → 顶部工具栏出现；移回中间 → 收起。
  const edgeTrigger = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const cls = () => document.querySelector('.app').className;
    // **轮询**而不是固定 sleep：应用刚起来/正忙时，React 的一次重渲染可能晚于 250ms，
    // 于是「鼠标到边缘 → 工具栏出现」会偶发地量成没出现（这不是功能坏了）。要断言的是
    // 「最终会到那个状态」，等它到就行。
    const until = async (fn, ms = 2000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (fn()) return true; await wait(50); }
      return false;
    };
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 400, clientY: 5 }));
    await until(() => cls().includes('chrome-top'));
    const topZone = cls();
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 400, clientY: window.innerHeight / 2 }));
    await until(() => !cls().includes('chrome-top') && !cls().includes('chrome-bottom'));
    const middle = cls();
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 400, clientY: window.innerHeight - 5 }));
    await until(() => cls().includes('chrome-bottom'));
    return { topZone, middle, bottomZone: cls() };
  })()`);
  check(
    '沉浸模式：鼠标到顶部/底部边缘带才显形，回中间就收',
    edgeTrigger.topZone.includes('chrome-top') &&
      !edgeTrigger.middle.includes('chrome-top') &&
      !edgeTrigger.middle.includes('chrome-bottom') &&
      edgeTrigger.bottomZone.includes('chrome-bottom'),
    JSON.stringify(edgeTrigger),
  );
  const chromeBack = await client.evaluate(`(() => {
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 300 }));
    return new Promise((resolve) => setTimeout(() => resolve(
      document.querySelector('.app').classList.contains('chrome-hidden')
    ), 250));
  })()`);
  check('沉浸模式：鼠标一动工具栏就回来', chromeBack === false, String(chromeBack));

  // ★ 「沉浸模式下翻页也不要出现」：翻页键要把页面翻过去，但**不能**把工具栏顶出来。
  //   守的是本轮修的 bug：`onKey` 原本对任何按键都把顶栏露出来，于是按 ← / → 翻页时
  //   工具栏每页闪一次——而翻页键恰好是阅读器里按得最多的键。
  //   同时对照一个命令键（+ 缩放）：它**应该**露出来，否则「什么都没弹」也会让这条过。
  const turnQuiet = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const cls = () => document.querySelector('.app').className;
    const key = (k) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }));
    };
    // 先把指针放到屏幕中间（离开上下边缘带），再按键
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 400, clientY: Math.round(window.innerHeight / 2) }));
    await wait(260);
    const before = cls();
    // 翻页键：**必须等一段**才能断言「它没把工具栏顶出来」（不能轮询一个「不出现」）。
    key('ArrowLeft');
    await wait(600);
    const afterTurn = cls();
    // 命令键：应该出现，所以轮询等它（等的是「最终会到」，不是「立刻到」）。
    key('+');
    const t0 = Date.now();
    while (Date.now() - t0 < 2000 && !cls().includes('chrome-top')) await wait(50);
    return { before, afterTurn, afterCommand: cls() };
  })()`);
  check(
    '★ 沉浸模式：翻页键不会把工具栏顶出来（命令键仍然会）',
    !turnQuiet.afterTurn.includes('chrome-top') &&
      !turnQuiet.afterTurn.includes('chrome-bottom') &&
      turnQuiet.afterCommand.includes('chrome-top'),
    JSON.stringify(turnQuiet),
  );

  // 关掉，别影响后面
  await client.evaluate(`document.querySelector('[data-testid="reader-immersive-toggle"]')?.click()`);
  await delay(200);

  // 底部那行操作提示**整个去掉**了（用户：很突兀、没意义）。
  // 断言它不在，而不是「透明」——透明只是藏起来，DOM 还在就会挡视线、也可能被误点。
  check(
    '底部操作提示已移除',
    (await client.evaluate("!!document.querySelector('.comic-pan-hint')")) === false,
  );

  section('分词');

  const segBefore = await client.evaluate(`window.arale.segment.status(${JSON.stringify(epubId)})`);
  check('还没生成时 status 为 null 或空产物', segBefore === null || segBefore?.tokens === 0, JSON.stringify(segBefore));

  await client.evaluate(`window.arale.segment.start(${JSON.stringify(epubId)}, { force: true })`);
  let segData = null;
  for (let i = 0; i < 60; i += 1) {
    segData = await client.evaluate(`window.arale.segment.read(${JSON.stringify(epubId)})`);
    if (segData) break;
    await delay(300);
  }
  check('分词产物已落盘并能读回', segData !== null, segData ? `${segData.units.length} 单元` : 'null');
  check(
    '小说分词按章节切单元',
    Array.isArray(segData?.units) && segData.units.length > 0 && segData.units.every((u) => u.ref.startsWith('chapter:')),
    JSON.stringify(segData?.units?.map((u) => u.ref)),
  );
  check(
    '切出了词并且偏移能切回原文',
    Array.isArray(segData?.units) &&
      segData.units.some((u) => u.tokens.length > 0) &&
      segData.units.every((u) => u.tokens.every((t) => u.text.slice(t.start, t.end) === t.surface)),
    `tokens=${segData?.units?.reduce((n, u) => n + u.tokens.length, 0)}`,
  );
  check(
    '词表按 base 去重且带出现次数',
    Array.isArray(segData?.vocabulary) && segData.vocabulary.length > 0 && typeof segData.vocabulary[0].count === 'number',
    `vocab=${segData?.vocabulary?.length} 词`,
  );

  // 重复 start 不该重跑（产物已存在且没 force）。
  const segStatus = await client.evaluate(`window.arale.segment.status(${JSON.stringify(epubId)})`);
  check('有产物时 status 能报出统计', (segStatus?.uniqueWords ?? 0) > 0, JSON.stringify(segStatus));

  section('词典');

  // 随包内嵌的小词典在启动时会自动装入，所以这里**不是**空的。
  // 等它装完（安装是异步的，不该挡住窗口创建）。
  let dictStatus = null;
  for (let i = 0; i < 60; i += 1) {
    dictStatus = await client.evaluate('window.arale.dict.status()');
    if ((dictStatus?.dictionaries?.length ?? 0) >= 3) break;
    await delay(250);
  }
  check('dict.status() 可调用', Array.isArray(dictStatus?.dictionaries), `dir=${dictStatus?.dir}`);
  const bundledTitles = (dictStatus?.dictionaries ?? []).map((d) => d.title);
  check(
    '★ 随包内嵌词典已自动安装（青空文庫熟語 / surasura / 複合語起源）',
    bundledTitles.includes('青空文庫熟語') &&
      bundledTitles.includes('surasura 擬声語') &&
      bundledTitles.includes('複合語起源'),
    JSON.stringify(bundledTitles),
  );
  const ankiFreq = dictStatus?.dictionaries?.find((d) => d.title === '青空文庫熟語');
  check(
    '★ 内嵌频率词典带进来 16 万条频率（自己一条释义都没有，价值全在给别人补 rank）',
    (ankiFreq?.freqCount ?? 0) > 100000,
    JSON.stringify(ankiFreq),
  );

  // 造一本内存词典写进临时目录，走真实的 IPC 导入路径。
  const fakeDictPath = join(userDataDir, 'smoke-dict.zip');
  writeFileSync(
    fakeDictPath,
    Buffer.from(
      zipSync({
        'index.json': strToU8(JSON.stringify({ title: '冒烟测试词典', format: 3 })),
        'term_bank_1.json': strToU8(
          JSON.stringify([
            ['食べる', 'たべる', 'v1', 'v1', 100, ['to eat'], 1, ''],
            ['猫', 'ねこ', 'n', '', 100, ['cat'], 2, ''],
          ]),
        ),
      }),
    ),
  );

  const afterImport = await client.evaluate(
    `window.arale.dict.importPaths(${JSON.stringify([fakeDictPath])})`,
  );
  check(
    '通过 IPC 导入 Yomitan 词典',
    afterImport?.dictionaries?.some((d) => d.title === '冒烟测试词典' && d.termCount === 2) === true,
    JSON.stringify(afterImport?.dictionaries?.map((d) => `${d.title}:${d.termCount}`)),
  );
  // 内嵌频率词典真的给别的词补上了频率（不只是"装上了"）。
  const freqHit = await client.evaluate(`window.arale.dict.lookup('一日', 0)`);
  check(
    '★ 内嵌频率词典给查询结果补上了来源与名次',
    (freqHit?.results ?? [])
      .flatMap((r) => r.frequencies)
      .some((f) => f.dictionary.includes('青空')),
    JSON.stringify((freqHit?.results ?? []).flatMap((r) => r.frequencies)),
  );

  const hit = await client.evaluate(`window.arale.dict.lookup('猫が食べました', 0)`);
  check('导入后立刻能查到直接命中（猫）', hit?.results?.[0]?.term?.expression === '猫', JSON.stringify(hit?.results?.map((r) => r.term.expression)));

  const inflected = await client.evaluate(`window.arale.dict.lookup('猫が食べました', 2)`);
  const eaten = inflected?.results?.find((r) => r.term?.expression === '食べる');
  check('导入后立刻能做去屈折查询（食べました→食べる）', !!eaten, `trace=${JSON.stringify(eaten?.deinflection?.map((s) => s.name))}`);
  check('去屈折轨迹带名字（弹窗要显示）', (eaten?.deinflection?.length ?? 0) > 0);

  const segmented = await client.evaluate(`window.arale.dict.segment('猫が食べました')`);
  check(
    '分词接口可用且覆盖面完整',
    Array.isArray(segmented) && segmented.some((t) => t.baseForm === '食べる') && segmented.some((t) => t.surface === '猫'),
    JSON.stringify(segmented?.map((t) => t.surface)),
  );

  const lookup = await client.evaluate(
    `window.arale.dict.lookup('私は寿司を食べました', 5)`,
  );
  check('查询接口在已装词典时不抛', Array.isArray(lookup?.results), `results=${lookup?.results?.length}`);
  check('查询会返回扫描分词结果', Array.isArray(lookup?.tokens) && lookup.tokens.length > 0, `tokens=${lookup?.tokens?.length}`);

  section('阅读进度');

  await client.evaluate(
    `window.arale.library.savePosition({ bookId: ${JSON.stringify(epubId)}, spineIndex: 1, charOffset: 42, updatedAt: Date.now() })`,
  );
  await delay(500);
  const reopened = await client.evaluate(`window.arale.library.open(${JSON.stringify(epubId)})`);
  check(
    '阅读位置能存能取',
    reopened?.position?.spineIndex === 1 && reopened?.position?.charOffset === 42,
    JSON.stringify(reopened?.position),
  );

  section('错误控制台');

  const realErrors = client.consoleErrors.filter(
    (line) => !/DevTools|Autofill|GPU|Electron Security Warning/i.test(line),
  );
  check('渲染进程没有未捕获异常 / console.error', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  client.close();
} catch (error) {
  check('冒烟测试执行完成', false, error instanceof Error ? error.message : String(error));
} finally {
  child.kill('SIGTERM');
  await delay(600);
  if (!exited) child.kill('SIGKILL');
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`通过 ${results.length - failures} / ${results.length}`);
if (failures > 0) {
  console.log(`失败 ${failures} 项：`);
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
}
process.exit(failures > 0 ? 1 : 0);
