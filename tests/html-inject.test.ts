/**
 * 章节 HTML 净化与注入的测试。
 *
 * 这段代码有**两个**都不能出错的职责：
 * 1. 安全 —— 剥掉 EPUB 里的脚本、事件属性、`javascript:` URL、`<base>` 劫持；
 * 2. 排版 —— **保留书的 CSS**。曾经这里把 `<body>` 抠出来重新包一层骨架，结果书的
 *    `<link rel="stylesheet">` 全丢，EPUB 立刻「能读但全乱」。下面的测试把这两件事
 *    都钉死。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChapterDocument,
  CHAPTER_CSP,
  mimeFor,
  sanitizeChapterHtml,
} from '../src/main/reader/html-inject';

const OPTS = { bridgeSource: 'window.__bridge = 1;' };

// ---------------------------------------------------------------------------
// 净化
// ---------------------------------------------------------------------------

test('sanitize: 删掉成对的 <script>', () => {
  const out = sanitizeChapterHtml('<p>a</p><script>alert(1)</script><p>b</p>');
  assert.equal(out.includes('script'), false);
  assert.ok(out.includes('<p>a</p>'));
  assert.ok(out.includes('<p>b</p>'));
});

test('sanitize: 删掉带属性的、自闭合的、大写混写的 script', () => {
  for (const input of [
    '<script type="text/javascript">x()</script>',
    '<SCRIPT SRC="evil.js"></SCRIPT>',
    '<script src="evil.js"/>',
  ]) {
    assert.equal(/script/i.test(sanitizeChapterHtml(input)), false, `漏掉了：${input}`);
  }
});

test('sanitize: 删掉 iframe/object/embed/applet', () => {
  const out = sanitizeChapterHtml('<iframe src="x"></iframe><object data="y"></object><embed src="z"><applet code="a"></applet>');
  for (const tag of ['iframe', 'object', 'embed', 'applet']) {
    assert.equal(out.includes(tag), false, `${tag} 没被删掉`);
  }
});

test('sanitize: 删掉 <base> —— 否则书的相对资源会被劫持到外网', () => {
  const out = sanitizeChapterHtml('<head><base href="http://evil.example/"></head>');
  assert.equal(/<base/i.test(out), false);
});

test('sanitize: 删掉 on* 事件属性（引号三种写法都要覆盖）', () => {
  const out = sanitizeChapterHtml(
    '<img src="a.png" onerror="alert(1)"><div onload=\'x()\' ONCLICK=boom>b</div>',
  );
  assert.equal(/\son[a-z]+\s*=/i.test(out), false, `残留事件属性：${out}`);
  assert.ok(out.includes('src="a.png"'), '正常属性不能被误删');
});

test('sanitize: 废掉 javascript: 与 vbscript: URL', () => {
  const out = sanitizeChapterHtml('<a href="javascript:alert(1)">x</a><a href=\'vbscript:y\'>z</a>');
  assert.equal(/javascript\s*:/i.test(out), false);
  assert.equal(/vbscript\s*:/i.test(out), false);
});

// ---------------------------------------------------------------------------
// 注入
// ---------------------------------------------------------------------------

const CHAPTER = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>第一章</title>
  <meta charset="shift_jis">
  <meta name="viewport" content="width=800">
  <link rel="stylesheet" type="text/css" href="../styles/book.css">
  <style>p { text-indent: 1em; }</style>
</head>
<body>
  <p>吾輩は猫である。</p>
  <script>stealEverything()</script>
</body>
</html>`;

test('build: 保留书的 <link rel=stylesheet>（丢了这个 EPUB 就全乱）', () => {
  const out = buildChapterDocument(CHAPTER, OPTS);
  assert.ok(out.includes('href="../styles/book.css"'), '书的 CSS 链接必须保留');
  assert.ok(out.includes('text-indent: 1em'), '书的内联 <style> 必须保留');
});

test('build: 统一 charset 成 utf-8，删掉原有的旧声明', () => {
  const out = buildChapterDocument(CHAPTER, OPTS);
  assert.equal(/shift_jis/i.test(out), false, '旧的 charset 声明必须删掉');
  assert.ok(out.includes('<meta charset="utf-8">'));
  // charset 必须紧跟 <head>，否则前 1024 字节规则会忽略它。
  const headIndex = out.search(/<head\b[^>]*>/i);
  const metaIndex = out.indexOf('<meta charset="utf-8">');
  assert.ok(metaIndex > headIndex && metaIndex - headIndex < 64, 'charset 必须紧跟在 <head> 之后');
});

test('build: 阅读样式插在 </head> 之前（同优先级下后手胜出）', () => {
  const out = buildChapterDocument(CHAPTER, OPTS);
  const readerStyle = out.indexOf('--arale-font-scale');
  const closeHead = out.search(/<\/head\s*>/i);
  const bookStyle = out.indexOf('text-indent: 1em');
  assert.ok(readerStyle > 0, '阅读样式必须被注入');
  assert.ok(readerStyle < closeHead, '阅读样式要在 </head> 之前');
  assert.ok(readerStyle > bookStyle, '阅读样式要排在书的样式之后');
});

test('build: 桥接脚本插在 </body> 之前', () => {
  const out = buildChapterDocument(CHAPTER, OPTS);
  const scriptIndex = out.indexOf('window.__bridge = 1;');
  const closeBody = out.search(/<\/body\s*>/i);
  assert.ok(scriptIndex > 0);
  assert.ok(scriptIndex < closeBody);
});

test('build: 书里的脚本被剥掉，只有我们的桥接脚本留下', () => {
  const out = buildChapterDocument(CHAPTER, OPTS);
  assert.equal(out.includes('stealEverything'), false);
  assert.equal((out.match(/<script/gi) ?? []).length, 1, '应当只剩注入的那一个 script');
});

test('build: 删掉 EPUB 的 viewport（桌面端不需要，且会锁死缩放）', () => {
  const out = buildChapterDocument(CHAPTER, OPTS);
  assert.equal(/name="viewport"/i.test(out), false);
});

test('build: 没有 <head> 的文档也能注入', () => {
  const out = buildChapterDocument('<html><body><p>hi</p></body></html>', OPTS);
  assert.ok(out.includes('<meta charset="utf-8">'));
  assert.ok(out.includes('--arale-font-scale'));
  assert.ok(out.includes('window.__bridge = 1;'));
  assert.ok(out.includes('<p>hi</p>'));
});

test('build: 连 <html> 都没有的碎片也能注入', () => {
  const out = buildChapterDocument('<p>bare fragment</p>', OPTS);
  assert.ok(out.includes('bare fragment'));
  assert.ok(out.includes('<meta charset="utf-8">'));
  assert.ok(out.includes('window.__bridge = 1;'));
});

test('build: bodyOnly 只返回正文，不注入任何东西', () => {
  const out = buildChapterDocument(CHAPTER, { ...OPTS, bodyOnly: true });
  assert.ok(out.includes('吾輩は猫である'));
  assert.equal(out.includes('--arale-font-scale'), false);
  assert.equal(out.includes('window.__bridge'), false);
});

test('build: css:false / bridge:false 可以分别关掉注入', () => {
  const noCss = buildChapterDocument(CHAPTER, { ...OPTS, css: false });
  assert.equal(noCss.includes('--arale-font-scale'), false);
  assert.ok(noCss.includes('window.__bridge'));

  const noBridge = buildChapterDocument(CHAPTER, { ...OPTS, bridge: false });
  assert.ok(noBridge.includes('--arale-font-scale'));
  assert.equal(noBridge.includes('window.__bridge'), false);
});

// ---------------------------------------------------------------------------
// 其它
// ---------------------------------------------------------------------------

test('CSP: 禁掉 connect-src / frame-src / object-src', () => {
  assert.ok(CHAPTER_CSP.includes("connect-src 'none'"));
  assert.ok(CHAPTER_CSP.includes("frame-src 'none'"));
  assert.ok(CHAPTER_CSP.includes("object-src 'none'"));
  assert.ok(CHAPTER_CSP.includes("base-uri 'none'"));
});

test('mimeFor: 已知与未知扩展名', () => {
  assert.ok(mimeFor('/a/b.xhtml').startsWith('text/html'));
  assert.equal(mimeFor('a.PNG'), 'image/png');
  assert.equal(mimeFor('a.woff2'), 'font/woff2');
  assert.equal(mimeFor('noext'), 'application/octet-stream');
  // `.js` 刻意不给可执行 MIME（书里的脚本已被剥掉，真请求到也不该被当脚本执行）。
  assert.equal(mimeFor('a.js'), 'application/octet-stream');
});
