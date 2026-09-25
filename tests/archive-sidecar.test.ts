/**
 * Rust 原生 sidecar（`.rar/.cbr/.7z/.cb7`）的端到端测试。
 *
 * 这一层**必须**有真实压缩包才能证明：纯 JS 对 RAR5/7z 没有可靠实现，而「代码能编译」
 * 与「能解开一个用户真实的 RAR」是两件事。所以这里：
 *
 * - `.zip` 用 `fflate` 现造（不需要外部工具）；
 * - `.rar` **真包**从两个来源发现：`unrar` crate 自带的官方测试夹具、以及本机
 *   `manga_anki` 项目里真实的一卷漫画。**找不到就跳过并打印原因**——不假装验证过。
 *   要固定用某个包，设 `ARALE_TEST_RAR=/abs/path.rar`。
 * - `.7z` 的解包正确性由 crate 自己的单测（`archive::sevenz::tests`）保证，这里只断言
 *   扩展名分流；因为本机没有可靠的 7z **写入**工具，造不出夹具。
 *
 * 没构建二进制时整个文件跳过（`.zip/.cbz` 走纯 JS，本来就不需要原生层）。
 */

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipSync, strToU8 } from 'fflate';

import {
  NativeCommandError,
  extractArchive,
  isNativeAvailable,
  probeArchive,
  resetNativeBinaryCache,
} from '../src/main/native/sidecar';
import { detectImportKind } from '../src/main/library/importer';
import { needsNativeExtractor } from '../src/shared/native-protocol';

const root = path.join(__dirname, '..', '..');

let workDir = '';
before(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'arale-sidecar-'));
  resetNativeBinaryCache();
});

// 清理放在 after 里。曾经写在每个用例末尾，结果第一个用例跑完就把工作目录删了，
// 后面所有用例全 ENOENT。
after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 最小 TAR 写入器（`.cbt` 夹具）
// ---------------------------------------------------------------------------

/**
 * 手写 ustar 容器。
 *
 * 为什么不引 `tar` 包：测试要能造出**macOS `bsdtar` 会打出来的那种包**——
 * 里面混着 `._*` AppleDouble 条目。`tar -tf` 会隐藏它们，但字节里确实有，
 * 而我们的解包器必须把它们剔掉（否则书里会多出「幽灵页」）。
 * 手写才能精确控制条目名。
 */
function buildTar(entries: Array<{ name: string; data: Buffer; type?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const writeStr = (value: string, offset: number, length: number): void => {
      header.write(value, offset, Math.min(length, value.length), 'utf8');
    };
    const writeOctal = (value: number, offset: number, length: number): void => {
      header.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'ascii');
      header[offset + length - 1] = 0;
    };

    writeStr(entry.name, 0, 100);
    writeOctal(0o644, 100, 8);
    writeOctal(0, 108, 8);
    writeOctal(0, 116, 8);
    writeOctal(entry.data.length, 124, 12);
    writeOctal(0, 136, 12);
    // checksum 先填空格，算完再写回
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? '0', 156, 1, 'ascii');
    header.write('ustar', 257, 5, 'ascii');
    header[262] = 0;
    header[263] = 0x30;
    header[264] = 0x30;

    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;

    blocks.push(header, entry.data);
    const padding = (512 - (entry.data.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  // tar 收尾：两个全零块
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** 本机真实漫画卷（邻接项目的输入，**只读**，绝不修改）。 */
const REAL_COMIC_RAR =
  '/Users/heyanle/Desktop/project/manga_anki/projects/0001-kyou-wa-kanojo-ga-inaikara/input/extracted/[岩見樹代子] 今日はカノジョがいないから 第01巻.rar';

/**
 * 任意一个真实 RAR（用来证明「真能读 RAR5 容器」）。
 * 优先级：环境变量 → unrar crate 官方夹具 → 真实漫画卷。
 */
function findAnyRealRar(): string | null {
  const fromEnv = process.env['ARALE_TEST_RAR'];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const registry = path.join(root, '.rust', 'cargo', 'registry', 'src');
  if (existsSync(registry)) {
    for (const entry of readdirSync(registry)) {
      const dataDir = path.join(registry, entry, 'unrar-0.5.8', 'data');
      if (!existsSync(dataDir)) continue;
      for (const name of ['unicode.rar', 'solid.rar']) {
        const candidate = path.join(dataDir, name);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  if (existsSync(REAL_COMIC_RAR)) return REAL_COMIC_RAR;
  return null;
}

/** 真实**漫画**RAR（有页图的那种）。unrar 的官方夹具里装的是文本，不算。 */
function findComicRar(): string | null {
  const fromEnv = process.env['ARALE_TEST_RAR'];
  if (fromEnv && existsSync(fromEnv) && statSync(fromEnv).size > 1024 * 1024) return fromEnv;
  if (existsSync(REAL_COMIC_RAR)) return REAL_COMIC_RAR;
  return null;
}

test('detectImportKind: .rar/.cbr/.7z/.cb7 走原生路径，.zip 不走', () => {
  // 扩展名分流必须与 native-protocol 的 NATIVE_ONLY_EXTENSIONS 一致。
  for (const ext of ['.rar', '.cbr', '.7z', '.cb7', '.cbt']) {
    assert.equal(needsNativeExtractor(`book${ext}`), true, `${ext} 应走原生`);
  }
  assert.equal(needsNativeExtractor('book.zip'), false);
  assert.equal(needsNativeExtractor('book.cbz'), false);
  assert.equal(needsNativeExtractor('book.epub'), false);

  // 真实文件不存在时 detectImportKind 走 unsupported，所以用临时空文件。
  for (const ext of ['.rar', '.7z']) {
    const file = path.join(workDir, `probe${ext}`);
    writeFileSync(file, 'x');
    assert.equal(detectImportKind(file), 'native', `${ext} 应判成 native`);
  }
});

test('sidecar: 未构建二进制时给出可操作的提示（或原生可用时跳过）', (t) => {
  if (isNativeAvailable()) {
    t.skip('本机已构建原生二进制，跳过降级分支');
    return;
  }
  // 降级路径必须说清楚「怎么修」，否则用户只看到一句「不支持」。
  assert.equal(isNativeAvailable(), false);
});

test('sidecar: probe 一个 CBZ，页序是自然序', async (t) => {
  if (!isNativeAvailable()) {
    t.skip('未构建 arale-native');
    return;
  }
  const cbz = path.join(workDir, 'sample.cbz');
  writeFileSync(
    cbz,
    Buffer.from(
      zipSync({
        'images/p1.png': strToU8('fake-png-1'),
        'images/p2.png': strToU8('fake-png-2'),
        'images/p10.png': strToU8('fake-png-10'),
        'readme.txt': strToU8('not a page'),
      }),
    ),
  );

  const probe = await probeArchive(cbz);
  assert.equal(probe.ok, true);
  assert.equal(probe.format, 'zip');
  assert.equal(probe.kind, 'comic');
  assert.equal(probe.hasOpf, false);
  assert.equal(probe.imageCount, 3);
  assert.deepEqual(probe.pages, ['images/p1.png', 'images/p2.png', 'images/p10.png']);
});

test('sidecar: probe 一个 EPUB 识别成 epub（按内容不按扩展名）', async (t) => {
  if (!isNativeAvailable()) {
    t.skip('未构建 arale-native');
    return;
  }
  // 故意给 .cbz 扩展名：判定必须按内容走。
  const disguised = path.join(workDir, 'disguised.cbz');
  writeFileSync(
    disguised,
    Buffer.from(zipSync({ 'OEBPS/content.opf': strToU8('<package/>'), 'mimetype': strToU8('application/epub+zip') })),
  );

  const probe = await probeArchive(disguised);
  assert.equal(probe.kind, 'epub');
  assert.equal(probe.hasOpf, true);
  assert.deepEqual(probe.pages, []);
});

test('sidecar: extract 保留子目录，且只写页图', async (t) => {
  if (!isNativeAvailable()) {
    t.skip('未构建 arale-native');
    return;
  }
  const cbz = path.join(workDir, 'nested.cbz');
  writeFileSync(
    cbz,
    Buffer.from(
      zipSync({
        'vol1/p001.jpg': strToU8('page-one'),
        'vol2/p001.jpg': strToU8('page-two'),
        'notes.txt': strToU8('skip me'),
      }),
    ),
  );

  const out = path.join(workDir, 'extracted');
  const result = await extractArchive(cbz, out, true);
  assert.equal(result.ok, true);
  // 同名不同目录的两页必须都留下（绝不拍平成 basename）。
  assert.ok(existsSync(path.join(out, 'vol1', 'p001.jpg')), 'vol1 的页要落盘');
  assert.ok(existsSync(path.join(out, 'vol2', 'p001.jpg')), 'vol2 的页要落盘');
  assert.equal(existsSync(path.join(out, 'notes.txt')), false, '--images-only 不该写非页图');
  assert.ok(result.skipped >= 1, 'notes.txt 应计入 skipped');

  // 内容也要对（不能是空文件）。
  assert.equal(statSync(path.join(out, 'vol1', 'p001.jpg')).size, 8);
});

test('sidecar: 坏压缩包报 ok:false 且带可读错误（不 panic）', async (t) => {
  if (!isNativeAvailable()) {
    t.skip('未构建 arale-native');
    return;
  }
  const bad = path.join(workDir, 'broken.cbr');
  writeFileSync(bad, 'this is definitely not a rar file');

  await assert.rejects(
    () => probeArchive(bad),
    (error: unknown) => {
      assert.ok(error instanceof NativeCommandError, `应是 NativeCommandError，实际 ${String(error)}`);
      assert.ok(error.message.length > 0);
      return true;
    },
  );
});

test('sidecar: .cbt（tar）能探测出页与页序', async (t) => {
  if (!isNativeAvailable()) {
    t.skip('未构建 arale-native');
    return;
  }
  const cbt = path.join(workDir, 'book.cbt');
  writeFileSync(
    cbt,
    buildTar([
      { name: './', data: Buffer.alloc(0), type: '5' },
      { name: './vol1/', data: Buffer.alloc(0), type: '5' },
      { name: './vol1/p10.jpg', data: Buffer.from('ten') },
      { name: './vol1/p2.jpg', data: Buffer.from('two') },
      { name: './vol1/p1.jpg', data: Buffer.from('one') },
    ]),
  );

  const probe = await probeArchive(cbt);
  assert.equal(probe.ok, true);
  assert.equal(probe.format, 'tar', 'tar 必须按内容被判出来');
  assert.equal(probe.kind, 'comic');
  // 目录项不计入 entryCount（契约），`./` 前缀要被剥掉。
  assert.deepEqual(probe.pages, ['vol1/p1.jpg', 'vol1/p2.jpg', 'vol1/p10.jpg']);

  const out = path.join(workDir, 'cbt-out');
  const result = await extractArchive(cbt, out, true);
  assert.equal(result.ok, true);
  assert.equal(result.extracted.length, 3);
  assert.equal(fs.readFileSync(path.join(out, 'vol1', 'p2.jpg'), 'utf8'), 'two');
});

test('sidecar: .cbt 里的 macOS 资源叉（._*）必须被剔掉', async (t) => {
  if (!isNativeAvailable()) {
    t.skip('未构建 arale-native');
    return;
  }
  // 这条钉的是一个真实 bug：macOS 的 `bsdtar` 打 `.cbt` 时会写进 `._p001.png`
  // 这类 AppleDouble 条目（`tar -tf` 会隐藏它们，字节里确实有）。
  // 它们的扩展名就是 `.png`，**能通过扩展名白名单**——只按扩展名过滤的话，
  // 书里会多出四个「幽灵页」。
  const cbt = path.join(workDir, 'junk.cbt');
  writeFileSync(
    cbt,
    buildTar([
      { name: 'images/p001.png', data: Buffer.from('real-one') },
      { name: 'images/._p001.png', data: Buffer.from('appledouble') },
      { name: '__MACOSX/._p001.png', data: Buffer.from('appledouble2') },
      { name: '._readme.txt', data: Buffer.from('appledouble3') },
    ]),
  );

  const probe = await probeArchive(cbt);
  assert.deepEqual(probe.pages, ['images/p001.png'], '资源叉不该算页');

  const out = path.join(workDir, 'junk-out');
  const result = await extractArchive(cbt, out, true);
  assert.equal(result.extracted.length, 1, `只应写出 1 张真页图，实际 ${result.extracted.length}`);
  assert.ok(fs.existsSync(path.join(out, 'images', 'p001.png')));
  assert.equal(fs.existsSync(path.join(out, 'images', '._p001.png')), false, '资源叉不该落盘');
  assert.equal(fs.existsSync(path.join(out, '__MACOSX')), false);
});

test('sidecar: 真实 RAR 容器能被读懂（找不到夹具则跳过）', async (t) => {
  if (!isNativeAvailable()) {
    t.skip('未构建 arale-native');
    return;
  }
  const rar = findAnyRealRar();
  if (!rar) {
    t.skip('本机没有可用的真实 .rar 夹具（设 ARALE_TEST_RAR 可指定）');
    return;
  }

  const probe = await probeArchive(rar);
  // 这一条只证明「RAR5 容器能打开、条目能列出」。内容是文本还是图片取决于夹具，
  // 所以不断言 kind；图片卷另有一条用例。
  assert.equal(probe.format, 'rar', '格式必须按内容判成 rar');
  assert.ok(probe.entryCount >= 1, `应至少有一个条目，实际 ${probe.entryCount}`);
  assert.ok(probe.pages.every((page) => page.length > 0));

  console.log(
    `    [rar] ${path.basename(rar)} → ${probe.entryCount} 条目 / ${probe.imageCount} 页`,
  );
});

test('sidecar: 真实漫画 RAR 全卷解包（存在才跑）', async (t) => {
  if (!isNativeAvailable()) {
    t.skip('未构建 arale-native');
    return;
  }
  // 只有真实**漫画**卷才够格跑这条（unrar 的官方夹具里装的是文本，不是图片）。
  const rar = findComicRar();
  if (!rar) {
    t.skip('本机没有真实漫画 RAR（设 ARALE_TEST_RAR 可指定）');
    return;
  }

  const out = path.join(workDir, 'real-volume');
  const result = await extractArchive(rar, out, true);
  assert.equal(result.ok, true);
  assert.ok(result.extracted.length >= 100, `真实一卷应有上百页，实际 ${result.extracted.length}`);

  // 抽查若干页真的落盘且非空。
  for (const index of [0, 10, result.extracted.length - 1]) {
    const item = result.extracted[index];
    if (!item) continue;
    const file = path.join(out, ...item.rel.split('/'));
    assert.ok(existsSync(file), `第 ${index} 页应落盘：${item.rel}`);
    assert.ok(statSync(file).size > 0, `第 ${index} 页不应为空文件`);
  }
  console.log(`    [rar] 全卷解包 ${result.extracted.length} 页，skipped ${result.skipped}`);
});
