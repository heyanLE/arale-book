import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  asciiRelativePath,
  migrateBookPagePathsToAscii,
  migrateLibraryPagePathsToAscii,
} from '../src/main/library/ascii-paths';
import { LibraryStore, makeBaseRecord } from '../src/main/library/store';
import { bookContentDir, bookDir, setUserDataRootForTesting } from '../src/main/paths';

let root = '';

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-ascii-paths-'));
  setUserDataRootForTesting(root);
});

after(() => {
  setUserDataRootForTesting(null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('日文路径转罗马音、中文路径转拼音，并保留扩展名', async () => {
  const japanese = await asciiRelativePath('今日はカノジョがいないから/第01巻/001.JPG', 'ja');
  assert.match(japanese, /kyo-wa-kanojo-ga-i-nai-kara/);
  assert.match(japanese, /dai-01-kan\/001\.jpg$/);
  assert.match(japanese, /^[\x20-\x7e]+$/);

  const chinese = await asciiRelativePath('中文测试/封面.PNG', 'zh');
  assert.equal(chinese, 'zhong-wen-ce-shi/feng-mian.png');
});

test('存量漫画迁移页图并同步 book/index/manga.json，重复执行幂等', async () => {
  const store = new LibraryStore();
  store.load();
  const id = 'bk_existing_cjk';
  const content = bookContentDir(id);
  const oldDir = '今日はカノジョがいないから 第01巻';
  fs.mkdirSync(path.join(content, oldDir), { recursive: true });
  fs.writeFileSync(path.join(content, oldDir, '001.jpg'), 'page-1');
  fs.writeFileSync(path.join(content, oldDir, '002.jpg'), 'page-2');

  const record = makeBaseRecord({
    id,
    format: 'comic',
    title: '今日はカノジョがいないから 第01巻',
    dir: bookDir(id),
  });
  record.pages = [
    { url: `${oldDir}/001.jpg`, width: 100, height: 200 },
    { url: `${oldDir}/002.jpg`, width: 100, height: 200 },
  ];
  record.pageCount = 2;
  record.coverRel = record.pages[0]!.url;
  store.add(record);
  fs.writeFileSync(path.join(content, 'manga.json'), JSON.stringify({
    ocr: { engine: 'old' },
    pages: record.pages.map((page, index) => ({
      ...page,
      blocks: index === 0 ? [{ lines: ['text'] }] : [],
    })),
  }));

  assert.equal(await migrateBookPagePathsToAscii(store, id), true);
  const migrated = store.get(id)!;
  assert.ok(migrated.pages?.every((page) => /^[\x20-\x7e]+$/.test(page.url)));
  assert.equal(migrated.coverRel, migrated.pages?.[0]?.url);
  for (const page of migrated.pages ?? []) {
    assert.equal(fs.existsSync(path.join(content, ...page.url.split('/'))), true);
  }
  assert.equal(fs.existsSync(path.join(content, oldDir)), false);

  const manga = JSON.parse(fs.readFileSync(path.join(content, 'manga.json'), 'utf8')) as {
    ocr: { engine: string };
    pages: Array<{ url: string; blocks: unknown[] }>;
  };
  assert.equal(manga.ocr.engine, 'old');
  assert.equal(manga.pages[0]!.url, migrated.pages?.[0]?.url);
  assert.equal(manga.pages[0]!.blocks.length, 1);

  assert.equal(await migrateBookPagePathsToAscii(store, id), false);
  await migrateLibraryPagePathsToAscii(store);
  assert.equal(store.get(id)?.pages?.[0]?.url, migrated.pages?.[0]?.url);
});
