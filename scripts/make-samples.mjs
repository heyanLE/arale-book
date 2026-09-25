/**
 * 生成示例书（`samples/`）。
 *
 * 产出三样东西：
 * 1. `吾輩は猫である.epub` —— 竖排日文小说，带 nav 目录、封面、CSS；
 * 2. `サンプル漫画 v01.cbz` —— **页图上有真实日文字**，并带匹配的 mokuro 文字层，
 *    所以点词查义和 OCR 都能在它上面真跑；
 * 3. `ocr-fixture.png` —— 一页「4 竖排 + 3 横排」的测试图，专门用来验证 OCR 的
 *    竖排补偿是否生效（竖排块一个都认不出 = 补偿没做对）。
 *
 * 为什么页图要用 Chromium 渲染（而不是纯 zlib 画色块）：色块验证不了 OCR 与查词——
 * 「识别出 0 个框」既可能是模型没跑起来也可能是图上没字，无法区分。渲染需要起一个
 * 隐藏窗口，所以本脚本会 spawn Electron。
 *
 * 用法：`node scripts/make-samples.mjs`
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'samples');
const tmpDir = join(root, '.sample-render');

const PAGE_WIDTH = 800;
const PAGE_HEIGHT = 1200;

// ---------------------------------------------------------------------------
// 极简 PNG 编码器（只给 EPUB 封面用；页图走 Chromium 渲染）
// ---------------------------------------------------------------------------

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, pixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    raw[cursor] = 0;
    cursor += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[cursor] = r;
      raw[cursor + 1] = g;
      raw[cursor + 2] = b;
      cursor += 3;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 漫画页的文字布局
// ---------------------------------------------------------------------------

/** 竖排块：一个字符一行（mokuro 的 `lines` 语义）。 */
function vertical(text, x, y, width, height, fontSize = 26) {
  return { text, vertical: true, box: [x, y, x + width, y + height], fontSize };
}

/** 横排块：整句放进一行。 */
function horizontal(text, x, y, width, height, fontSize = 26) {
  return { text, vertical: false, box: [x, y, x + width, y + height], fontSize };
}

/**
 * 四页漫画。每页 2–3 个竖排块 + 1 个横排块，全部是**真实日文**——
 * 里面刻意放了动词活用（食べました / 書いた / 見ていた），这样点词查义能验证去屈折。
 */
const COMIC_PAGES = [
  [
    vertical('吾輩は猫である。名前はまだ無い。', 60, 90, 52, 620),
    vertical('どこで生れたかとんと見当がつかぬ。', 150, 90, 52, 700),
    horizontal('今日はいい天気ですね。', 340, 120, 400, 60),
  ],
  [
    vertical('書生は毎日学校へ行く。', 60, 90, 52, 460),
    vertical('私はその様子を縁側から眺めていた。', 150, 90, 52, 760),
    horizontal('ちょっと待ってください。', 340, 120, 400, 60),
  ],
  [
    vertical('名前がないというのは不便である。', 60, 90, 52, 700),
    vertical('誰も私を呼ばない。', 150, 90, 52, 340),
    horizontal('ごはんを食べました。', 340, 120, 400, 60),
  ],
  [
    vertical('太陽の当たる場所と、おいしいご飯。', 60, 90, 52, 760),
    horizontal('それで十分である。', 340, 120, 400, 60),
    horizontal('また明日。', 340, 240, 400, 60),
  ],
];

/** OCR 专用的「4 竖排 + 3 横排」测试页。 */
const OCR_FIXTURE_BLOCKS = [
  vertical('吾輩は猫である。名前はまだ無い。', 60, 110, 52, 560),
  vertical('どこで生れたかとんと見当がつかぬ。', 150, 110, 52, 640),
  vertical('シャーッと鳴いてみせた。', 240, 110, 52, 520),
  vertical('これはテストです。', 60, 720, 52, 400),
  horizontal('今日はいい天気ですね。', 340, 110, 400, 70),
  horizontal('ちょっと待ってください。', 340, 230, 400, 70),
  horizontal('がっこうへいきます。', 340, 720, 400, 70),
];

// ---------------------------------------------------------------------------
// 用 Chromium 渲染
// ---------------------------------------------------------------------------

function renderPngs(pages) {
  if (pages.length === 0) return;
  const specPath = join(tmpDir, 'spec.json');
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(specPath, JSON.stringify({ pages }, null, 2));

  const electron = join(root, 'node_modules', '.bin', 'electron');
  const result = spawnSync(
    electron,
    [join('scripts', 'render-text-image.cjs'), specPath, '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', '--disable-dev-shm-usage'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
  );
  // Electron 在受限环境里会往 stderr 刷一堆无关告警，只把真正的失败报出来。
  if (result.status !== 0) {
    console.error(result.stdout ?? '');
    console.error(result.stderr ?? '');
    throw new Error(`渲染页图失败（exit ${result.status}）`);
  }
  for (const line of (result.stdout ?? '').split('\n')) {
    if (line.startsWith('wrote ')) console.log(line);
  }
}

// ---------------------------------------------------------------------------
// CBZ
// ---------------------------------------------------------------------------

function buildCbz(options = {}) {
  const withText = options.withText !== false;
  const files = {};
  const mokuroPages = [];

  COMIC_PAGES.forEach((blocks, index) => {
    const name = `images/p${String(index + 1).padStart(3, '0')}.png`;
    const absPath = join(tmpDir, `page-${index + 1}.png`);
    files[name] = [new Uint8Array(readFileSync(absPath)), { level: 6 }];

    mokuroPages.push({
      img_path: name,
      img_width: PAGE_WIDTH,
      img_height: PAGE_HEIGHT,
      blocks: blocks.map((block) => ({
        box: block.box,
        vertical: block.vertical,
        // 竖排一块一个字符；横排整句一行——与渲染方式一致，字符命中比例计算才对得上。
        lines: block.vertical ? Array.from(block.text) : [block.text],
        font_size: block.fontSize,
      })),
    });
  });

  if (withText) {
    files['sample.mokuro'] = strToU8(
      JSON.stringify({ title: 'サンプル漫画', volume: '1', pages: mokuroPages }),
    );
    files['manga.json'] = strToU8(
      JSON.stringify({
        pages: mokuroPages.map((page) => ({
          url: page.img_path,
          width: page.img_width,
          height: page.img_height,
          blocks: page.blocks,
        })),
      }),
    );
    files['readme.txt'] = strToU8('aralebook サンプル漫画。画像とテキストは生成物です。\n');
  } else {
    // 不带文字层：专门用来体验 OCR —— 带文字层的书点「识别文字」会被直接跳过。
    files['readme.txt'] = strToU8('文字層なしのサンプル。OCR を試す用。\n');
  }

  return Buffer.from(zipSync(files, { level: 6 }));
}

/**
 * 生成一本「图片型小说」示例：整本都是整页插图，没有可读文本。
 *
 * 这是专门用来验证那条特殊路径的：**显示为小说（EPUB），打开用漫画阅读器**。
 * 每章只放一张整页图 + 一个空 `<p>`（模拟真实的图注/页码残留），
 * 所以会命中 `isImageNovel`（每章有图、正文 ≤20 字）。
 */
function buildImageNovelEpub(pageFiles) {
  const files = {};
  files['mimetype'] = [strToU8('application/epub+zip'), { level: 0 }];
  files['META-INF/container.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);

  pageFiles.forEach((file, index) => {
    const n = String(index + 1).padStart(2, '0');
    files[`OEBPS/images/page${n}.png`] = [new Uint8Array(readFileSync(file)), { level: 6 }];
    // 每章一页整图；那个 <p> 是刻意的：真实扫描件常带页码/图注，
    // 判据必须容忍它（阈值 20 字），否则这类书永远命中不了。
    files[`OEBPS/text/page${n}.xhtml`] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja" lang="ja">
<head><meta charset="utf-8"/><title>第 ${index + 1} 页</title></head>
<body><div><img src="../images/page${n}.png" alt=""/><p>${index + 1}</p></div></body>
</html>`);
  });

  files['OEBPS/nav.xhtml'] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja">
<head><meta charset="utf-8"/><title>目次</title></head>
<body><nav epub:type="toc" id="toc"><h1>目次</h1><ol>
${pageFiles.map((_, i) => `  <li><a href="text/page${String(i + 1).padStart(2, '0')}.xhtml">第 ${i + 1} 页</a></li>`).join('\n')}
</ol></nav></body></html>`);

  files['OEBPS/content.opf'] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="ja">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:arale-image-novel-sample</dc:identifier>
    <dc:title>画像小説サンプル（全ページ挿絵）</dc:title>
    <dc:creator>あられブック サンプル</dc:creator>
    <dc:language>ja</dc:language>
    <dc:description>全ページが挿絵の EPUB。書庫では小説、開くと漫画リーダーで読む。</dc:description>
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${pageFiles.map((_, i) => `    <item id="img${i + 1}" href="images/page${String(i + 1).padStart(2, '0')}.png" media-type="image/png"/>`).join('\n')}
${pageFiles.map((_, i) => `    <item id="p${i + 1}" href="text/page${String(i + 1).padStart(2, '0')}.xhtml" media-type="application/xhtml+xml"/>`).join('\n')}
  </manifest>
  <spine>
${pageFiles.map((_, i) => `    <itemref idref="p${i + 1}"/>`).join('\n')}
  </spine>
</package>`);

  return Buffer.from(zipSync(files, { level: 6 }));
}

// ---------------------------------------------------------------------------
// EPUB
// ---------------------------------------------------------------------------

function buildEpub() {
  const chapters = [
    {
      id: 'ch1',
      href: 'text/ch1.xhtml',
      title: '第一話　吾輩は猫である',
      body: `
        <h1>第一話</h1>
        <p>吾輩は猫である。名前はまだ無い。</p>
        <p>どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。</p>
        <p>吾輩はここで始めて人間というものを見た。しかもあとで聞くとそれは書生という人間中で一番獰悪な種族であったそうだ。</p>
        <p>この書生というのは時々我々を捕えて煮て食うという話である。しかしその当時は何という考もなかったから別段恐しいとも思わなかった。</p>
        <p>ただ彼の掌に載せられてスーと持ち上げられた時、何だかフワフワした感じがあったばかりである。</p>
        <p>吾輩は<ruby>猫<rt>ねこ</rt></ruby>である。</p>`,
    },
    {
      id: 'ch2',
      href: 'text/ch2.xhtml',
      title: '第二話　書生という人間',
      body: `
        <h1>第二話</h1>
        <p>書生は毎日学校へ行く。帰ってくると、まず机の前に座って、何か書き始める。</p>
        <p>私はその様子を、縁側からじっと眺めていた。ペンを走らせる音が、妙に心地よかった。</p>
        <p>ときどき彼は、難しい顔をして本を読んでいる。読書というものは、いったい何の役に立つのか、私には皆目見当がつかなかった。</p>
        <p>しかし、彼が笑うときの顔は、なかなか悪くなかった。人間も捨てたものではない、と思ったのはこの頃である。</p>
        <p>ごはんを食べました。また明日。</p>`,
    },
    {
      id: 'ch3',
      href: 'text/ch3.xhtml',
      title: '第三話　名前',
      body: `
        <h1>第三話</h1>
        <p>名前がないというのは、案外不便なものである。誰も私を呼ばない。</p>
        <p>主人は私を「猫」と呼ぶ。女中は私を「ねこ」と呼ぶ。どちらも名前ではない。</p>
        <p>名前というものは、他人が勝手に決めるものらしい。そして一度決まってしまうと、自分ではどうにもならない。</p>
        <p>私はといえば、名前など無くても構わないと思っている。ただ、太陽の当たる場所と、おいしいご飯があれば、それで十分である。</p>`,
    },
  ];

  const coverPng = encodePng(600, 800, (x, y) => {
    const u = x / 600;
    const v = y / 800;
    if (Math.abs(u - 0.5) < 0.34 && Math.abs(v - 0.42) < 0.16) return [245, 243, 238];
    const grad = Math.floor(30 + 40 * v);
    return [grad + 90, grad + 60, grad + 70];
  });

  const files = {};
  files['mimetype'] = [strToU8('application/epub+zip'), { level: 0 }];
  files['META-INF/container.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  files['OEBPS/styles/main.css'] = strToU8(`
body { font-family: "Hiragino Mincho ProN", "Yu Mincho", serif; line-height: 1.9; }
h1 { font-size: 1.5em; border-bottom: 1px solid #999; padding-bottom: .3em; margin: 1.5em 0 1em; }
p { text-indent: 1em; margin: .6em 0; }
ruby rt { font-size: .5em; }
`);

  files['OEBPS/images/cover.png'] = coverPng;

  for (const chapter of chapters) {
    files[`OEBPS/${chapter.href}`] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja" lang="ja">
<head>
  <meta charset="utf-8"/>
  <title>${chapter.title}</title>
  <link rel="stylesheet" type="text/css" href="../styles/main.css"/>
</head>
<body>
  <section>
    ${chapter.body}
  </section>
</body>
</html>`);
  }

  files['OEBPS/nav.xhtml'] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja">
<head><meta charset="utf-8"/><title>目次</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目次</h1>
    <ol>
${chapters.map((c) => `      <li><a href="${c.href}">${c.title}</a></li>`).join('\n')}
    </ol>
  </nav>
</body>
</html>`);

  files['OEBPS/content.opf'] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="ja">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:aralebook-sample-0001</dc:identifier>
    <dc:title>吾輩は猫である（抜粋）</dc:title>
    <dc:creator>夏目 漱石</dc:creator>
    <dc:language>ja</dc:language>
    <dc:publisher>aralebook サンプル</dc:publisher>
    <dc:description>青空文庫の作品からの抜粋を、サンプル用に組み直したものです。</dc:description>
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="styles/main.css" media-type="text/css"/>
    <item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image"/>
${chapters.map((c) => `    <item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`).join('\n')}
  </manifest>
  <spine>
${chapters.map((c) => `    <itemref idref="${c.id}"/>`).join('\n')}
  </spine>
</package>`);

  return Buffer.from(zipSync(files, { level: 6 }));
}

// ---------------------------------------------------------------------------

rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

// 一次性把所有页图渲染出来（起一次 Electron 比每页起一次快得多）。
const renderSpec = [
  ...COMIC_PAGES.map((blocks, index) => ({
    out: join(tmpDir, `page-${index + 1}.png`),
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    background: '#ffffff',
    blocks,
  })),
  {
    out: join(outDir, 'ocr-fixture.png'),
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    background: '#ffffff',
    blocks: OCR_FIXTURE_BLOCKS,
  },
];

console.log(`渲染 ${renderSpec.length} 张页图…`);
renderPngs(renderSpec);

const epubPath = join(outDir, '吾輩は猫である.epub');
const cbzPath = join(outDir, 'サンプル漫画 v01.cbz');
// 第 3 本：图片型小说（显示为 EPUB，打开用漫画阅读器）。
const imageNovelPath = join(outDir, '画像小説サンプル.epub');
writeFileSync(epubPath, buildEpub());
writeFileSync(cbzPath, buildCbz());
// 第 4 本：同一卷但**没有文字层**，用来体验 OCR（带文字层的会被跳过）。
const noTextPath = join(outDir, 'サンプル漫画（文字層なし）.cbz');
writeFileSync(noTextPath, buildCbz({ withText: false }));
writeFileSync(
  imageNovelPath,
  buildImageNovelEpub(COMIC_PAGES.map((_, index) => join(tmpDir, `page-${index + 1}.png`))),
);

rmSync(tmpDir, { recursive: true, force: true });

for (const file of [epubPath, cbzPath, noTextPath, imageNovelPath, join(outDir, 'ocr-fixture.png')]) {
  console.log(`wrote ${file} (${existsSync(file) ? readFileSync(file).length : 0} bytes)`);
}
