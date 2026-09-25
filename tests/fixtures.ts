/**
 * 内存内构造 EPUB / CBZ 字节的测试夹具。全部在内存里 `makeZip`，磁盘上不放任何
 * 二进制 fixture —— 二进制 fixture 不可读、不可 diff，而且一旦损坏无法判断是解析
 * 器的错还是夹具的错。
 */
import { makeZip } from '../src/core/epub/zip-reader';

export interface EpubOptions {
  title?: string;
  withNav?: boolean;
  withNcx?: boolean;
  rtl?: boolean;
  /** 便捷开关：等价于 `coverMode: 'cover-image'`。 */
  cover?: boolean;
  coverMode?: 'cover-image' | 'meta' | 'filename' | 'none';
  /** 用 `opf:` 前缀写 OPF（模拟 Calibre 的带命名空间写法）。 */
  nsPrefix?: boolean;
  chapterCount?: number;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function chapterBody(index: number): string {
  if (index === 1) return '<p>こんにちは</p><p>第一章</p>';
  if (index === 2) return '<div>Second chapter &amp; more</div>';
  return `<p>Chapter ${index}</p>`;
}

function navXhtml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目次</title></head>
<body>
<nav epub:type="toc" id="toc">
<h1>Contents</h1>
<ol>
<li><a href="text/ch1.xhtml#start">Chapter &lt;1&gt; &amp; Intro</a></li>
<li><a href="text/ch2.xhtml">Chapter 2</a>
  <ol><li><a href="text/ch2.xhtml#s">Section 2.1</a></li></ol>
</li>
</ol>
</nav>
</body></html>`;
}

function ncxXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="bookid"/></head>
<docTitle><text>Test Book</text></docTitle>
<navMap>
<navPoint id="np1" playOrder="1"><navLabel><text>NCX One</text></navLabel><content src="text/ch1.xhtml#x"/></navPoint>
<navPoint id="np2" playOrder="2"><navLabel><text>NCX Two</text></navLabel><content src="text/ch2.xhtml"/>
  <navPoint id="np2a" playOrder="3"><navLabel><text>NCX Two A</text></navLabel><content src="text/ch2.xhtml#a"/></navPoint>
</navPoint>
</navMap>
</ncx>`;
}

/**
 * 构造 EPUB 的成员表（**不压缩**），方便测试删除/改写单个成员后重新 `makeZip`。
 *
 * 目录结构刻意做成 `OEBPS/content.opf` + `OEBPS/text/chN.xhtml`：OPF 不在压缩包
 * 根目录，任何「href 直接当根相对路径」的实现都会在这里露馅。
 */
export function buildEpubEntries(opts: EpubOptions = {}): Record<string, string> {
  const title = opts.title ?? 'Test Book';
  const withNav = opts.withNav ?? true;
  const withNcx = opts.withNcx ?? false;
  const chapterCount = Math.max(1, opts.chapterCount ?? 2);
  const coverMode = opts.coverMode ?? (opts.cover === true ? 'cover-image' : 'none');
  const prefix = opts.nsPrefix === true ? 'opf:' : '';
  const opfNs = 'xmlns:opf="http://www.idpf.org/2007/opf"';

  const chapterIds: string[] = [];
  for (let i = 1; i <= chapterCount; i += 1) chapterIds.push(`ch${i}`);

  const manifestItems: string[] = [];
  for (const id of chapterIds) {
    manifestItems.push(`<${prefix}item id="${id}" href="text/${id}.xhtml" media-type="application/xhtml+xml"/>`);
  }
  if (withNav) {
    manifestItems.push(`<${prefix}item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`);
  }
  if (withNcx) {
    manifestItems.push(`<${prefix}item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`);
  }

  let coverMeta = '';
  let coverEntryPath: string | null = null;
  if (coverMode === 'cover-image') {
    coverEntryPath = 'OEBPS/images/the-cover-art.jpg';
    manifestItems.push(
      `<${prefix}item id="cover-img" href="images/the-cover-art.jpg" media-type="image/jpeg" properties="cover-image"/>`,
    );
  } else if (coverMode === 'meta') {
    coverEntryPath = 'OEBPS/images/meta-cover.jpg';
    coverMeta = '<meta name="cover" content="cover-img"/>';
    manifestItems.push(`<${prefix}item id="cover-img" href="images/meta-cover.jpg" media-type="image/jpeg"/>`);
  } else if (coverMode === 'filename') {
    coverEntryPath = 'OEBPS/images/cover.jpg';
    manifestItems.push(`<${prefix}item id="cover-img" href="images/cover.jpg" media-type="image/jpeg"/>`);
  }

  const itemrefs = chapterIds.map((id, index) =>
    index === 1
      ? `<${prefix}itemref idref="${id}" linear="no"/>`
      : `<${prefix}itemref idref="${id}"/>`,
  );

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<${prefix}package ${opfNs} xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<${prefix}metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${escapeXml(title)}</dc:title>
<dc:creator>Author One</dc:creator>
<dc:creator>Author Two</dc:creator>
<dc:language>ja</dc:language>
<dc:publisher>Test Publisher</dc:publisher>
<dc:description>&lt;p&gt;A &lt;em&gt;plain&lt;/em&gt; description&lt;/p&gt;</dc:description>
${coverMeta}
</${prefix}metadata>
<${prefix}manifest>
${manifestItems.join('\n')}
</${prefix}manifest>
<${prefix}spine${withNcx ? ' toc="ncx"' : ''}${opts.rtl === true ? ' page-progression-direction="rtl"' : ''}>
${itemrefs.join('\n')}
</${prefix}spine>
</${prefix}package>`;

  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

  const entries: Record<string, string> = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': container,
    'OEBPS/content.opf': opf,
  };
  for (let i = 1; i <= chapterCount; i += 1) {
    entries[`OEBPS/text/ch${i}.xhtml`] = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>ch${i}</title></head><body>${chapterBody(i)}</body></html>`;
  }
  if (withNav) entries['OEBPS/nav.xhtml'] = navXhtml();
  if (withNcx) entries['OEBPS/toc.ncx'] = ncxXml();
  if (coverEntryPath !== null) entries[coverEntryPath] = 'FAKE-JPEG-BYTES';
  return entries;
}

/** 构造一个最小可用 EPUB（默认：nav 目录、2 章、无封面、ltr）。 */
export function buildEpub(opts: EpubOptions = {}): Uint8Array {
  return makeZip(buildEpubEntries(opts));
}

/** 构造一个 CBZ：每个成员名对应一份占位图片字节。 */
export function buildCbz(names: string[]): Uint8Array {
  const entries: Record<string, string> = {};
  for (const name of names) entries[name] = 'FAKE-IMAGE-BYTES';
  return makeZip(entries);
}
