/**
 * 「图片型小说」判据的单测。
 *
 * 这个判据决定一本 EPUB 会不会以**漫画方式**打开。判错的代价是双向的：
 * - 把纯文字书误判成图片书 → 打开是空白翻页，用户以为书坏了；
 * - 把图片书漏判 → 打开一片空白，点不出词典（就是没有这个功能时的老症状）。
 *
 * 所以三条边界都要钉死：正文长度阈值、图片的三类来源、以及非页图资源必须否决。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IMAGE_CHAPTER_MAX_TEXT_CHARS,
  contentSpineItems,
  extractImageRefs,
  isPageImage,
  judgeImageNovel,
  resolveResourceHref,
  scanChapter,
  type ChapterScan,
} from '../src/core/epub/image-novel';
import type { SpineItem } from '../src/shared/types';

// ---------------------------------------------------------------------------
// 引用解析
// ---------------------------------------------------------------------------

test('resolveResourceHref: 相对章节目录解析，并归一成书目录相对路径', () => {
  assert.equal(resolveResourceHref('OEBPS/text/ch1.xhtml', '../images/p1.jpg'), 'OEBPS/images/p1.jpg');
  assert.equal(resolveResourceHref('OEBPS/text/ch1.xhtml', 'p1.jpg'), 'OEBPS/text/p1.jpg');
  // 以 `/` 开头的是书目录绝对路径。
  assert.equal(resolveResourceHref('OEBPS/text/ch1.xhtml', '/images/p1.jpg'), 'images/p1.jpg');
});

test('resolveResourceHref: 去掉 fragment 与 query，percent-解码一次', () => {
  assert.equal(resolveResourceHref('a/ch.xhtml', '../i/p1.jpg#frag'), 'i/p1.jpg');
  assert.equal(resolveResourceHref('a/ch.xhtml', '../i/p1.jpg?v=2'), 'i/p1.jpg');
  assert.equal(resolveResourceHref('a/ch.xhtml', '../i/%E7%94%BB.jpg'), 'i/画.jpg');
  // 裸 `%` 不该让整本书的判定失败。
  assert.equal(resolveResourceHref('a/ch.xhtml', '../i/100%.jpg'), 'i/100%.jpg');
});

test('resolveResourceHref: 外链、data:、穿越出书目录一律返回 null', () => {
  assert.equal(resolveResourceHref('a/ch.xhtml', 'https://example.com/p.jpg'), null);
  assert.equal(resolveResourceHref('a/ch.xhtml', 'data:image/png;base64,AAAA'), null);
  assert.equal(resolveResourceHref('a/ch.xhtml', '../../outside.jpg'), null);
  assert.equal(resolveResourceHref('a/ch.xhtml', ''), null);
  assert.equal(resolveResourceHref('a/ch.xhtml', '#only-fragment'), null);
});

// ---------------------------------------------------------------------------
// 三类图片来源
// ---------------------------------------------------------------------------

test('extractImageRefs: <img> / SVG <image> / CSS background-image 三类都能抓到', () => {
  const xhtml = `
    <img src="p1.jpg" alt=""/>
    <img src='p2.jpg'/>
    <svg><image xlink:href="p3.jpg"/></svg>
    <svg><image href="p4.jpg"/></svg>
    <div style="background-image: url('p5.jpg')"></div>
    <style>.x { background: url(p6.jpg) no-repeat; }</style>
  `;
  const refs = extractImageRefs(xhtml);
  for (const expected of ['p1.jpg', 'p2.jpg', 'p3.jpg', 'p4.jpg', 'p5.jpg', 'p6.jpg']) {
    assert.ok(refs.includes(expected), `漏了 ${expected}，实际 ${JSON.stringify(refs)}`);
  }
});

test('isPageImage: 只看漫画页图那张白名单', () => {
  for (const ext of ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']) {
    assert.equal(isPageImage(`a/p${ext}`), true, ext);
  }
  // SVG 是矢量，不在页图白名单里 —— 顺带挡住「EPUB 里塞一个装饰 SVG 图标」。
  assert.equal(isPageImage('a/icon.svg'), false);
  assert.equal(isPageImage('a/font.woff2'), false);
});

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

function scan(images: string[], textLength: number, index = 0): ChapterScan {
  return { index, href: `OEBPS/text/ch${index}.xhtml`, images, textLength };
}

test('judgeImageNovel: 每章都是插图页 → 命中，页序 = 章序 × 章内序', () => {
  const verdict = judgeImageNovel([scan(['a/1.jpg'], 0, 0), scan(['a/2.jpg', 'a/3.jpg'], 3, 1)]);
  assert.equal(verdict.isImageNovel, true);
  assert.deepEqual(verdict.pages, ['a/1.jpg', 'a/2.jpg', 'a/3.jpg']);
  assert.equal(verdict.reason, '');
});

test('judgeImageNovel: 有一章是正文 → 不命中（阈值是护栏）', () => {
  const verdict = judgeImageNovel([
    scan(['a/1.jpg'], 0, 0),
    scan(['a/2.jpg'], IMAGE_CHAPTER_MAX_TEXT_CHARS + 1, 1),
  ]);
  assert.equal(verdict.isImageNovel, false);
  assert.ok(verdict.reason.includes('正文'), verdict.reason);
  assert.deepEqual(verdict.pages, []);
});

test('judgeImageNovel: 恰好等于阈值仍算插图页（边界包含）', () => {
  const verdict = judgeImageNovel([scan(['a/1.jpg'], IMAGE_CHAPTER_MAX_TEXT_CHARS)]);
  assert.equal(verdict.isImageNovel, true);
});

test('judgeImageNovel: 有章节没有图 → 不命中', () => {
  const verdict = judgeImageNovel([scan(['a/1.jpg'], 0, 0), scan([], 0, 1)]);
  assert.equal(verdict.isImageNovel, false);
  assert.ok(verdict.reason.includes('没有图片'), verdict.reason);
});

test('judgeImageNovel: 引用非页图资源（如 SVG 图标）→ 不命中', () => {
  // 这条挡的是「EPUB 里插图是 SVG」这类书：它们不是扫描件，用翻页阅读器没有意义。
  const verdict = judgeImageNovel([scan(['a/cover.svg'], 0)]);
  assert.equal(verdict.isImageNovel, false);
  assert.ok(verdict.reason.includes('非页图'), verdict.reason);
});

test('judgeImageNovel: 没有章节 / 没有页图 → 不命中且不抛', () => {
  assert.equal(judgeImageNovel([]).isImageNovel, false);
  assert.equal(judgeImageNovel([scan([], 0)]).isImageNovel, false);
});

test('judgeImageNovel: 重复引用的同一张图只算一页', () => {
  const verdict = judgeImageNovel([scan(['a/1.jpg', 'a/1.jpg'], 0, 0), scan(['a/1.jpg'], 2, 1)]);
  assert.equal(verdict.isImageNovel, true);
  assert.deepEqual(verdict.pages, ['a/1.jpg']);
});

// ---------------------------------------------------------------------------
// scanChapter / contentSpineItems
// ---------------------------------------------------------------------------

test('scanChapter: 相对章节解析图片，并按空白折叠后计文本长度', () => {
  const result = scanChapter(
    2,
    'OEBPS/text/ch2.xhtml',
    '<body><img src="../images/p1.jpg"/><p>  図\n 注  </p></body>',
    // 生产传的是 parser.ts 的 extractText；这里用一个最小的假实现，保持纯函数可测。
    (xhtml) => xhtml.replace(/<[^>]*>/g, ''),
  );
  assert.deepEqual(result.images, ['OEBPS/images/p1.jpg']);
  assert.equal(result.textLength, '  図\n 注  '.replace(/\s+/g, ' ').trim().length);
});

test('contentSpineItems: 只留 linear 且非 nav 的章节', () => {
  const spine: SpineItem[] = [
    { id: 'a', href: 'OEBPS/text/ch1.xhtml', mediaType: 'application/xhtml+xml', linear: true },
    { id: 'nav', href: 'OEBPS/nav.xhtml', mediaType: 'application/xhtml+xml', linear: true },
    { id: 'b', href: 'OEBPS/text/ch2.xhtml', mediaType: 'application/xhtml+xml', linear: false },
    { id: 'c', href: 'OEBPS/text/ch3.xhtml', mediaType: 'application/xhtml+xml', linear: true },
  ];
  assert.deepEqual(
    contentSpineItems(spine).map((item) => item.id),
    ['a', 'c'],
  );
});
