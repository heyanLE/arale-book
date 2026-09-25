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

import { ExtensionService, parseCatalog, parseManifest, resolveInside } from '../src/main/extensions/service';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arale-ext-'));
}

// ---------------------------------------------------------------------------
// 清单校验
// ---------------------------------------------------------------------------

const VALID_ENTRY = {
  id: 'ocr-manga-anki',
  name: 'manga-anki OCR',
  version: '1.0.0',
  kind: 'ocr-engine',
  provides: 'manga-anki',
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

test('parseCatalog: 接受合法清单', () => {
  const parsed = parseCatalog(catalog([VALID_ENTRY]));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.catalog.extensions.length, 1);
  assert.equal(parsed.catalog.extensions[0]?.provides, 'manga-anki');
  assert.deepEqual(parsed.catalog.extensions[0]?.urls, ['https://example.com/a.zip']);
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
  assert.match(parsed.error, /download/);
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
  const root = '/tmp/ext/ocr-manga-anki';
  assert.equal(resolveInside(root, 'bin/ocr-run'), path.join(root, 'bin/ocr-run'));
  assert.equal(resolveInside(root, './bin/../bin/ocr-run'), path.join(root, 'bin/ocr-run'));
});

test('resolveInside: 拒绝越界、绝对路径与空路径', () => {
  const root = '/tmp/ext/ocr-manga-anki';
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
  // `/tmp/ext/ocr-manga-ankievil` 以 `/tmp/ext/ocr-manga-anki` 开头，
  // 朴素的 startsWith 检查会放它过去。
  const root = '/tmp/ext/ocr-manga-anki';
  assert.equal(resolveInside(root, '../ocr-manga-ankievil/x'), null);
});

// ---------------------------------------------------------------------------
// 自描述校验
// ---------------------------------------------------------------------------

test('parseManifest: 接受带 runner 的自描述', () => {
  const parsed = parseManifest({
    id: 'ocr-manga-anki',
    version: '1.0.0',
    kind: 'ocr-engine',
    provides: 'manga-anki',
    engine: { label: 'manga-anki', requirement: '需要 1.6 GB 磁盘', downloadSizeMb: 0 },
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

  const result = await service.install('ocr-manga-anki');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /sha256/);
});

test('install: 平台不支持 → 拒绝，且不去联网（所以这里能秒回）', async () => {
  const root = makeRoot();
  const bundled = path.join(root, 'bundled.json');
  const onlyWindows = process.platform === 'darwin' ? 'win32' : 'darwin';
  fs.writeFileSync(bundled, catalog([{ ...VALID_ENTRY, platforms: [onlyWindows] }]), 'utf8');
  const service = new ExtensionService({ root: path.join(root, 'ext'), bundledCatalogFile: bundled });

  const result = await service.install('ocr-manga-anki');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /只支持/);
});

test('remove: 不存在的扩展也返回成功（幂等），并清掉记录', () => {
  const root = makeRoot();
  const bundled = path.join(root, 'bundled.json');
  fs.writeFileSync(bundled, catalog([VALID_ENTRY]), 'utf8');
  const service = new ExtensionService({ root: path.join(root, 'ext'), bundledCatalogFile: bundled });

  const result = service.remove('ocr-manga-anki');
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
