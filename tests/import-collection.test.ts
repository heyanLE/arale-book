/**
 * **套娃包**导入测试：一个压缩包里装的不是页图，而是若干个压缩包。
 *
 * 为什么专门写一个文件：这不是理论场景，而是用户实际踩到的坑。
 * 发布者把「第 01-02 卷」打成一个 RAR，里面是两个分卷 RAR。旧实现在
 * `importComicCarrier` 里只看页图，于是报「这个压缩包里没有任何图片页」——
 * 用户拖进来的明明是一套漫画，却一本都进不来。
 *
 * 期望行为：每个分卷各导入成一本，而不是报错。判据、递归深度上限、面包屑来源
 * 都在 `src/main/library/importer.ts` 的 `tryImportCollection`。
 *
 * 两条分支都要覆盖：
 * - **纯 JS 分支**（`.cbz`/`.zip`）：用 `fflate` 现造，任何环境都能跑；
 * - **原生分支**（`.rar`/`.cbr`/…）：需要 Rust sidecar。这里用一个**内容其实是
 *   zip、扩展名却是 `.rar`** 的夹具——sidecar 的格式判定只认 magic bytes
 *   （见 `native/arale-native/src/format.rs`），所以这条分支能被完整走到，
 *   而不用引进「造一个真 RAR」这个外部工具依赖。RAR 解包本身由
 *   `archive-sidecar.test.ts` 用真实的 RAR 覆盖。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipSync } from 'fflate';

import { setUserDataRootForTesting, bookContentDir } from '../src/main/paths';
import { LibraryStore } from '../src/main/library/store';
import { importPath } from '../src/main/library/importer';
import { isNativeAvailable, resetNativeBinaryCache } from '../src/main/native/sidecar';
import { buildCbz } from './fixtures';

let root = '';
let sourceDir = '';
let nativeAvailable = false;

/** 一个能通过 `isComicImage` 与页图探测的最小 PNG。 */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

function buildPageZip(names: readonly string[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const name of names) entries[name] = new Uint8Array(PNG_1x1);
  return zipSync(entries);
}

/**
 * 造一个 `levels` 层深的套娃包：最内层是页图，往外每包一层。
 *
 * `levels` 是**压缩包总层数**，所以 `levels = 1` 就是一本普通漫画（不套娃）。
 * `levels = 1` 之外每多一层，就多一次 `tryImportCollection` 展开。
 */
function buildNested(levels: number, names: readonly string[] = ['p1.png', 'p2.png']): Uint8Array {
  let current = buildPageZip(names);
  for (let depth = 1; depth < levels; depth += 1) {
    current = zipSync({ [`vol-${String(depth).padStart(2, '0')}.cbz`]: current });
  }
  return current;
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-collection-'));
  setUserDataRootForTesting(root);
  sourceDir = path.join(root, 'incoming');
  fs.mkdirSync(sourceDir, { recursive: true });
  resetNativeBinaryCache();
  nativeAvailable = await isNativeAvailable();
});

after(() => {
  setUserDataRootForTesting(null);
  fs.rmSync(root, { recursive: true, force: true });
});

function freshStore(): LibraryStore {
  const store = new LibraryStore();
  store.load();
  return store;
}

function writeSource(name: string, bytes: Uint8Array): string {
  const abs = path.join(sourceDir, name);
  fs.writeFileSync(abs, bytes);
  return abs;
}

// ---------------------------------------------------------------------------
// 纯 JS 分支
// ---------------------------------------------------------------------------

test('套娃包（.cbz 里装两个 .cbz）→ 导入成两本，而不是报错', async () => {
  const source = writeSource(
    'collection-2.cbz',
    zipSync({
      '第01巻.cbz': buildPageZip(['01.png', '02.png']),
      '第02巻.cbz': buildPageZip(['01.png', '02.png', '03.png']),
    }),
  );

  const store = freshStore();
  const outcomes = await importPath(source, store);

  assert.equal(outcomes.length, 2, `应为两本，实际 ${outcomes.length}：${JSON.stringify(outcomes)}`);
  for (const outcome of outcomes) {
    assert.equal(outcome.ok, true, `分卷导入失败：${outcome.error}`);
    assert.equal(outcome.format, 'comic');
    assert.ok(outcome.bookId, '每个分卷都应有自己的 bookId');
    // 失败时 UI 靠 source 指认是哪个分卷，所以面包屑必须在。
    assert.ok(outcome.source.includes('›'), `source 应带上容器面包屑，实际：${outcome.source}`);
  }
  assert.notEqual(outcomes[0]!.bookId, outcomes[1]!.bookId, '两本必须是不同的书');

  // 页数各自独立：3 页那本不能变成 2 页（解包串台的典型症状）。
  const pageCounts = outcomes
    .map((outcome) => store.get(outcome.bookId!)?.pageCount)
    .sort((a, b) => (a ?? 0) - (b ?? 0));
  assert.deepEqual(pageCounts, [2, 3]);

  // 内容真的落到盘上了，而不是只有一条索引记录。
  for (const outcome of outcomes) {
    const book = store.get(outcome.bookId!)!;
    assert.equal(book.format, 'comic');
    for (const page of book.pages ?? []) {
      assert.ok(
        fs.existsSync(path.join(bookContentDir(book.id), ...page.url.split('/'))),
        `页图应已落盘：${page.url}`,
      );
    }
  }
});

test('三层套娃仍能一路展开到页图', async () => {
  const source = writeSource('collection-3.cbz', buildNested(4));
  const store = freshStore();
  const outcomes = await importPath(source, store);

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.ok, true, `导入失败：${outcomes[0]!.error}`);
  assert.equal(store.get(outcomes[0]!.bookId!)?.pageCount, 2);
});

test('超过嵌套深度上限：报错而不是无限递归 / 卡死', async () => {
  // 5 层 = 需要展开 4 次，超过 MAX_ARCHIVE_NESTING(3)。
  const source = writeSource('collection-5.cbz', buildNested(5));
  const store = freshStore();
  // 索引是落在 userData 根上的，前面的用例已经往里加过书；这里关心的是**增量**为零。
  const before = store.info().bookCount;
  const outcomes = await importPath(source, store);

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.ok, false, '超过上限应给出失败结果，而不是假装成功');
  // 错误信息要指向真正的原因。曾经这里落回常规路径，报的是「不支持的格式 .cbz」——
  // 扩展名明明支持，用户看了完全不知道该改什么。
  assert.match(outcomes[0]!.error ?? '', /嵌套超过/, '错误信息要指向嵌套层数上限');
  assert.equal(store.info().bookCount, before, '失败不该留下半本书');
});

test('包里既有页图又有压缩包 → 当成普通漫画，不当套娃拆', async () => {
  // 判据是「没有任何页图」。混装时用户拖进来的就是一本漫画，
  // 顺手把附带的压缩包也展开会凭空多出书来。
  const source = writeSource(
    'mixed.cbz',
    zipSync({ '001.png': new Uint8Array(PNG_1x1), 'bonus.cbz': buildPageZip(['01.png']) }),
  );
  const store = freshStore();
  const outcomes = await importPath(source, store);

  assert.equal(outcomes.length, 1, '混装包不该被拆开');
  assert.equal(outcomes[0]!.ok, true, `导入失败：${outcomes[0]!.error}`);
  assert.equal(store.get(outcomes[0]!.bookId!)?.pageCount, 1, '只保留真正的页图');
});

test('普通漫画（单层 .cbz）不受影响', async () => {
  const source = writeSource('plain.cbz', buildCbz(['p1.png', 'p2.png']));
  const store = freshStore();
  const outcomes = await importPath(source, store);

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.ok, true, `导入失败：${outcomes[0]!.error}`);
  assert.equal(store.get(outcomes[0]!.bookId!)?.pageCount, 2);
});

// ---------------------------------------------------------------------------
// 原生分支（Rust sidecar）
// ---------------------------------------------------------------------------

test('套娃包走原生分支：扩展名 .rar、内容实为 zip → 同样拆成多本', async (t) => {
  if (!nativeAvailable) {
    t.skip('未构建 Rust sidecar，跳过（`npm run build:native`）');
    return;
  }

  // 关键在于扩展名落在 NATIVE_ONLY_EXTENSIONS 里，而 sidecar 按 magic 判定格式，
  // 所以这条路径与真实的「RAR 套 RAR」在代码上是同一条。
  const source = writeSource(
    'collection-native.rar',
    zipSync({
      'vol-01.cbz': buildPageZip(['01.png']),
      'vol-02.cbz': buildPageZip(['01.png', '02.png']),
    }),
  );

  const store = freshStore();
  const outcomes = await importPath(source, store);

  assert.equal(outcomes.length, 2, `应为两本，实际：${JSON.stringify(outcomes)}`);
  for (const outcome of outcomes) {
    assert.equal(outcome.ok, true, `分卷导入失败：${outcome.error}`);
  }
  assert.deepEqual(
    outcomes.map((o) => store.get(o.bookId!)?.pageCount).sort((a, b) => (a ?? 0) - (b ?? 0)),
    [1, 2],
  );
});

test('原生套娃：内层分卷里的页图真的落盘并可读', async (t) => {
  if (!nativeAvailable) {
    t.skip('未构建 Rust sidecar，跳过');
    return;
  }

  const source = writeSource(
    'collection-native-content.rar',
    zipSync({ 'vol-only.cbz': buildPageZip(['001.png', '002.png']) }),
  );
  const store = freshStore();
  const outcomes = await importPath(source, store);

  assert.equal(outcomes.length, 1);
  const book = store.get(outcomes[0]!.bookId!)!;
  assert.equal(book.pageCount, 2);
  const files = fs.readdirSync(bookContentDir(book.id)).filter((n) => n.endsWith('.png'));
  assert.equal(files.length, 2, `内容目录里应有 2 张页图，实际：${files.join('、')}`);
});

// ---------------------------------------------------------------------------
// 真实套娃包（opt-in）
// ---------------------------------------------------------------------------

/**
 * 用户实际拖进来的那个文件：`Kyou_wa_kanojo_ga_inaikara_01-02.rar`
 * ——一个 RAR4，里面装的是第 01、02 卷两个分卷 RAR。这是本文件所有合成的
 * 语料的来源，所以版本固定跑一次才有意义（合成夹具证明不了「RAR 里的日文
 * 文件名能被 Rust 与 JS 两侧对齐」这种事）。
 *
 * 代价：解包要写约 450 MB 到临时目录，所以**默认不跑**。
 * 用法：`ARALE_TEST_COLLECTION_RAR=/abs/path.rar ARALE_RAR_TEST=1 node --test dist-test/tests/import-collection.test.js`
 */
test('真实套娃 RAR：两个分卷各成一本书，页图落盘', async (t) => {
  const real = process.env['ARALE_TEST_COLLECTION_RAR'];
  if (!real || !fs.existsSync(real)) {
    t.skip('未设置 ARALE_TEST_COLLECTION_RAR，跳过真实套娃包测试');
    return;
  }
  if (!nativeAvailable) {
    t.skip('未构建 Rust sidecar，跳过');
    return;
  }

  const store = freshStore();
  const outcomes = await importPath(real, store);

  assert.equal(outcomes.length, 2, `应为两本，实际：${JSON.stringify(outcomes)}`);
  for (const outcome of outcomes) {
    assert.equal(outcome.ok, true, `分卷导入失败：${outcome.error}`);
  }

  const books = outcomes.map((outcome) => store.get(outcome.bookId!)!);
  const titles = books.map((book) => book.title).sort();
  assert.ok(
    titles.some((title) => title.includes('第01巻')) && titles.some((title) => title.includes('第02巻')),
    `两卷标题应能分辨，实际：${titles.join('、')}`,
  );

  for (const book of books) {
    // 真实单行本每卷上百页；低于 50 页说明页图在解包时被丢了一批。
    assert.ok(book.pageCount > 50, `${book.title} 只有 ${book.pageCount} 页，页图疑似丢失`);
    assert.ok(book.pages && book.pages.length === book.pageCount);
    const first = book.pages![0]!;
    const abs = path.join(bookContentDir(book.id), ...first.url.split('/'));
    assert.ok(fs.existsSync(abs), `首页应落盘：${first.url}`);
    assert.ok(fs.statSync(abs).size > 10_000, '首页像是占位文件，不是真实漫画页');
  }
});
