/**
 * EPUB 解析测试。全部输入都在内存里由 `tests/fixtures.ts` 现造。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EpubParseError, extractText, parseEpub, readSpineXhtml } from '../src/core/epub/parser';
import { makeZip, openZip, type ZipEntry } from '../src/core/epub/zip-reader';
import { buildEpub, buildEpubEntries } from './fixtures';

function entriesOf(bytes: Uint8Array): ZipEntry[] {
  return openZip(bytes);
}

test('解析最小 EPUB：元数据 + spine href 解析为相对 ZIP 根', () => {
  const entries = entriesOf(buildEpub());
  const parsed = parseEpub(entries);

  assert.equal(parsed.title, 'Test Book');
  assert.equal(parsed.author, 'Author One, Author Two');
  assert.equal(parsed.language, 'ja');
  assert.equal(parsed.publisher, 'Test Publisher');
  assert.equal(parsed.description, 'A plain description');
  assert.equal(parsed.opfRel, 'OEBPS/content.opf');
  assert.equal(parsed.direction, 'ltr');
  assert.equal(parsed.coverRel, null);

  // OPF 在 OEBPS/，章节在 OEBPS/text/ —— 这是本轮要真正压到的解析逻辑。
  assert.deepEqual(
    parsed.spine.map((item) => item.href),
    ['OEBPS/text/ch1.xhtml', 'OEBPS/text/ch2.xhtml'],
  );
  assert.equal(parsed.spine[0]?.id, 'ch1');
  assert.equal(parsed.spine[0]?.mediaType, 'application/xhtml+xml');
  assert.equal(parsed.spine[0]?.linear, true);
  assert.equal(parsed.spine[1]?.linear, false, 'linear="no" 要落成 false');

  const first = parsed.spine[0];
  assert.ok(first);
  assert.match(readSpineXhtml(entries, first), /こんにちは/);
  assert.equal(extractText(readSpineXhtml(entries, first)), 'こんにちは\n第一章');
});

test('page-progression-direction="rtl" → direction rtl', () => {
  const parsed = parseEpub(entriesOf(buildEpub({ rtl: true })));
  assert.equal(parsed.direction, 'rtl');
  assert.equal(parseEpub(entriesOf(buildEpub())).direction, 'ltr');
});

test('EPUB3 nav.xhtml 目录：href 解析到 ZIP 根且剥掉 fragment', () => {
  const parsed = parseEpub(entriesOf(buildEpub({ withNav: true })));
  assert.deepEqual(parsed.toc, [
    { label: 'Chapter <1> & Intro', href: 'OEBPS/text/ch1.xhtml', depth: 0 },
    { label: 'Chapter 2', href: 'OEBPS/text/ch2.xhtml', depth: 0 },
    { label: 'Section 2.1', href: 'OEBPS/text/ch2.xhtml', depth: 1 },
  ]);
  for (const item of parsed.toc) assert.ok(!item.href.includes('#'), 'fragment 必须剥掉');
});

test('没有 nav 时回落到 NCX，嵌套 navPoint 变成 depth', () => {
  const parsed = parseEpub(entriesOf(buildEpub({ withNav: false, withNcx: true })));
  assert.deepEqual(parsed.toc, [
    { label: 'NCX One', href: 'OEBPS/text/ch1.xhtml', depth: 0 },
    { label: 'NCX Two', href: 'OEBPS/text/ch2.xhtml', depth: 0 },
    { label: 'NCX Two A', href: 'OEBPS/text/ch2.xhtml', depth: 1 },
  ]);
});

test('nav 与 NCX 都没有 → toc 为空数组，不抛错', () => {
  const parsed = parseEpub(entriesOf(buildEpub({ withNav: false, withNcx: false })));
  assert.deepEqual(parsed.toc, []);
});

test('带 opf: 命名空间前缀的 manifest 仍能解析（Calibre 写法）', () => {
  const parsed = parseEpub(entriesOf(buildEpub({ nsPrefix: true })));
  assert.equal(parsed.spine.length, 2);
  assert.deepEqual(
    parsed.spine.map((item) => item.href),
    ['OEBPS/text/ch1.xhtml', 'OEBPS/text/ch2.xhtml'],
  );
  assert.equal(parsed.title, 'Test Book');
});

test('manifest 只有一个 item（对象而非数组）仍能解析', () => {
  const parsed = parseEpub(
    entriesOf(buildEpub({ chapterCount: 1, withNav: false, withNcx: false, coverMode: 'none' })),
  );
  assert.deepEqual(
    parsed.spine.map((item) => item.href),
    ['OEBPS/text/ch1.xhtml'],
  );
});

test('extractText：剥标签、解实体、块边界换行、日文 UTF-16 偏移不变', () => {
  const xhtml = `<html><head><title>T</title><style>p{color:red}</style></head><body>
<script>var x = 1;</script>
<h1>見出し</h1>
<p>こんにちは</p>
<div>one &amp; two</div>
<p>num &#12371;&#x3068; &quot;q&quot; &apos;a&apos; &lt;tag&gt;</p>
<br/>
<p>last</p>
</body></html>`;
  assert.equal(
    extractText(xhtml),
    '見出し\nこんにちは\none & two\nnum こと "q" \'a\' <tag>\nlast',
  );

  // 阅读位置靠 UTF-16 偏移，长度必须逐字符保持（含代理对按 2 个 code unit 计）。
  const japanese = '日本語のテキスト';
  assert.equal(extractText(`<p>${japanese}</p>`), japanese);
  assert.equal(extractText(`<p>${japanese}</p>`).length, japanese.length);
  const surrogate = '𠮷野家';
  assert.equal(extractText(`<p>${surrogate}</p>`).length, surrogate.length);

  // 转换必须确定：同一输入两次结果逐字节相同。
  assert.equal(extractText(xhtml), extractText(xhtml));
});

test('封面 tier 1：manifest properties="cover-image"（文件名不含 cover.）', () => {
  const parsed = parseEpub(entriesOf(buildEpub({ cover: true })));
  assert.equal(parsed.coverRel, 'OEBPS/images/the-cover-art.jpg');
});

test('封面 tier 2：<meta name="cover"> 指向的 manifest id', () => {
  const parsed = parseEpub(entriesOf(buildEpub({ coverMode: 'meta' })));
  assert.equal(parsed.coverRel, 'OEBPS/images/meta-cover.jpg');
});

test('封面 tier 3：文件名启发式 cover.jpg', () => {
  const parsed = parseEpub(entriesOf(buildEpub({ coverMode: 'filename' })));
  assert.equal(parsed.coverRel, 'OEBPS/images/cover.jpg');
});

test('缺 container.xml 但存在唯一 .opf → 仍能解析', () => {
  const entries = buildEpubEntries({ withNav: false });
  delete entries['META-INF/container.xml'];
  const parsed = parseEpub(entriesOf(makeZip(entries)));
  assert.equal(parsed.opfRel, 'OEBPS/content.opf');
  assert.equal(parsed.spine.length, 2);
});

test('完全没有 OPF → 抛 EpubParseError', () => {
  assert.throws(() => parseEpub(entriesOf(makeZip({ mimetype: 'application/epub+zip' }))), EpubParseError);
  assert.throws(() => parseEpub([]), EpubParseError);
});

test('readSpineXhtml：缺失条目返回空串，条目大小写不同也能命中', () => {
  const entries = entriesOf(buildEpub());
  assert.equal(
    readSpineXhtml(entries, {
      id: 'missing',
      href: 'OEBPS/text/nope.xhtml',
      mediaType: 'application/xhtml+xml',
      linear: true,
    }),
    '',
  );
  const lowercased = readSpineXhtml(entries, {
    id: 'ch1',
    href: 'oebps/text/ch1.xhtml',
    mediaType: 'application/xhtml+xml',
    linear: true,
  });
  assert.match(lowercased, /こんにちは/);
});
