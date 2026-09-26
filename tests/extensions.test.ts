/**
 * 扩展基础设施的单测：清单校验、路径越界防护、安装记录。
 *
 * 这一层处理的是**从网上取回来的、不可信的数据**，所以测试的重点不是「正常情况能跑」，
 * 而是「坏输入会不会造成伤害」：
 *
 * - 清单里的 `sha256` 缺失或格式不对 → 必须拒绝安装（没有校验的下载器等于让远端
 *   决定用户磁盘上跑什么代码）；
 * - `extension.json` 里的 runner 路径指到扩展目录外 → 必须拒绝（否则篡改清单就能
 *   让应用执行系统上任意程序）；
 * - 坏的远端清单 → 不能覆盖掉本地缓存（否则扩展页面会凭空空掉）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import {
  ExtensionService,
  DEFAULT_CATALOG_URL,
  parseCatalog,
  parseRepository,
  parseManifest,
  parseRelease,
  resolveInside,
} from '../src/main/extensions/service';
import { platformKey, releaseAssetUrl, resolveDownload } from '../src/shared/extensions';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arale-ext-'));
}

// ---------------------------------------------------------------------------
// 清单校验
// ---------------------------------------------------------------------------

const VALID_ENTRY = {
  id: 'ocr-arale_onnx_v1',
  name: 'arale_onnx_v1 OCR',
  version: '1.0.0',
  kind: 'ocr-engine',
  provides: 'arale_onnx_v1',
  summary: 'mokuro 管线',
  platforms: ['darwin'],
  arch: ['arm64'],
  urls: ['https://example.com/a.zip'],
  bytes: 700,
  sha256: 'a'.repeat(64),
  installedBytes: 1600,
  license: 'GPL-3.0',
  homepage: 'https://example.com',
  requires: [],
  notes: '',
};

function catalog(entries: unknown[], schemaVersion = 1): string {
  return JSON.stringify({ schemaVersion, generatedAt: '2026-01-01T00:00:00Z', extensions: entries });
}

test('JSONL 仓库逐行解析，坏行拒绝且不接受重复 id', () => {
  assert.equal(parseRepository(`${JSON.stringify(VALID_ENTRY)}\n`).ok, true);
  assert.equal(parseRepository(`${JSON.stringify(VALID_ENTRY)}\n{`).ok, false);
  assert.equal(parseRepository(`${JSON.stringify(VALID_ENTRY)}\n${JSON.stringify(VALID_ENTRY)}`).ok, false);
});

test('仓库管理默认包含官方 JSONL，可添加与移除 HTTPS 仓库', () => {
  const root = makeRoot();
  try {
    const service = new ExtensionService({ root });
    assert.equal(service.repositories().length, 1);
    assert.equal(service.addRepository('示例', 'http://example.com/ocr.jsonl').ok, false);
    assert.equal(service.addRepository('示例', 'https://example.com/ocr.jsonl').ok, true);
    assert.equal(service.repositories().length, 2);
    assert.equal(service.addRepository('重复', 'https://example.com/ocr.jsonl').ok, false);
    assert.equal(service.removeRepository('https://example.com/ocr.jsonl').ok, true);
    assert.equal(service.repositories().length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('调试目录优先于远端缓存，直接加载且不会被卸载', () => {
  const root = makeRoot();
  try {
    const dev = path.join(root, 'dev');
    fs.mkdirSync(dev);
    fs.writeFileSync(path.join(dev, 'extension.json'), JSON.stringify({
      id: 'ocr-arale_onnx_v1', version: '0.2.0', kind: 'ocr-engine', provides: 'arale_onnx_v1',
      runner: { program: 'python/bin/python3', args: [], env: {} },
    }));
    const repo = path.join(root, 'default.jsonl');
    fs.writeFileSync(repo, `${JSON.stringify({ ...VALID_ENTRY, version: '0.2.0' })}\n`);
    const service = new ExtensionService({ root: path.join(root, 'installed'), localRepositoryFile: repo, debugExtensionDir: dev, preferLocalRepository: true });
    assert.equal(service.loadCatalog().source, 'bundled');
    assert.equal(service.installed()[0]?.local, true);
    assert.equal(service.installDir('ocr-arale_onnx_v1'), dev);
    assert.equal(service.remove('ocr-arale_onnx_v1').ok, false);
    assert.ok(fs.existsSync(path.join(dev, 'extension.json')));
    const cacheDir = path.join(root, 'installed', 'repositories');
    fs.mkdirSync(cacheDir, { recursive: true });
    const cache = path.join(cacheDir, `${crypto.createHash('sha256').update(DEFAULT_CATALOG_URL).digest('hex')}.jsonl`);
    fs.writeFileSync(cache, `${JSON.stringify({ ...VALID_ENTRY, version: '0.1.0' })}\n`);
    const release = new ExtensionService({ root: path.join(root, 'installed'), localRepositoryFile: repo });
    assert.equal(release.loadCatalog().catalog.extensions[0]?.version, '0.2.0', '随包新版盖过旧缓存');
    fs.writeFileSync(cache, `${JSON.stringify({ ...VALID_ENTRY, version: '0.3.0' })}\n`);
    assert.equal(release.loadCatalog().catalog.extensions[0]?.version, '0.3.0', '远端新版盖过随包索引');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('parseCatalog: 接受合法清单', () => {
  const parsed = parseCatalog(catalog([VALID_ENTRY]));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.catalog.extensions.length, 1);
  assert.equal(parsed.catalog.extensions[0]?.provides, 'arale_onnx_v1');
  assert.deepEqual(parsed.catalog.extensions[0]?.urls, ['https://example.com/a.zip']);
});

test('parseCatalog: 保留可选的 macOS 最低版本', () => {
  const parsed = parseCatalog(catalog([{ ...VALID_ENTRY, minMacOS: 14 }]));
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.catalog.extensions[0]?.minMacOS, 14);
});

test('parseCatalog: schemaVersion 不认就拒绝（而不是半懂不懂地解析）', () => {
  const parsed = parseCatalog(catalog([VALID_ENTRY], 99));
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.error, /schemaVersion/);
});

test('parseCatalog: 坏 JSON / 顶层不是对象 → 拒绝', () => {
  assert.equal(parseCatalog('{').ok, false);
  assert.equal(parseCatalog('[]').ok, false);
  assert.equal(parseCatalog('null').ok, false);
});

test('parseCatalog: 缺 id / name / version / provides / kind → 拒绝', () => {
  for (const field of ['id', 'name', 'version', 'provides', 'kind']) {
    const broken = { ...VALID_ENTRY, [field]: undefined };
    const parsed = parseCatalog(catalog([broken]));
    assert.equal(parsed.ok, false, `缺 ${field} 时应拒绝`);
  }
});

test('parseCatalog: id 重复 → 拒绝（否则安装哪个是不确定的）', () => {
  const parsed = parseCatalog(catalog([VALID_ENTRY, VALID_ENTRY]));
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.error, /重复/);
});

test('parseCatalog: 没有下载地址 → 拒绝', () => {
  const parsed = parseCatalog(catalog([{ ...VALID_ENTRY, urls: [] }]));
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.error, /下载地址/);
});

test('parseCatalog: extensions 不是数组 → 拒绝', () => {
  const parsed = parseCatalog('{"schemaVersion":1,"extensions":{}}');
  assert.equal(parsed.ok, false);
});

test('parseCatalog: sha256 缺失时**仍然解析成功**，由安装时拒绝', () => {
  // 校验分工：格式校验在解析层，安全策略在安装层。分开是为了让「清单能用但这一条
  // 不能装」这种状态可表达，而不是让一条坏记录毒掉整份清单。
  const parsed = parseCatalog(catalog([{ ...VALID_ENTRY, sha256: undefined }]));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.catalog.extensions[0]?.sha256, '');
});

// ---------------------------------------------------------------------------
// 路径越界防护
// ---------------------------------------------------------------------------

test('resolveInside: 正常相对路径解析到根内', () => {
  const root = '/tmp/ext/ocr-arale_onnx_v1';
  assert.equal(resolveInside(root, 'bin/ocr-run'), path.join(root, 'bin/ocr-run'));
  assert.equal(resolveInside(root, './bin/../bin/ocr-run'), path.join(root, 'bin/ocr-run'));
});

test('resolveInside: 拒绝越界、绝对路径与空路径', () => {
  const root = '/tmp/ext/ocr-arale_onnx_v1';
  for (const evil of [
    '../evil.sh',
    '../../../../bin/sh',
    'bin/../../evil.sh',
    '/bin/sh',
    '',
  ]) {
    assert.equal(resolveInside(root, evil), null, `必须拒绝：${JSON.stringify(evil)}`);
  }
});

test('resolveInside: 前缀相同但不是子目录的路径要被拒绝', () => {
  // `/tmp/ext/ocr-arale_onnx_v1evil` 以 `/tmp/ext/ocr-arale_onnx_v1` 开头，
  // 朴素的 startsWith 检查会放它过去。
  const root = '/tmp/ext/ocr-arale_onnx_v1';
  assert.equal(resolveInside(root, '../ocr-manga-ankievil/x'), null);
});

// ---------------------------------------------------------------------------
// 自描述校验
// ---------------------------------------------------------------------------

test('parseManifest: 接受带 runner 的自描述', () => {
  const parsed = parseManifest({
    id: 'ocr-arale_onnx_v1',
    version: '1.0.0',
    kind: 'ocr-engine',
    provides: 'arale_onnx_v1',
    engine: { label: 'arale_onnx_v1', requirement: '需要 1.6 GB 磁盘', downloadSizeMb: 0 },
    runner: { program: 'bin/ocr-run', args: ['--pages-file', '{pagesFile}'], env: { FOO: '1' } },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.manifest.runner?.program, 'bin/ocr-run');
  assert.deepEqual(parsed.manifest.runner?.args, ['--pages-file', '{pagesFile}']);
  assert.deepEqual(parsed.manifest.runner?.env, { FOO: '1' });
});

test('parseManifest: 缺 id/version/provides 或 runner 缺 program → 拒绝', () => {
  assert.equal(parseManifest({ version: '1', provides: 'x' }).ok, false);
  assert.equal(parseManifest({ id: 'a', provides: 'x' }).ok, false);
  assert.equal(parseManifest({ id: 'a', version: '1' }).ok, false);
  assert.equal(parseManifest({ id: 'a', version: '1', provides: 'x', runner: {} }).ok, false);
});

// ---------------------------------------------------------------------------
// 服务：清单回退与安装记录
// ---------------------------------------------------------------------------

test('loadCatalog: 远端缓存缺失时回退到随包清单，都不在时给空清单而不抛', () => {
  const root = makeRoot();
  const bundled = path.join(root, 'bundled.json');
  const service = new ExtensionService({ root: path.join(root, 'ext'), bundledCatalogFile: bundled });

  // 两个都没有 → 空清单 + 说明，而不是抛。
  const none = service.loadCatalog();
  assert.equal(none.source, 'none');
  assert.deepEqual(none.catalog.extensions, []);
  assert.ok(none.error !== null);

  // 有随包清单 → 用它。
  fs.writeFileSync(bundled, catalog([VALID_ENTRY]), 'utf8');
  const fromBundled = service.loadCatalog();
  assert.equal(fromBundled.source, 'bundled');
  assert.equal(fromBundled.catalog.extensions.length, 1);

  // 有缓存 → 优先缓存。
  fs.mkdirSync(path.join(root, 'ext'), { recursive: true });
  fs.writeFileSync(
    service.catalogCacheFile(),
    catalog([{ ...VALID_ENTRY, version: '2.0.0' }]),
    'utf8',
  );
  const fromCache = service.loadCatalog();
  assert.equal(fromCache.source, 'cache');
  assert.equal(fromCache.catalog.extensions[0]?.version, '2.0.0');
});

test('list: 拼出「能不能装」并说明不支持的原因', () => {
  const root = makeRoot();
  const bundled = path.join(root, 'bundled.json');
  // 造一条明确不支持当前平台的记录。
  fs.writeFileSync(
    bundled,
    catalog([{ ...VALID_ENTRY, platforms: ['win32'], arch: ['x64'] }]),
    'utf8',
  );
  const service = new ExtensionService({ root: path.join(root, 'ext'), bundledCatalogFile: bundled });
  const { statuses } = service.list();
  assert.equal(statuses.length, 1);
  const status = statuses[0]!;
  assert.equal(status.installed, null);
  assert.equal(status.updateAvailable, false);
  if (process.platform !== 'win32') {
    assert.equal(status.supported, false, '平台不匹配时必须判为不支持');
    assert.ok((status.unsupportedReason ?? '').length > 0, '不支持时必须给出原因');
  }
});

test('install: 清单里没有这个 id → 明确的失败，不是抛', async () => {
  const root = makeRoot();
  const bundled = path.join(root, 'bundled.json');
  fs.writeFileSync(bundled, catalog([VALID_ENTRY]), 'utf8');
  const service = new ExtensionService({ root: path.join(root, 'ext'), bundledCatalogFile: bundled });

  const result = await service.install('不存在的扩展');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /清单里没有/);
});

test('install: 没有有效 sha256 → 拒绝安装（这是安全红线）', async () => {
  const root = makeRoot();
  const bundled = path.join(root, 'bundled.json');
  fs.writeFileSync(bundled, catalog([{ ...VALID_ENTRY, sha256: '太短' }]), 'utf8');
  const service = new ExtensionService({ root: path.join(root, 'ext'), bundledCatalogFile: bundled });

  const result = await service.install('ocr-arale_onnx_v1');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /sha256/);
});

test('install: 平台不支持 → 拒绝，且不去联网（所以这里能秒回）', async () => {
  const root = makeRoot();
  const bundled = path.join(root, 'bundled.json');
  const onlyWindows = process.platform === 'darwin' ? 'win32' : 'darwin';
  fs.writeFileSync(bundled, catalog([{ ...VALID_ENTRY, platforms: [onlyWindows] }]), 'utf8');
  const service = new ExtensionService({ root: path.join(root, 'ext'), bundledCatalogFile: bundled });

  const result = await service.install('ocr-arale_onnx_v1');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /只支持/);
});

test('remove: 不存在的扩展也返回成功（幂等），并清掉记录', () => {
  const root = makeRoot();
  const bundled = path.join(root, 'bundled.json');
  fs.writeFileSync(bundled, catalog([VALID_ENTRY]), 'utf8');
  const service = new ExtensionService({ root: path.join(root, 'ext'), bundledCatalogFile: bundled });

  const result = service.remove('ocr-arale_onnx_v1');
  assert.equal(result.ok, true);
  assert.deepEqual(service.installed(), []);
});

test('installDir: id 里的路径分隔符被净化，不能借 id 跳目录', () => {
  const root = makeRoot();
  const service = new ExtensionService({
    root: path.join(root, 'ext'),
    bundledCatalogFile: path.join(root, 'bundled.json'),
  });
  const dir = service.installDir('../../evil');
  assert.ok(
    path.resolve(dir).startsWith(path.resolve(service.root()) + path.sep),
    `安装目录必须落在扩展根内：${dir}`,
  );
  assert.ok(!dir.includes('..'), dir);
});

// ---------------------------------------------------------------------------
// 清单只写「哪个 release 的哪个包」，地址由应用拼（一个能力一条条目，平台差异在 assets 里）
// ---------------------------------------------------------------------------

/** 一个「Release 分发」的条目：没有 urls，只有 release.assets。 */
const RELEASE_ENTRY = {
  ...VALID_ENTRY,
  platforms: ['darwin', 'win32'],
  arch: ['arm64', 'x64'],
  urls: [],
  bytes: 0,
  sha256: '',
  release: {
    repo: 'heyanLE/arale-book-ocr-manga',
    tag: 'v0.1.0',
    assets: {
      'darwin-arm64': { asset: 'arale_onnx_v1-macos-arm64.zip', sha256: 'b'.repeat(64), bytes: 170_000_000 },
      'win32-x64': { asset: 'arale_onnx_v1-windows-x64.zip', sha256: 'c'.repeat(64), bytes: 175_000_000 },
    },
  },
};

test('parseCatalog: 没有 urls 但有 release{repo,tag,assets} → 接受（这才是默认分发形态）', () => {
  const parsed = parseCatalog(catalog([RELEASE_ENTRY]));
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error);
  if (!parsed.ok) return;
  const entry = parsed.catalog.extensions[0];
  assert.equal(entry?.release?.tag, 'v0.1.0');
  assert.deepEqual(Object.keys(entry?.release?.assets ?? {}).sort(), ['darwin-arm64', 'win32-x64']);
});

test('resolveDownload: 按平台挑包，URL 与校验值都跟包走', () => {
  const entry = { urls: [], release: RELEASE_ENTRY.release, sha256: '', bytes: 0, installedBytes: 0 };
  const mac = resolveDownload(entry, 'darwin', 'arm64');
  assert.equal(mac.source, 'release');
  assert.deepEqual(mac.urls, [
    'https://github.com/heyanLE/arale-book-ocr-manga/releases/download/v0.1.0/arale_onnx_v1-macos-arm64.zip',
  ]);
  assert.equal(mac.sha256, 'b'.repeat(64), 'sha256 跟着**这个包**，不是条目顶层的');
  assert.equal(mac.bytes, 170_000_000);

  const win = resolveDownload(entry, 'win32', 'x64');
  assert.match(win.urls[0] ?? '', /windows-x64\.zip$/);
  assert.equal(win.sha256, 'c'.repeat(64));

  // 没有这个平台的包 → 明确「没有地址」，而不是拿去下载 undefined
  const linux = resolveDownload(entry, 'linux', 'x64');
  assert.deepEqual(linux.urls, []);
  assert.equal(linux.source, 'none');
});

test('resolveDownload: 手写的 urls 是镜像，排在 release 前面，但校验值仍取这个平台的包', () => {
  const entry = {
    urls: ['https://mirror.example.com/a.zip'],
    release: RELEASE_ENTRY.release,
    sha256: '',
    bytes: 0,
    installedBytes: 0,
  };
  const resolved = resolveDownload(entry, 'darwin', 'arm64');
  assert.equal(resolved.source, 'urls');
  assert.deepEqual(resolved.urls, [
    'https://mirror.example.com/a.zip',
    'https://github.com/heyanLE/arale-book-ocr-manga/releases/download/v0.1.0/arale_onnx_v1-macos-arm64.zip',
  ]);
  assert.equal(resolved.sha256, 'b'.repeat(64));
});

test('resolveDownload: 没有 release 的老条目仍然能用（顶层 urls + sha256）', () => {
  const resolved = resolveDownload(
    { urls: ['https://example.com/a.zip'], sha256: 'd'.repeat(64), bytes: 5, installedBytes: 9 },
    'darwin',
    'arm64',
  );
  assert.deepEqual(resolved.urls, ['https://example.com/a.zip']);
  assert.equal(resolved.sha256, 'd'.repeat(64));
  assert.equal(resolved.installedBytes, 9);
});

test('releaseAssetUrl / platformKey: 形状稳定（改它们等于改分发地址）', () => {
  assert.equal(
    releaseAssetUrl('o/r', 'v1', 'a b.zip'),
    'https://github.com/o/r/releases/download/v1/a%20b.zip',
  );
  assert.equal(platformKey('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(platformKey('win32', 'x64'), 'win32-x64');
});

test('parseRelease: 坏形状逐个拒绝（远端清单是不可信输入）', () => {
  const bad = (value: unknown) => parseRelease(value, 'x');
  assert.deepEqual(bad('nope'), { error: 'x 的 release 不是对象' });
  assert.match(String((bad({ tag: 'v1', assets: { 'darwin-arm64': { asset: 'a.zip' } } }) as { error: string }).error), /owner\/repo/);
  assert.match(String((bad({ repo: 'o/r', assets: { 'darwin-arm64': { asset: 'a.zip' } } }) as { error: string }).error), /缺 tag/);
  assert.match(String((bad({ repo: 'o/r', tag: 'v1' }) as { error: string }).error), /缺 assets/);
  // 包名不能带路径（清单是远端来的，地址里不许塞路径）
  for (const asset of ['../evil.zip', 'a/b.zip', 'a\\b.zip']) {
    const result = bad({ repo: 'o/r', tag: 'v1', assets: { 'darwin-arm64': { asset } } });
    assert.match(String((result as { error: string }).error), /只能是文件名/, asset);
  }
  assert.match(
    String((bad({ repo: 'o/r', tag: 'v1', assets: { BADKEY: { asset: 'a.zip' } } }) as { error: string }).error),
    /<platform>-<arch>/,
  );
  assert.match(
    String((bad({ repo: 'o/r', tag: 'v1', assets: { 'darwin-arm64': { asset: 'a.zip', sha256: 'xyz' } } }) as { error: string }).error),
    /sha256/,
  );
  // 空 sha 是**允许**的：表示「归档还没发布」，由安装时拒绝（而不是清单解析失败）
  const pending = bad({ repo: 'o/r', tag: 'v1', assets: { 'darwin-arm64': { asset: 'a.zip', sha256: '' } } });
  assert.equal(Array.isArray(pending) ? false : 'assets' in (pending as object), true);
});
