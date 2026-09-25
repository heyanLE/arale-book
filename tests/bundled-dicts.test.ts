/**
 * 随包内嵌词典的**数据可用性**测试。
 *
 * 这类测试的价值在于：清单里写着一个文件名，和「这个文件真的能被我们自己的解析器
 * 读进来」是两件事。ship 一份读不出来的数据比不 ship 更糟——用户看到词典列表里
 * 有一部词典，点开却什么都查不到，只会以为功能坏了。
 *
 * 所以这里用**真实的 DictionaryStore** 逐个导入 `resources/dictionaries/` 里的每个包，
 * 断言它真的产出了词条或频率。顺带守住清单与文件的一致性（sha256、体积）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { installBundledDictionaries, listBundledDictionaries } from '../src/main/dict/bundled';
import { setUserDataRootForTesting } from '../src/main/paths';
import { DictionaryStore } from '../src/core/dict/store';

const ROOT = path.join(__dirname, '..', '..');
const BUNDLED_DIR = path.join(ROOT, 'resources', 'dictionaries');

function makeStore(): { store: DictionaryStore; dir: string; cleanup: () => void } {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-bundled-dict-'));
  setUserDataRootForTesting(temp);
  const dir = path.join(temp, 'dictionaries');
  return {
    store: new DictionaryStore(dir),
    dir,
    cleanup: () => {
      setUserDataRootForTesting(null);
      fs.rmSync(temp, { recursive: true, force: true });
    },
  };
}

test('清单存在、可解析，且每条的 sha256 与文件一致', () => {
  const entries = listBundledDictionaries(BUNDLED_DIR);
  assert.ok(entries.length > 0, '随包词典清单是空的——resources/dictionaries 没进包？');
  let total = 0;
  for (const entry of entries) {
    const file = path.join(BUNDLED_DIR, entry.file);
    assert.ok(fs.existsSync(file), `清单里的文件不存在：${entry.file}`);
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.length, entry.bytes, `${entry.file} 体积与清单不符`);
    assert.equal(
      crypto.createHash('sha256').update(bytes).digest('hex'),
      entry.sha256,
      `${entry.file} 内容变了但清单没更新`,
    );
    assert.ok(entry.source.startsWith('https://'), `${entry.file} 缺来源 URL（分发第三方数据必须可追溯）`);
    assert.ok(entry.license !== '', `${entry.file} 缺许可标识`);
    total += entry.bytes;
  }
  // 内嵌词典必须保持「小」：超过 8 MB 就该走扩展下载，而不是让所有人一起背。
  assert.ok(total < 8 * 1024 * 1024, `内嵌词典总计 ${(total / 1024 / 1024).toFixed(1)} MB，超出内嵌预算`);
});

test('每一个随包词典都能被真实解析器导入，并产出词条或频率', async () => {
  const { store, cleanup } = makeStore();
  try {
    const entries = listBundledDictionaries(BUNDLED_DIR);
    for (const entry of entries) {
      const info = await store.importZip(path.join(BUNDLED_DIR, entry.file));
      assert.equal(info.format, 'yomitan');
      assert.ok(
        info.termCount > 0 || info.freqCount > 0,
        `${entry.file} 导入成功但既没有词条也没有频率（${info.termCount}/${info.freqCount}）——` +
          '这份数据对我们没有价值，不该随包分发',
      );
    }
  } finally {
    cleanup();
  }
});

test('自动安装：首次装上、第二次跳过（按标记文件，不重复导入）', async () => {
  const { store, dir, cleanup } = makeStore();
  try {
    const first = await installBundledDictionaries(BUNDLED_DIR, dir, (zip) => store.importZip(zip));
    const expected = listBundledDictionaries(BUNDLED_DIR).length;
    assert.equal(first.installed.length, expected, JSON.stringify(first));
    assert.deepEqual(first.failed, []);

    const second = await installBundledDictionaries(BUNDLED_DIR, dir, (zip) => store.importZip(zip));
    assert.equal(second.installed.length, 0, '第二次不该重复导入');
    assert.equal(second.skipped.length, expected);
  } finally {
    cleanup();
  }
});

test('用户删掉内嵌词典后，重启不会把它偷偷装回来', async () => {
  // 标记文件记的是「已经提供过」，与当前装没装无关。用户明确删过的东西不该自己回来。
  const { store, dir, cleanup } = makeStore();
  try {
    await installBundledDictionaries(BUNDLED_DIR, dir, (zip) => store.importZip(zip));
    for (const info of store.status().dictionaries) store.remove(info.id);
    assert.equal(store.status().dictionaries.length, 0);

    const again = await installBundledDictionaries(BUNDLED_DIR, dir, (zip) => store.importZip(zip));
    assert.equal(again.installed.length, 0, '不该因为「词典不在了」就重新装');
    assert.equal(store.status().dictionaries.length, 0);
  } finally {
    cleanup();
  }
});

test('清单与文件不一致时不安装（宁可少一部，也不装来路不明的东西）', async () => {
  const { store, dir, cleanup } = makeStore();
  const tampered = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-bundled-tamper-'));
  try {
    const entries = listBundledDictionaries(BUNDLED_DIR);
    // 复制**并改一个字节**：只复制不改的话 sha256 依然相等，这条测试就成了空转。
    const target = path.join(tampered, entries[0]!.file);
    fs.writeFileSync(target, Buffer.concat([fs.readFileSync(path.join(BUNDLED_DIR, entries[0]!.file)), Buffer.from('x')]));
    fs.writeFileSync(
      path.join(tampered, 'manifest.json'),
      JSON.stringify({ dictionaries: [entries[0]] }),
      'utf8',
    );
    const result = await installBundledDictionaries(tampered, dir, (zip) => store.importZip(zip));
    assert.equal(result.installed.length, 0);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0]!.error, /sha256/);
  } finally {
    fs.rmSync(tampered, { recursive: true, force: true });
    cleanup();
  }
});

test('目录里没有清单时不抛，返回空结果（缺了内嵌词典应用照样启动）', async () => {
  const { store, dir, cleanup } = makeStore();
  try {
    const result = await installBundledDictionaries(
      path.join(os.tmpdir(), 'arale-nonexistent-dicts'),
      dir,
      (zip) => store.importZip(zip),
    );
    assert.deepEqual(result, { installed: [], skipped: [], failed: [] });
  } finally {
    cleanup();
  }
});

test('内嵌频率词典真的能给别的词补上频率', async () => {
  // 这是把青空文庫熟語内嵌进来的**全部理由**：它自己一条释义都没有，
  // 价值全靠「给别的词典查出来的词附上 rank」。
  const { store, cleanup } = makeStore();
  try {
    await installBundledDictionaries(BUNDLED_DIR, dir(store), (zip) => store.importZip(zip));
    await store.load();
    const result = await store.lookup('一日');
    const frequencies = result.results.flatMap((entry) => entry.frequencies);
    assert.ok(
      frequencies.some((f) => f.dictionary.includes('青空')),
      `「一日」应带上青空文庫的频率，实际：${JSON.stringify(frequencies)}`,
    );
  } finally {
    cleanup();
  }
});

/** 取 store 的词典目录（测试里 `makeStore` 已经知道，这里只是省一个参数穿透）。 */
function dir(store: DictionaryStore): string {
  return store.dir;
}
