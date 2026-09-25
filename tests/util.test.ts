/**
 * 核心工具层单测。
 *
 * 这一层的每个函数都直接决定「用户的页序 / 书名排序 / 文件落盘位置」是否正确，
 * 而且都是纯函数——所以覆盖率值得做满。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { naturalCompare } from '../src/core/util/natural-sort';
import { makeSortKey, parseVolume } from '../src/core/util/sort-key';
import { joinRel, normalizeRel, sanitizeFileName, sanitizeRelSegments, uniqueRel } from '../src/core/util/paths';
import { readJson, writeFileAtomic, writeJsonAtomic } from '../src/core/util/atomic-json';
import { probeOrientedImageSize } from '../src/core/comic/image-size';

// ---------------------------------------------------------------------------
// natural-sort
// ---------------------------------------------------------------------------

test('naturalCompare: 数字段按数值比，不是字典序', () => {
  const input = ['p10.jpg', 'p2.jpg', 'p1.jpg'];
  const sorted = input.slice().sort(naturalCompare);
  assert.deepEqual(sorted, ['p1.jpg', 'p2.jpg', 'p10.jpg']);
});

test('naturalCompare: 数值相等时位数少的在前（全序，不相等）', () => {
  // Fushi 的 tie-break：数值相同（001 vs 1）时**位数少的在前**。
  assert.ok(naturalCompare('p1.jpg', 'p001.jpg') < 0);
  assert.ok(naturalCompare('p001.jpg', 'p1.jpg') > 0);
  // 关键性质：不允许返回 0（否则页序不确定）。
  assert.notEqual(naturalCompare('001.jpg', '1.jpg'), 0);
});

test('naturalCompare: 前缀在前的排前面', () => {
  assert.ok(naturalCompare('ch1', 'ch1-2') < 0);
});

test('naturalCompare: 大小写不敏感', () => {
  assert.equal(naturalCompare('Page.JPG', 'page.jpg'), 0);
});

test('naturalCompare: 多段数字（卷/页）按段比较', () => {
  const input = ['v10/p1.jpg', 'v2/p10.jpg', 'v2/p2.jpg'];
  const sorted = input.slice().sort(naturalCompare);
  assert.deepEqual(sorted, ['v2/p2.jpg', 'v2/p10.jpg', 'v10/p1.jpg']);
});

// ---------------------------------------------------------------------------
// sort-key / volume
// ---------------------------------------------------------------------------

test('makeSortKey: 小写化、剥标点、折叠空白', () => {
  assert.equal(makeSortKey('  The   Great Book! '), 'great book');
  assert.equal(makeSortKey('吾輩は猫である'), '吾輩は猫である');
});

test('makeSortKey: 剥掉开头的冠词', () => {
  assert.equal(makeSortKey('A Silent Voice'), 'silent voice');
  assert.equal(makeSortKey('The  """'), 'the');
});

test('makeSortKey: 标点不产生前导空格', () => {
  assert.equal(makeSortKey('【特装版】よつばと'), '特装版 よつばと');
});

test('parseVolume: 各种卷号写法', () => {
  assert.equal(parseVolume('よつばと 第3巻'), 3);
  assert.equal(parseVolume('Yotsuba&! Vol. 12'), 12);
  assert.equal(parseVolume('Berserk v03'), 3);
  assert.equal(parseVolume('進撃の巨人 (7)'), 7);
  assert.equal(parseVolume('無巻号'), null);
});

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

test('normalizeRel: 反斜杠转正斜杠并去前导斜杠', () => {
  assert.equal(normalizeRel('\\vol1\\p001.jpg'), 'vol1/p001.jpg');
  assert.equal(normalizeRel('/a/b/c.png'), 'a/b/c.png');
});

test('sanitizeRelSegments: 剥掉 . 与空段，保留子目录', () => {
  assert.deepEqual(sanitizeRelSegments('./a//b/./c.jpg'), ['a', 'b', 'c.jpg']);
  assert.deepEqual(sanitizeRelSegments('C:\\卷1\\p1.jpg'), ['C_', '卷1', 'p1.jpg']);
});

test('sanitizeRelSegments: 含 .. 返回 null（zip-slip 防线）', () => {
  assert.equal(sanitizeRelSegments('../../etc/passwd'), null);
  assert.equal(sanitizeRelSegments('a/../../b'), null);
  // `..hidden` 不是 `..`，应当被允许（不能过度拦截合法的点开头文件名）。
  assert.deepEqual(sanitizeRelSegments('a/..hidden/b'), ['a', '..hidden', 'b']);
});

test('uniqueRel: 重名时加 (2) (3)，保留扩展名与子目录', () => {
  const used = new Set<string>();
  assert.equal(uniqueRel('a/b.jpg', used), 'a/b.jpg');
  assert.equal(uniqueRel('a/b.jpg', used), 'a/b (2).jpg');
  assert.equal(uniqueRel('a/b.jpg', used), 'a/b (3).jpg');
  assert.equal(uniqueRel('c', used), 'c');
  assert.equal(uniqueRel('c', used), 'c (2)');
});

test('joinRel / sanitizeFileName', () => {
  assert.equal(joinRel(['a', 'b', 'c.jpg']), 'a/b/c.jpg');
  assert.equal(sanitizeFileName('a/b:c*d?.epub'), 'a_b_c_d_.epub');
  assert.equal(sanitizeFileName('   '), 'untitled');
  assert.equal(sanitizeFileName('...'), 'untitled');
});

// ---------------------------------------------------------------------------
// atomic-json
// ---------------------------------------------------------------------------

test('writeJsonAtomic + readJson 往返', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aralebook-'));
  const file = path.join(dir, 'nested', 'index.json');
  writeJsonAtomic(file, { hello: '世界', n: 3 });
  assert.deepEqual(readJson(file, null), { hello: '世界', n: 3 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJson: 缺失文件返回 fallback', () => {
  assert.deepEqual(readJson('/definitely/not/here.json', { a: 1 }), { a: 1 });
});

test('readJson: 损坏文件返回 fallback 并把坏文件另存', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aralebook-'));
  const file = path.join(dir, 'index.json');
  fs.writeFileSync(file, '{ this is not json');
  assert.deepEqual(readJson(file, { ok: false }), { ok: false });
  assert.equal(fs.existsSync(file), false, '坏文件应被移走');
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.corrupt-'));
  assert.equal(leftovers.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomic: 覆盖旧内容且不留 .tmp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aralebook-'));
  const file = path.join(dir, 'a.txt');
  writeFileAtomic(file, 'one');
  writeFileAtomic(file, 'two');
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  assert.deepEqual(fs.readdirSync(dir), ['a.txt']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// image-size
// ---------------------------------------------------------------------------

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

test('probeOrientedImageSize: PNG 头', () => {
  assert.deepEqual(probeOrientedImageSize(pngHeader(1200, 1800)), { width: 1200, height: 1800 });
});

test('probeOrientedImageSize: GIF 头', () => {
  const bytes = new Uint8Array(16);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  bytes[6] = 0x20;
  bytes[7] = 0x03; // 800 LE
  bytes[8] = 0x58;
  bytes[9] = 0x02; // 600 LE
  assert.deepEqual(probeOrientedImageSize(bytes), { width: 800, height: 600 });
});

test('probeOrientedImageSize: BMP 头（含负高度 = top-down）', () => {
  const bytes = new Uint8Array(30);
  bytes.set([0x42, 0x4d], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(18, 640, true);
  view.setUint32(22, 0xfffffd80, true); // -640
  assert.deepEqual(probeOrientedImageSize(bytes), { width: 640, height: 640 });
});

test('probeOrientedImageSize: 认不出的格式返回 null（调用方据此退回解码）', () => {
  assert.equal(probeOrientedImageSize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), null);
  assert.equal(probeOrientedImageSize(new Uint8Array(0)), null);
});

test('probeOrientedImageSize: JPEG SOF0 + 无 EXIF', () => {
  // SOI + SOF0(len=17, prec=8, h=1800, w=1200, comps=3) + EOI
  const bytes = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x07, 0x08, 0x04, 0xb0, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
  assert.deepEqual(probeOrientedImageSize(bytes), { width: 1200, height: 1800 });
});
