/**
 * 导入管线**端到端**测试（不需要启动 Electron）。
 *
 * 走的是用户在界面上点「导入」时主进程真正执行的那条路：
 *   磁盘路径 → 载体判定 → 开包 → 解包/拷页 → 写 manga.json → 建 BookRecord → 落索引
 * 然后回过头用阅读器那侧的服务把内容取出来，确认「导进来的东西真的能读」。
 *
 * 为什么值得写：这一步串起了 core 层的解析器与 main 层的文件布局，任何一侧改了路径
 * 口径（比如 spine href 到底是相对 OPF 还是相对书目录根），单元测试都不会发现，
 * 只有这里会红。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { setUserDataRootForTesting, bookContentDir, bookDir } from '../src/main/paths';
import { LibraryStore, PositionStore, makeBaseRecord } from '../src/main/library/store';
import { detectImportKind, importPath } from '../src/main/library/importer';
import type { ImportOutcome } from '../src/shared/types';
import { getChapterContent, getPageText, invalidateContentCache } from '../src/main/reader/content';
import { buildCbz, buildEpub } from './fixtures';
import { mkdirSync, writeFileSync } from 'node:fs';

let root = '';
let sourceDir = '';

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-import-'));
  setUserDataRootForTesting(root);
  sourceDir = path.join(root, 'incoming');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(path.join(sourceDir, 'sample.epub'), buildEpub({ title: '导入测试小说' }));
  writeFileSync(path.join(sourceDir, 'sample.cbz'), buildCbz(['p1.png', 'p2.png', 'p10.png']));
  writeFileSync(path.join(sourceDir, 'broken.zip'), Buffer.from('not a zip at all'));
});

after(() => {
  setUserDataRootForTesting(null);
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * 单本导入的便捷包装：[importPath] 现在返回**数组**（套娃包会产出多本），
 * 而绝大多数用例只关心「一个路径 → 一本书」，所以在这里断言长度为 1 再取头一条。
 * 断言信息里带上每条 source，套娃场景出错时能直接看出多出来的是哪本。
 */
async function importOne(source: string, store: LibraryStore): Promise<ImportOutcome> {
  const outcomes = await importPath(source, store);
  assert.equal(
    outcomes.length,
    1,
    `期望恰好导入 1 本，实际 ${outcomes.length} 本：${outcomes.map((o) => o.source).join('、')}`,
  );
  return outcomes[0]!;
}

test('detectImportKind: 按扩展名/目录分流', () => {
  assert.equal(detectImportKind(path.join(sourceDir, 'sample.epub')), 'epub');
  assert.equal(detectImportKind(path.join(sourceDir, 'sample.cbz')), 'comic');
  // 目录一律按「纯页图漫画」处理。
  assert.equal(detectImportKind(sourceDir), 'directory');
  // .cbr 需要外部 7z，明确判成不支持而不是假装能开。
  assert.equal(detectImportKind(path.join(sourceDir, 'x.cbr')), 'unsupported');
  assert.equal(detectImportKind(path.join(sourceDir, 'x.mobi')), 'unsupported');
});

test('导入 EPUB：记录字段、磁盘布局、章节可读', async () => {
  const store = new LibraryStore();
  store.load();

  const outcome = await importOne(path.join(sourceDir, 'sample.epub'), store);
  assert.equal(outcome.ok, true, `导入失败：${outcome.error}`);
  assert.equal(outcome.format, 'epub');
  const bookId = outcome.bookId;
  assert.ok(bookId, '应返回新书 id');

  const book = store.get(bookId!);
  assert.ok(book, '索引里应能查到');
  assert.equal(book!.format, 'epub');
  assert.equal(book!.title, '导入测试小说');
  assert.ok(book!.spine && book!.spine.length > 0, 'spine 不应为空');
  assert.ok(book!.opfRel, 'opfRel 应被记下');

  // 磁盘布局：content/ 是解包后的 ZIP 根。
  const contentDir = bookContentDir(bookId!);
  assert.ok(fs.existsSync(contentDir), 'content/ 目录应存在');
  assert.ok(fs.existsSync(path.join(bookDir(bookId!), 'original.epub')), '原始文件应保留一份');
  const spineHref = book!.spine![0]!.href;
  assert.ok(
    fs.existsSync(path.join(contentDir, ...spineHref.split('/'))),
    `spine[0] 指向的文件应真实存在：${spineHref}`,
  );

  // 章节内容服务。
  const chapter = getChapterContent(book!, 0);
  assert.ok(chapter.url.startsWith(`arale://${bookId}/`), `URL 形状不对：${chapter.url}`);
  assert.ok(chapter.url.includes(spineHref));
  assert.ok(chapter.plainText.length > 0, '章节纯文本不应为空');

  // 越界的章节序号要被夹住而不是抛。
  assert.equal(getChapterContent(book!, 9999).spineIndex, book!.spine!.length - 1);
  assert.equal(getChapterContent(book!, -5).spineIndex, 0);
});

test('导入漫画：页序自然序、文字层落盘、坐标可读', async () => {
  const store = new LibraryStore();
  store.load();

  const outcome = await importOne(path.join(sourceDir, 'sample.cbz'), store);
  assert.equal(outcome.ok, true, `导入失败：${outcome.error}`);
  assert.equal(outcome.format, 'comic');
  const book = store.get(outcome.bookId!);
  assert.ok(book);
  assert.equal(book!.format, 'comic');
  assert.equal(book!.direction, 'rtl', '漫画默认右到左');
  assert.ok(book!.pages, 'pages 不应为空');

  // 自然序：p2 在 p10 之前。
  const names = book!.pages!.map((p) => p.url);
  assert.deepEqual(names, ['p1.png', 'p2.png', 'p10.png'], `页序不对：${JSON.stringify(names)}`);
  assert.equal(book!.pageCount, 3);
  assert.equal(book!.coverRel, 'p1.png', '封面取第一页');

  const contentDir = bookContentDir(book!.id);
  assert.ok(fs.existsSync(path.join(contentDir, 'p1.png')), '页图应落盘');
  assert.ok(fs.existsSync(path.join(contentDir, 'manga.json')), '文字层清单应落盘');

  // 文字层服务（带 mtime 缓存，先清一次保证读的是刚写的）。
  invalidateContentCache(book!.id);
  const page = getPageText(book!, 0);
  assert.equal(page.url, 'p1.png');

  // 越界页号夹住。
  assert.equal(getPageText(book!, 999).url, 'p10.png');
});

test('导入失败：坏 zip 报错且不留半成品目录', async () => {
  const store = new LibraryStore();
  store.load();
  const before = store.all().length;

  const outcome = await importOne(path.join(sourceDir, 'broken.zip'), store);
  assert.equal(outcome.ok, false);
  assert.ok(outcome.error, '应给出人可读的错误');
  assert.equal(store.all().length, before, '失败不应产生书目');

  // 也不应留下空的 bk_* 目录。
  const leftovers = fs
    .readdirSync(path.join(root, 'library'))
    .filter((name) => name.startsWith('bk_'));
  const live = new Set(store.all().map((b) => b.id));
  for (const name of leftovers) {
    assert.ok(live.has(name), `留下了孤儿目录：${name}`);
  }
});

test('导入不存在的路径：报错而不是抛异常到 IPC', async () => {
  const store = new LibraryStore();
  store.load();
  const outcome = await importOne(path.join(sourceDir, '没有这个文件.epub'), store);
  assert.equal(outcome.ok, false);
  assert.ok(outcome.error);
});

test('删除书：索引移除 + 目录删除 + 进度清除', async () => {
  const store = new LibraryStore();
  store.load();
  const positions = new PositionStore();

  const outcome = await importOne(path.join(sourceDir, 'sample.cbz'), store);
  const bookId = outcome.bookId!;
  const dir = bookDir(bookId);
  assert.ok(fs.existsSync(dir));

  positions.set({ bookId, pageIndex: 1, updatedAt: Date.now() });
  assert.equal(positions.get(bookId)?.pageIndex, 1);
  positions.remove(bookId);
  assert.equal(positions.get(bookId), null);

  store.remove(bookId);
  assert.equal(store.get(bookId), null);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dir), false);
});

test('索引损坏时能从每本书的 book.json 重建', async () => {
  const store = new LibraryStore();
  store.load();
  await importOne(path.join(sourceDir, 'sample.epub'), store);
  await importOne(path.join(sourceDir, 'sample.cbz'), store);
  const expected = store.all().length;
  assert.ok(expected >= 2);

  // 把 index.json 写坏，模拟崩溃/手工编辑。
  writeFileSync(path.join(root, 'library', 'index.json'), '{ broken');

  const rebuilt = new LibraryStore();
  rebuilt.load();
  assert.equal(rebuilt.all().length, expected, '应能从 book.json 重建出同样多的书');
  invalidateContentCache('');
});

test('分面：作者/系列/标签的**选项集合**不受当前筛选影响', () => {
  // 这是用户报的「选了一个作者，另一个就消失了」。
  // 原因：作者清单以前在渲染进程从「当前这一页」现算，选中一个作者之后筛选结果里
  // 只剩他的书，清单自然只剩他。分面的**选项集合**必须从整库算，只有计数才随筛选变。
  //
  // 刻意直接构造 BookRecord 而不走导入管线：这一条测的是分面契约，
  // 混进导入夹具（作者名固定、还会跨用例累积）只会让失败原因变模糊。
  const store = new LibraryStore();
  store.load();
  const before = store.info().bookCount;

  const mk = (title: string, author: string, series: string, tags: string[]) => {
    const id = `bk_facet_${title}`;
    const record = makeBaseRecord({
      id,
      format: 'comic',
      title,
      direction: 'rtl',
      dir: path.join(root, 'library', id),
    });
    record.author = author;
    record.series = series;
    record.tags = tags;
    store.add(record);
    return record;
  };
  mk('甲之书', '作者甲', '系列一', ['t1']);
  mk('乙之书', '作者乙', '系列二', ['t2']);

  // 说明：索引在同一个文件里跨用例累积，所以这里断言**包含**而不是全等。
  const unfiltered = store.query({});
  assert.equal(unfiltered.total, before + 2);
  assert.ok(unfiltered.allAuthors.includes('作者甲') && unfiltered.allAuthors.includes('作者乙'));
  assert.ok(unfiltered.allSeries.includes('系列一') && unfiltered.allSeries.includes('系列二'));

  // 按「作者甲」筛：结果少了，但**选项集合不变** —— 否则用户没法切到作者乙。
  const filtered = store.query({ search: '作者甲' });
  assert.ok(filtered.total < unfiltered.total, '筛选应该真的减少了结果');
  assert.ok(
    filtered.allAuthors.includes('作者甲') && filtered.allAuthors.includes('作者乙'),
    `筛选后作者清单不能塌成一个——那正是「另一个消失了」，实际：${JSON.stringify(filtered.allAuthors)}`,
  );
  assert.ok(filtered.allSeries.includes('系列一') && filtered.allSeries.includes('系列二'));
  assert.ok(filtered.allTags.includes('t1') && filtered.allTags.includes('t2'), '标签清单同理');
});
