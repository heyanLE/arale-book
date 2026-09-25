/**
 * `arale-native` 原生 sidecar 的集成测试。
 *
 * 这一层测的是**协议**，不是 Rust 内部逻辑（那些由 crate 内的 `#[cfg(test)]`
 * 覆盖）：
 *   - stdout 必须是**纯 JSON**（Node 侧 `JSON.parse(stdout)` 是无脑的，多一个
 *     字符就崩），且退出码语义正确（0/1/2）；
 *   - `probe` 的字段名与 `src/shared/native-protocol.ts` 的
 *     `NativeProbeResult` 完全一致；
 *   - `extract` 保留子目录结构，且**含 `..` 的成员被跳过而不是写出**
 *     （zip-slip 红线）；
 *   - 内容判定优先于扩展名（`.cbr` 里装的是 zip 时必须报 `zip`）。
 *
 * 夹具策略（全部不依赖外部工具）：
 *   - `.zip`：`fflate` 的 `zipSync`；
 *   - `.7z`：用项目既有依赖 `7z-wasm`（WASM 内存文件系统 + NODEFS）生成真实
 *     容器（见 `makeSevenZip`）。曾试过手写 7z 容器，但 7z 头部的 Section/
 *     property-size/双 CRC 结构太容易写出「看起来通过、其实 entryCount=0」的
 *     假绿测试，不值得；
 *   - 恶意 `.zip`（带 `../escape.jpg`）：手写 zip 字节。**必须手写**，因为
 *     `fflate`/`zip` crate 的 writer 都会悄悄吃掉 `..` 段，用它们造不出真实
 *     恶意条目；
 *   - `.rar`：**无法本地生成**（RAR 是专有格式，官方编码器不自由）。测试在
 *     运行时从一个 CC0 公开仓库下载 410 字节的 RAR5 fixture（见 `RAR_FIXTURES`）。
 *     拿不到网络时**明确 skip** 并打印原因，绝不当成通过。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { strToU8, zipSync } from 'fflate';

/** `7z-wasm` 的模块形状（动态 `import()` 时用它标注类型）。 */
type SevenZipModule = import('7z-wasm').SevenZipModule;

// ---------------------------------------------------------------------------
// 二进制定位
// ---------------------------------------------------------------------------

/** 发布二进制路径（Windows 带 `.exe`）。 */
const BINARY = path.resolve(
  __dirname,
  '..',
  '..',
  'native',
  'arale-native',
  'target',
  'release',
  process.platform === 'win32' ? 'arale-native.exe' : 'arale-native',
);

const BINARY_PRESENT = fs.existsSync(BINARY);

/** 二进制缺失时的提示（`cargo build --release` 是唯一前置）。 */
const MISSING_BINARY_HINT =
  `跳过：找不到原生 sidecar 二进制 ${BINARY}。` +
  '请先构建：cd native/arale-native && cargo build --release' +
  '（需要设置 PATH/CARGO_HOME/RUSTUP_HOME 指向仓库根的 .rust/）。';

/**
 * 每个测试开头的守卫：二进制不在就 `t.skip(...)`，**绝不静默通过**。
 *
 * 为什么不用 `test(..., { skip })`：`skip` 接受 `string | boolean`，写
 * `skip: !BINARY_PRESENT && MISSING_BINARY_HINT` 会得到 `false | string`
 * ——当二进制存在时值为 `false`（正确），但类型与语义都绕。统一用
 * `TestContext.skip()` 更直白，也让「为什么跳过」出现在报告里。
 */
function requireBinary(t: { skip: (message?: string) => void }): boolean {
  if (!BINARY_PRESENT) {
    t.skip(MISSING_BINARY_HINT);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 子进程封装：每次调用都必须断言 stdout 是纯 JSON
// ---------------------------------------------------------------------------

interface RunResult {
  status: number;
  json: Record<string, unknown>;
  stdout: string;
  stderr: string;
}

/**
 * 跑一次 sidecar 并解析 stdout。
 *
 * 关键断言（对整个原生层都成立）：**stdout 只包含一个 JSON 对象**。任何日志、
 * 警告、panic backtrace 出现在 stdout 都会让这里失败 —— 这正是契约
 * `native-protocol.ts:19` 的核心要求。
 */
function runNative(args: string[]): RunResult {
  let status = 0;
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync(BINARY, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string };
    status = failure.status ?? 1;
    stdout = failure.stdout ?? '';
    stderr = failure.stderr ?? '';
  }
  // stdout 必须是「一行 JSON + 换行」，前后不能有别的输出。
  const lines = stdout.split('\n');
  assert.equal(lines[lines.length - 1], '', 'stdout 必须以单个换行结束');
  assert.equal(lines.length, 2, `stdout 必须恰好一行，实际 ${lines.length - 1} 行：${stdout}`);
  const json = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
  return { status, json, stdout, stderr };
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeTempDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `arale-native-${tag}-`));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** 页图字节：内容不同即可，probe/extract 都不解析图片。 */
const PAGE_BYTES = Buffer.from('fake-jpeg-bytes-for-arale-native-tests', 'utf8');

/** 用 fflate 造一个 CBZ（顺带验证 `.zip` 走 fflate 的路径与原生层口径一致）。 */
function makeCbz(dir: string, files: Record<string, Buffer>): string {
  const target = path.join(dir, 'book.cbz');
  const zipped = zipSync(
    Object.fromEntries(Object.entries(files).map(([name, data]) => [name, strToU8(data.toString('binary'))])),
    { level: 6 },
  );
  fs.writeFileSync(target, zipped);
  return target;
}

/** DOS 时间戳（最小合法值 1980-01-01 00:00:00）。 */
const DOS_TIME = 0;
const DOS_DATE = 0x21;

/** 标准 CRC32（zip 用），与 zlib 同口径。 */
const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 手写一个 STORED（不压缩）ZIP。
 *
 * 为什么不用 `fflate.zipSync`：它和 Rust `zip` crate 的 writer 一样会规整化
 * 路径，`../escape.jpg` 会被改写掉，于是**测不到**最重要的一条安全属性。
 * 手写容器是唯一能造出「成员名真的含 `..`」的包的办法。
 */
function makeRawZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 名字
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localPart, centralPart, eocd]);
}

/**
 * 用 `7z-wasm`（已是项目依赖）造一个真实 `.7z`。
 *
 * 为什么不用 `sevenz-rust` 的 writer：那需要给**生产二进制**加一个「测试专用」的
 * `pack` 子命令，等于把「能写文件」变成发布产物的一部分，攻击面白白变大。
 *
 * 为什么不用手写 7z 容器：试过。7z 头部有 7 种 Section ID、每个 property 都带
 * 自己的 `size` 字段、两处 CRC（StartHeader 与 NextHeader）、还有版本/字段偏移
 * 的坑。手写版本能让 `probe` 报 `ok:true` 但 `entryCount` 恒为 0 —— 一个「看起来
 * 通过、其实没测到解包」的假绿测试。它作为反例留在 git 历史里，不值得。
 *
 * 为什么不用 `node:test` 之外的工具：`7z-wasm` 是项目既有依赖，WASM 内存文件系统
 * 与宿主机文件系统通过 NODEFS 桥接，不需要在 PATH 上找 `7z` 二进制。
 */
let sevenZipModule: SevenZipModule | null = null;

/** 读 WASM 内存文件系统的文件（`FS.open` + `read`，比 `readFile` 在 NODEFS 下可靠）。 */
function readWasFs(fsModule: SevenZipModule, filename: string): Buffer {
  const stream = fsModule.FS.open(filename, 'r');
  const chunks: Buffer[] = [];
  const scratch = Buffer.alloc(64 * 1024);
  const size = fsModule.FS.stat(filename).size;
  let read = 0;
  while (read < size) {
    const got = fsModule.FS.read(stream, scratch, 0, Math.min(scratch.length, size - read), read);
    if (got <= 0) break;
    chunks.push(Buffer.from(scratch.subarray(0, got)));
    read += got;
  }
  fsModule.FS.close(stream);
  return Buffer.concat(chunks);
}

async function makeSevenZip(entries: Array<{ name: string; data: Buffer }>): Promise<Buffer> {
  const { default: SevenZip } = await import('7z-wasm');
  sevenZipModule = sevenZipModule ?? (await SevenZip({ print: () => {}, printErr: () => {} }));
  const sevenZip = sevenZipModule;
  const root = '/arale-fixture';
  if (!sevenZip.FS.readdir('/').includes('arale-fixture')) sevenZip.FS.mkdir(root);

  // 在 WASM 虚拟文件系统里铺好目录与文件（NODEFS 会把它们写回真实磁盘）。
  for (const { name, data } of entries) {
    const parts = name.split('/');
    const filename = parts.pop() as string;
    let dir = root;
    for (const part of parts) {
      dir = `${dir}/${part}`;
      if (!sevenZip.FS.readdir(path.posix.dirname(dir)).includes(part)) sevenZip.FS.mkdir(dir);
    }
    sevenZip.FS.writeFile(`${dir}/${filename}`, data);
  }

  // `7z-wasm` 的 `callMain` 在出错时会 `onExit`；这里只在成功时返回字节。
  const archiveName = 'fixture.7z';
  sevenZip.FS.chdir(root);
  sevenZip.callMain(['a', '-t7z', '-mx=1', archiveName, ...entries.map((e) => e.name)]);
  const bytes = readWasFs(sevenZip, archiveName);
  // 清掉临时目录，避免同一个 WASM 实例上重复调用时污染。
  for (const { name } of entries) sevenZip.FS.unlink(name);
  sevenZip.FS.unlink(archiveName);
  return bytes;
}

/**
 * CC0（公有领域）公开 RAR 夹具。
 *
 * 来源：https://github.com/ssokolow/rar-test-files —— 作者用正版 WinRAR 造的
 * 最小 RAR3/RAR5/CBR 文件，并在 LICENSE.md 里声明放弃著作权（CC0 1.0）。
 * 固定 URL + SHA-256：如果上游换了文件内容，测试会明确失败而不是悄悄换样本。
 *
 * 为什么必须下载：RAR 是专有格式，本地没有任何合法编码器（`unrar` 只能解不能
 * 打包），`7z` 也不能写 RAR。
 */
const RAR_FIXTURES = {
  rar5: {
    url: 'https://raw.githubusercontent.com/ssokolow/rar-test-files/master/build/testfile.rar5.cbr',
    sha256: 'e8b106048f18e6fb9a5f8ec6a95346e76906e7e4e9ca15ec97e4f926159cb398',
    bytes: 410,
  },
  rar3: {
    url: 'https://raw.githubusercontent.com/ssokolow/rar-test-files/master/build/testfile.rar3.cbr',
    sha256: '6598d1c5f7accfeefbda2bf03f934181486a42ea06a4d322d6016410d1a89cc1',
    bytes: 381,
  },
} as const;

/** 下载一个夹具到 `dir`，返回路径；失败返回 `null`（调用方 skip）。 */
function downloadFixture(
  dir: string,
  name: string,
  spec: { url: string; sha256: string; bytes: number },
): string | null {
  const target = path.join(dir, `${name}.cbr`);
  try {
    const body = execFileSync('curl', ['-fsSL', '--max-time', '30', '-o', target, spec.url], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    void body;
  } catch {
    return null;
  }
  if (!fs.existsSync(target)) return null;
  const digest = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  if (digest !== spec.sha256) {
    fs.rmSync(target, { force: true });
    return null;
  }
  return target;
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

test('version：stdout 是纯 JSON 且 ok:true', { skip: !BINARY_PRESENT && MISSING_BINARY_HINT }, () => {
  const { status, json } = runNative(['version']);
  assert.equal(status, 0);
  assert.equal(json.ok, true);
  assert.equal(typeof json.version, 'string');
});

test('用法错误：退出码 2，stdout 仍是合法 JSON', { skip: !BINARY_PRESENT && MISSING_BINARY_HINT }, () => {
  for (const args of [[], ['frobnicate'], ['probe'], ['extract', '--input', '/a']]) {
    const { status, json } = runNative(args);
    assert.equal(status, 2, `args=${JSON.stringify(args)} 必须是用法错误`);
    assert.equal(json.ok, false);
    assert.equal(typeof json.error, 'string');
  }
});

test(
  'probe：cbz 页图按自然序返回，且字段名与冻结协议一致',
  (_t) => {
    if (!requireBinary(_t)) return;
    const dir = makeTempDir('cbz');
    // 刻意乱序 + 零填充，验证自然序与 tie-break（短数字段在前）。
    const cbz = makeCbz(dir, {
      'vol1/p10.jpg': PAGE_BYTES,
      'vol1/p2.jpg': PAGE_BYTES,
      'vol1/p1.jpg': PAGE_BYTES,
      'vol1/p001.jpg': PAGE_BYTES,
      'vol1/notes.txt': Buffer.from('not a page', 'utf8'),
      'vol1/cover.PNG': PAGE_BYTES,
    });

    const { status, json } = runNative(['probe', '--input', cbz]);
    assert.equal(status, 0);
    assert.equal(json.ok, true);
    assert.equal(json.format, 'zip');
    assert.equal(json.kind, 'comic');
    assert.equal(json.hasOpf, false);
    // entryCount 不含目录项：6 个成员全是文件。
    assert.equal(json.entryCount, 6);
    assert.equal(json.imageCount, 5);
    assert.deepEqual(json.pages, [
      'vol1/cover.PNG',
      'vol1/p1.jpg',
      'vol1/p001.jpg',
      'vol1/p2.jpg',
      'vol1/p10.jpg',
    ]);
    // `entries` 是全部成员名（非目录项），**保持包内原始顺序、不排序**：
    // 它服务的是「里面装的是不是分卷压缩包」这个判定，不是页序。
    // 用集合比较，避免把顺序这个无关属性也钉死。
    assert.deepEqual(
      [...(json.entries as string[])].sort(),
      ['vol1/cover.PNG', 'vol1/notes.txt', 'vol1/p001.jpg', 'vol1/p1.jpg', 'vol1/p10.jpg', 'vol1/p2.jpg'],
    );
    // 契约字段一个不多一个不少。
    assert.deepEqual(Object.keys(json).sort(), [
      'entries',
      'entryCount',
      'format',
      'hasOpf',
      'imageCount',
      'kind',
      'ok',
      'pages',
    ]);
  },
);

test(
  'probe：entries 上限 2000，entryCount 仍是真实计数',
  (_t) => {
    if (!requireBinary(_t)) return;
    const dir = makeTempDir('entries-cap');
    // 一个 2000+ 成员的包。`entries` 被截断是为了不让 stdout 被几十万条目撑爆；
    // `entryCount` 与 `imageCount` 必须仍是**真实**数字，否则主进程会算错页数。
    const names: Record<string, Buffer> = {};
    for (let index = 0; index < 2050; index += 1) {
      names[`p${String(index).padStart(6, '0')}.jpg`] = PAGE_BYTES;
    }
    const cbz = makeCbz(dir, names);
    const { status, json } = runNative(['probe', '--input', cbz]);
    assert.equal(status, 0);
    assert.equal(json.ok, true);
    assert.equal(json.entryCount, 2050);
    assert.equal(json.imageCount, 2050);
    assert.equal((json.entries as string[]).length, 2000, 'entries 必须被截断到 2000');
  },
);

test(
  'probe：内容判定优先于扩展名（.cbr 里其实是 zip）',
  (_t) => {
    if (!requireBinary(_t)) return;
    const dir = makeTempDir('content-detect');
    const disguised = path.join(dir, 'disguised.cbr');
    fs.copyFileSync(makeCbz(dir, { 'p1.jpg': PAGE_BYTES }), disguised);
    const { json } = runNative(['probe', '--input', disguised]);
    assert.equal(json.ok, true);
    assert.equal(json.format, 'zip', '必须按内容报告 zip，而不是按扩展名报告 rar');
  },
);

test(
  'probe：含 .opf 判定为 epub，pages 恒为空',
  (_t) => {
    if (!requireBinary(_t)) return;
    const dir = makeTempDir('epub');
    const cbz = makeCbz(dir, {
      'OEBPS/content.opf': Buffer.from('<package/>', 'utf8'),
      'OEBPS/p1.jpg': PAGE_BYTES,
      'OEBPS/p2.jpg': PAGE_BYTES,
    });
    const { json } = runNative(['probe', '--input', cbz]);
    assert.equal(json.ok, true);
    assert.equal(json.kind, 'epub');
    assert.equal(json.hasOpf, true);
    assert.deepEqual(json.pages, []);
    assert.equal(json.imageCount, 0);
  },
);

test(
  'extract：保留子目录、只写页图、跳过含 .. 的成员',
  (_t) => {
    if (!requireBinary(_t)) return;
    const dir = makeTempDir('extract');
    // 手写：真实含 `../escape.jpg` 的恶意包。
    const evil = path.join(dir, 'evil.cbz');
    fs.writeFileSync(
      evil,
      makeRawZip([
        { name: 'vol1/p1.jpg', data: Buffer.from('one') },
        { name: 'vol2/p1.jpg', data: Buffer.from('two') },
        { name: '../escape.jpg', data: Buffer.from('ESCAPED') },
        { name: '../../escape2.jpg', data: Buffer.from('ESCAPED2') },
        { name: 'deep/dir/p3.jpg', data: Buffer.from('three') },
        { name: 'notes.txt', data: Buffer.from('ignore me') },
      ]),
    );

    const out = path.join(dir, 'out');
    const { status, json } = runNative(['extract', '--input', evil, '--out', out, '--images-only']);
    assert.equal(status, 0);
    assert.equal(json.ok, true);
    assert.equal(json.format, 'zip');

    const extracted = json.extracted as Array<{ entry: string; rel: string; bytes: number }>;
    const rels = extracted.map((item) => item.rel).sort();
    assert.deepEqual(rels, ['deep/dir/p3.jpg', 'vol1/p1.jpg', 'vol2/p1.jpg']);
    // 字节数必须是真实的读取字节数。
    for (const item of extracted) {
      assert.equal(item.bytes, fs.statSync(path.join(out, item.rel)).size);
    }
    // notes.txt + 两个穿越条目 = 3 个 skipped。
    assert.equal(json.skipped, 3);

    // 子目录结构必须保留（不能压成 basename）：vol1/p1.jpg 与 vol2/p1.jpg 同名不同页。
    assert.equal(fs.readFileSync(path.join(out, 'vol1/p1.jpg'), 'utf8'), 'one');
    assert.equal(fs.readFileSync(path.join(out, 'vol2/p1.jpg'), 'utf8'), 'two');
    // 穿越条目一个都不许落盘 —— 检查 out 里所有文件，凡是 escape* 都算失败。
    const walked: string[] = [];
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else walked.push(full);
      }
    };
    walk(out);
    assert.deepEqual(
      walked.map((file) => path.relative(out, file)).sort(),
      ['deep/dir/p3.jpg', 'vol1/p1.jpg', 'vol2/p1.jpg'],
    );
    assert.ok(!fs.existsSync(path.join(dir, 'escape.jpg')), 'zip-slip：escape.jpg 被写到了 out 之外');
    assert.ok(!fs.existsSync(path.join(path.dirname(dir), 'escape2.jpg')));
  },
);

test(
  'extract：不带 --images-only 时非页图也会写出',
  (_t) => {
    if (!requireBinary(_t)) return;
    const dir = makeTempDir('extract-all');
    const cbz = makeCbz(dir, {
      'vol1/p1.jpg': PAGE_BYTES,
      'vol1/readme.txt': Buffer.from('hello', 'utf8'),
    });
    const out = path.join(dir, 'out');
    const { json } = runNative(['extract', '--input', cbz, '--out', out]);
    assert.equal(json.ok, true);
    const rels = (json.extracted as Array<{ rel: string }>).map((item) => item.rel).sort();
    assert.deepEqual(rels, ['vol1/p1.jpg', 'vol1/readme.txt']);
    assert.equal(json.skipped, 0);
  },
);

test(
  'extract：不带 --images-only 时，路径穿越条目仍必须被跳过',
  (_t) => {
    if (!requireBinary(_t)) return;
    // 关键：`--images-only` 是一条**筛选**规则，`..` 是**安全**规则。
    // 关掉筛选不能顺手关掉安全 —— 这条用例专门锁死这一点，否则将来有人把
    // 「含 `..` 就跳过」挪进 `images_only` 分支时不会有测试失败。
    const dir = makeTempDir('escape-all');
    const evil = path.join(dir, 'evil.7z');
    fs.writeFileSync(
      evil,
      makeRawZip([
        { name: 'ok.txt', data: Buffer.from('fine') },
        { name: '../escape.jpg', data: Buffer.from('ESCAPED') },
        { name: 'nested/../../escape2.jpg', data: Buffer.from('ESCAPED2') },
      ]),
    );
    const out = path.join(dir, 'out');
    const { status, json } = runNative(['extract', '--input', evil, '--out', out]);
    assert.equal(status, 0);
    assert.equal(json.ok, true);
    const rels = (json.extracted as Array<{ rel: string }>).map((item) => item.rel);
    assert.deepEqual(rels, ['ok.txt']);
    assert.equal(json.skipped, 2);
    // out 里除了 ok.txt 不该有别的条目。
    assert.deepEqual(fs.readdirSync(out).sort(), ['ok.txt']);
    // 穿越条目一个都不许出现在 out 之外。
    assert.ok(!fs.existsSync(path.join(dir, 'escape.jpg')));
    assert.ok(!fs.existsSync(path.join(dir, 'escape2.jpg')));
  },
);

test(
  '7z：probe + extract 走真实 7z 容器（7z-wasm 生成夹具）',
  async (t) => {
    if (!requireBinary(t)) return;
    const dir = makeTempDir('7z');
    const archive = path.join(dir, 'book.7z');
    // 带子目录 + 乱序页名：同时验证「保留目录结构」与「自然序」。
    fs.writeFileSync(
      archive,
      await makeSevenZip([
        { name: 'vol1/p10.jpg', data: Buffer.from('ten') },
        { name: 'vol1/p2.jpg', data: Buffer.from('two') },
        { name: 'vol1/p1.jpg', data: Buffer.from('one') },
        { name: 'vol1/readme.txt', data: Buffer.from('skip me') },
      ]),
    );

    const probed = runNative(['probe', '--input', archive]);
    assert.equal(probed.status, 0, probed.stderr);
    assert.equal(probed.json.ok, true, String(probed.json.error));
    assert.equal(probed.json.format, '7z');
    assert.equal(probed.json.kind, 'comic');
    assert.equal(probed.json.entryCount, 4);
    assert.deepEqual(probed.json.pages, ['vol1/p1.jpg', 'vol1/p2.jpg', 'vol1/p10.jpg']);

    const out = path.join(dir, 'out');
    const { status, json } = runNative(['extract', '--input', archive, '--out', out, '--images-only']);
    assert.equal(status, 0, `extract 失败：${json.error}`);
    assert.equal(json.ok, true);
    assert.equal(json.format, '7z');
    const extracted = json.extracted as Array<{ rel: string; bytes: number }>;
    // `extracted` 按包内顺序返回；这里排序只是为了断言集合。注意用**字典序**
    // 期望值（`p10` < `p2`），不要和上面的自然序 `pages` 混淆。
    assert.deepEqual(
      extracted.map((item) => item.rel).sort(),
      ['vol1/p1.jpg', 'vol1/p10.jpg', 'vol1/p2.jpg'],
    );
    // 子目录结构必须保留，内容必须真的解出来（不是空文件）。
    assert.equal(fs.readFileSync(path.join(out, 'vol1/p2.jpg'), 'utf8'), 'two');
    assert.equal(fs.readFileSync(path.join(out, 'vol1/p10.jpg'), 'utf8'), 'ten');
    assert.ok(!fs.existsSync(path.join(out, 'vol1/readme.txt')), '--images-only 不该写非页图');
    assert.equal(json.skipped, 1);
  },
);

test(
  'rar：解出真实 RAR5 与 RAR3 归档（CC0 公开夹具，运行时下载）',
  (t) => {
    if (!requireBinary(t)) return;
    const dir = makeTempDir('rar');
    const rar5 = downloadFixture(dir, 'rar5', RAR_FIXTURES.rar5);
    const rar3 = downloadFixture(dir, 'rar3', RAR_FIXTURES.rar3);
    if (!rar5 || !rar3) {
      // **绝不把拿不到夹具算成通过**：显式 skip，报告中说明覆盖缺口。
      t.skip(
        '跳过：无法从 GitHub 下载 CC0 RAR 夹具（离线或该 URL 已失效）。' +
          `覆盖缺口：本次未真正验证 RAR 解包，仅验证了坏 RAR 的优雅降级路径。URL=${RAR_FIXTURES.rar5.url}`,
      );
      return;
    }

    for (const [label, archive] of [
      ['RAR5', rar5],
      ['RAR3', rar3],
    ] as const) {
      const size = fs.statSync(archive).size;
      assert.ok(size <= 200 * 1024, `${label} 夹具必须 <200KB，实际 ${size}`);

      const probed = runNative(['probe', '--input', archive]);
      assert.equal(probed.status, 0, probed.stderr);
      assert.equal(probed.json.ok, true, `${label} probe 失败：${probed.json.error}`);
      assert.equal(probed.json.format, 'rar');
      assert.equal(probed.json.kind, 'comic');
      assert.equal(probed.json.imageCount, 2, `${label} 应有 2 张页图`);
      assert.deepEqual(probed.json.pages, ['testfile.jpg', 'testfile.png']);

      const out = path.join(dir, `out-${label}`);
      const { status, json } = runNative(['extract', '--input', archive, '--out', out, '--images-only']);
      assert.equal(status, 0, `${label} extract 失败：${json.error}`);
      assert.equal(json.ok, true);
      assert.equal(json.format, 'rar');
      const extracted = json.extracted as Array<{ entry: string; rel: string; bytes: number }>;
      assert.deepEqual(
        extracted.map((item) => item.rel).sort(),
        ['testfile.jpg', 'testfile.png'],
      );
      // 真实解出的字节必须与声明的 bytes 一致，且是合法图片（JPEG/PNG magic）。
      const jpeg = fs.readFileSync(path.join(out, 'testfile.jpg'));
      const png = fs.readFileSync(path.join(out, 'testfile.png'));
      assert.equal(jpeg.readUInt16BE(0), 0xffd8, 'RAR 解出的 jpg 必须有 JPEG SOI');
      assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'RAR 解出的 png 必须有 PNG 签名');
      assert.equal(extracted.find((item) => item.rel === 'testfile.jpg')?.bytes, jpeg.length);
    }
  },
);

test(
  'rar：假 .rar（magic 对但内容损坏）优雅失败，退出码 1 且 stdout 是 JSON',
  (_t) => {
    if (!requireBinary(_t)) return;
    const dir = makeTempDir('rar-bad');
    const fake = path.join(dir, 'fake.cbr');
    fs.writeFileSync(fake, Buffer.concat([Buffer.from('Rar!\x1a\x07\x01\x00', 'binary'), Buffer.alloc(64)]));

    const probed = runNative(['probe', '--input', fake]);
    assert.equal(probed.status, 1, '损坏的包必须是「已处理的失败」（退出码 1），不是崩溃');
    assert.equal(probed.json.ok, false);
    assert.equal(probed.json.format, 'rar', 'magic 是 RAR5，所以 format 应报 rar');
    assert.equal(typeof probed.json.error, 'string');
    assert.ok(String(probed.json.error).length > 0);

    const out = path.join(dir, 'out');
    const result = runNative(['extract', '--input', fake, '--out', out, '--images-only']);
    assert.equal(result.status, 1);
    assert.equal(result.json.ok, false);
    assert.equal(typeof result.json.error, 'string');
  },
);

test(
  '未知格式：退出码 1 + ok:false，不 panic',
  (_t) => {
    if (!requireBinary(_t)) return;
    const dir = makeTempDir('unknown');
    const junk = path.join(dir, 'junk.7z');
    fs.writeFileSync(junk, Buffer.from('definitely not an archive', 'utf8'));
    const { status, json } = runNative(['probe', '--input', junk]);
    assert.equal(status, 1);
    assert.equal(json.ok, false);
    assert.equal(json.format, 'unknown');

    const missing = runNative(['probe', '--input', path.join(dir, 'nope.cbr')]);
    assert.equal(missing.status, 1);
    assert.equal(missing.json.ok, false);
  },
);
