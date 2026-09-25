/**
 * 漫画页枚举 + mokuro 文字层测试。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MokuroParseError,
  emptyPageText,
  pageTextFor,
  parseMangaJson,
  parseMokuro,
  parseMokuroTopLevel,
  serializeMangaJson,
  type MokuroPage,
} from '../src/core/comic/mokuro';
import {
  COMIC_IMAGE_EXTENSIONS,
  MOKURO_OUT_DIR,
  collectArchivePages,
  isComicImage,
  sortPagePaths,
} from '../src/core/comic/pages';
import { openZip } from '../src/core/epub/zip-reader';
import { naturalCompare } from '../src/core/util/natural-sort';
import { buildCbz } from './fixtures';

test('COMIC_IMAGE_EXTENSIONS 是与导入/OCR 共用的同一张表', () => {
  assert.deepEqual([...COMIC_IMAGE_EXTENSIONS], ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
  assert.equal(MOKURO_OUT_DIR, 'manga_ocr_out');
  assert.equal(isComicImage('a/b.JPG'), true);
  assert.equal(isComicImage('a/b.bmp'), true);
  assert.equal(isComicImage('a/b.txt'), false);
  assert.equal(isComicImage('a/b.jpg.txt'), false);
});

test('sortPagePaths：自然序，p2 在 p10 之前', () => {
  assert.deepEqual(sortPagePaths(['p10.jpg', 'p2.jpg', 'p1.jpg']), ['p1.jpg', 'p2.jpg', 'p10.jpg']);
  assert.deepEqual(sortPagePaths(['vol/2.jpg', 'vol/10.jpg', 'vol/1.jpg']), [
    'vol/1.jpg',
    'vol/2.jpg',
    'vol/10.jpg',
  ]);
  // 零填充与不填充数值相等时的 tie-break：冻结的 naturalCompare 明确规定
  // 「位数少的在前」（natural-sort.ts 的注释、Fushi manga_ocr_folder_job.dart:71-93）。
  // 任务书里写的 `p001.jpg before p1.jpg` 与该冻结比较器相反，这里以 util 为准。
  assert.deepEqual(sortPagePaths(['p1.jpg', 'p001.jpg']), ['p1.jpg', 'p001.jpg']);
  assert.ok(naturalCompare('p1.jpg', 'p001.jpg') < 0);
  // 输入不被就地修改。
  const input = ['p2.jpg', 'p1.jpg'];
  sortPagePaths(input);
  assert.deepEqual(input, ['p2.jpg', 'p1.jpg']);
});

test('collectArchivePages：丢 __MACOSX / ._ / 非图片 / OCR 产物目录，保留嵌套图片', () => {
  const names = [
    '__MACOSX/._p1.jpg',
    'images/p10.jpg',
    'images/p2.jpg',
    'images/p1.jpg',
    'notes.txt',
    'manga_ocr_out/manga.json',
    'manga_ocr_out/_pages/p1.jpg',
    'nested/manga_ocr_out/p1.jpg',
    'images/._junk.jpg',
    'manga.json',
    'images/',
  ];
  assert.deepEqual(collectArchivePages(names), ['images/p1.jpg', 'images/p2.jpg', 'images/p10.jpg']);

  // 与真实 zip 成员名走一遍（openZip 已剥掉 macOS 垃圾与目录项）。
  const archive = buildCbz(['p10.jpg', '__MACOSX/._p1.jpg', 'p2.jpg', 'notes.txt', 'p1.jpg', 'cover/']);
  assert.deepEqual(
    collectArchivePages(openZip(archive).map((entry) => entry.name)),
    ['p1.jpg', 'p2.jpg', 'p10.jpg'],
  );
});

test('parseMokuro：2 页文档，box 归一化 / vertical 缺省 / font_size 兜底 / 反斜杠路径', () => {
  const doc = JSON.stringify({
    title: 'テスト巻',
    volume: '1',
    pages: [
      {
        img_path: 'vol1\\p001.jpg',
        img_width: 1200,
        img_height: 1800,
        blocks: [
          { box: [100, 200, 50, 600], vertical: true, font_size: 24, lines: ['あ', 'い'] },
          { box: [10, 20, 30, 40], vertical: false, font_size: 0, lines: ['x', 'y'] },
          { box: [0, 0, 100, 50], lines: [] },
          {
            box: [5, 5, 25, 25],
            font_size: 12,
            lines: ['r'],
            regions: [
              { box: [5, 5, 15, 25], utf16_start: 0, utf16_end: 1 },
              { box: [15, 5, 25, 25], utf16Start: 1, utf16End: 2 },
              { box: [0, 0, 1, 1], utf16_start: 5, utf16_end: 2 },
            ],
          },
        ],
      },
      { img_path: 'vol1/p002.jpg', img_width: 1200, img_height: 1800, blocks: [] },
    ],
  });

  const pages = parseMokuro(doc) as MokuroPage[];
  assert.equal(pages.length, 2);
  assert.equal(pages[0]?.url, 'vol1/p001.jpg', 'img_path 的反斜杠要归一成正斜杠');
  assert.equal(pages[0]?.width, 1200);
  assert.equal(pages[0]?.height, 1800);
  assert.equal(pages[1]?.url, 'vol1/p002.jpg');

  const blocks = pages[0]?.blocks ?? [];
  assert.equal(blocks.length, 4);
  assert.deepEqual(blocks[0]?.box, [50, 200, 100, 600], 'box 要归一化成 min/max');
  assert.equal(blocks[0]?.vertical, true);
  assert.equal(blocks[0]?.fontSize, 24);
  assert.deepEqual(blocks[0]?.lines, ['あ', 'い']);

  assert.equal(blocks[1]?.vertical, false);
  assert.equal(blocks[1]?.fontSize, 10, 'font_size=0 时按 块高/行数 兜底');

  assert.equal(blocks[2]?.vertical, true, 'vertical 缺省按日漫竖排');
  assert.deepEqual(blocks[2]?.lines, []);
  assert.equal(blocks[2]?.fontSize, 50, '无 lines 时除数取 max(1, 0)');
  assert.equal(blocks[2]?.regions, undefined);

  assert.equal(blocks[3]?.regions?.length, 2, 'camelCase utf16Start 要接受，非法区间要丢');
  assert.deepEqual(blocks[3]?.regions?.[0], { box: [5, 5, 15, 25], utf16Start: 0, utf16End: 1 });
  assert.equal(blocks[3]?.regions?.[1]?.utf16Start, 1);

  assert.deepEqual(parseMokuroTopLevel(doc), { title: 'テスト巻', volume: '1' });
});

test('parseMangaJson / serializeMangaJson：round-trip 深度相等且逐字节稳定', () => {
  const source = JSON.stringify({
    version: 1,
    ocr: { engine: 'local_onnx', engine_signature: 'sig', schema_version: 1 },
    pages: [
      {
        url: 'images\\p1.jpg',
        width: 1000,
        height: 1500,
        blocks: [
          { box: [1.5, 2.25, 30.125, 44], vertical: false, font_size: 12.5, lines: ['a', 'b'] },
          {
            box: [3, 4, 5, 6],
            vertical: true,
            font_size: 0,
            lines: ['漢'],
            z_index: 7,
            regions: [{ box: [3, 4, 5, 6], utf16_start: 0, utf16_end: 1 }],
            lines_coords: [[[1, 2], [3, 4]]],
          },
        ],
      },
    ],
  });

  const once = parseMangaJson(source);
  const firstJson = serializeMangaJson(once);
  const round = parseMangaJson(firstJson);
  assert.deepEqual(round, once);
  assert.equal(serializeMangaJson(round), firstJson, '序列化结果必须逐字节稳定');

  const withOcr = serializeMangaJson(once, { engine: 'e', engineSignature: 's', schemaVersion: 2 });
  assert.match(withOcr, /"engine_signature":"s"/);
  assert.match(withOcr, /"schema_version":2/);
  assert.ok(!firstJson.includes('z_index'), '冻结契约没有 zIndex，序列化不应写它');
  assert.ok(!firstJson.includes('lines_coords'), 'lines_coords 解析即丢弃');
});

test('single_line：本项目的「一个框一段文字」承诺要能落盘并读回', () => {
  // 关键：这个标记决定 `layoutOf` 走不走面积推断。写丢一次，重新读回来的文字层
  // 就又变成「猜排版」，划词偏移会以「明明修过了」的方式复现。
  const declared = parseMangaJson(
    JSON.stringify({
      pages: [
        {
          url: 'p1.jpg',
          width: 1441,
          height: 2048,
          blocks: [{ box: [10, 20, 50, 242], vertical: true, font_size: 32, lines: ['この中だったら'], single_line: true }],
        },
      ],
    }),
  );
  assert.equal(declared[0]?.blocks[0]?.singleLine, true, '解析要认 single_line');

  const json = serializeMangaJson(declared);
  assert.match(json, /"single_line":true/);
  assert.deepEqual(parseMangaJson(json), declared, 'round-trip 保持');

  // 老文件（没有这个键）不能被真值缺省悄悄打上标记：那样第三方 mokuro 的区域块
  // 会全部退化成「一段文字」，比原来更糟。
  const legacy = parseMangaJson(
    JSON.stringify({ pages: [{ url: 'p1.jpg', width: 100, height: 100, blocks: [{ box: [0, 0, 10, 10], lines: ['あ'] }] }] }),
  );
  assert.equal(legacy[0]?.blocks[0]?.singleLine, undefined);
  assert.ok(!serializeMangaJson(legacy).includes('single_line'), '没声明就不写');
});

test('畸形输入：语法错/顶层非对象抛 MokuroParseError，形状坏则尽量活下来', () => {
  assert.throws(() => parseMokuro('not json'), MokuroParseError);
  assert.throws(() => parseMokuro('[]'), MokuroParseError);
  assert.throws(() => parseMangaJson('42'), MokuroParseError);

  assert.deepEqual(parseMokuro('{}'), []);
  assert.deepEqual(parseMokuro('{"pages":"nope"}'), []);
  assert.deepEqual(parseMangaJson('{}'), []);

  const partial = parseMokuro('{"pages":[null,42,{"img_path":"a.jpg"}]}') as MokuroPage[];
  assert.equal(partial.length, 1);
  assert.equal(partial[0]?.url, 'a.jpg');
  assert.deepEqual(partial[0]?.blocks, []);

  assert.deepEqual(parseMokuroTopLevel('garbage'), { title: null, volume: null });
  assert.deepEqual(parseMokuroTopLevel('[]'), { title: null, volume: null });
});

test('emptyPageText / pageTextFor', () => {
  const page = emptyPageText('images\\p1.jpg', 100.123456, 200);
  assert.equal(page.url, 'images/p1.jpg');
  assert.equal(page.width, 100.1235);
  assert.equal(page.height, 200);
  assert.deepEqual(page.blocks, []);

  const pages = [page, emptyPageText('images/p2.jpg', 10, 10)];
  assert.equal(pageTextFor(pages, 'images/p1.jpg')?.url, 'images/p1.jpg');
  assert.equal(pageTextFor(pages, 'images\\p1.jpg')?.url, 'images/p1.jpg');
  assert.equal(pageTextFor(pages, 'images/p3.jpg'), null);
  assert.equal(pageTextFor([], 'images/p1.jpg'), null);
});
