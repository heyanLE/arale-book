/**
 * 词典子系统**端到端**验收测试。
 *
 * 这是整个项目最重要的一个测试：它走的是用户真实会走的那条路——
 * 「装一本 Yomitan 词典 → 点一个变过形的日语词 → 弹出释义」。
 *
 * 前面的 `dict-*.test.ts` 各自测一层（标准化 / 去屈折 / 扫描），但它们合起来是否
 * 真的能工作，只有这个测试能回答：
 *   zip 落盘 → meta.json → load() → 索引 → 最长匹配扫描 → 去屈折 → 排序 → LookupResult
 *
 * 测试词典是**内存里造的**，不依赖任何外部词典文件。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { strToU8, zipSync } from 'fflate';

import { DictionaryStore } from '../src/core/dict/store';
import { importYomitanZip } from '../src/core/dict/yomitan';

/**
 * Yomitan term bank 的一行是**数组**：
 * `[expression, reading, definitionTags, rules, score, glossary, sequence, termTags]`
 */
type TermRow = [string, string, string, string, number, unknown, number, string];

const TERMS: TermRow[] = [
  ['私', 'わたし', 'pn', '', 100, ['I; me'], 1, ''],
  ['寿司', 'すし', 'n', '', 100, ['sushi'], 2, ''],
  // 五段动词，带 `v5` 条件：去屈折必须能把 書いた → 書く。
  ['書く', 'かく', 'v5', 'v5', 100, ['to write'], 3, ''],
  // 一段动词：食べました → 食べる 走 `-ます` 规则。
  ['食べる', 'たべる', 'v1', 'v1', 100, ['to eat'], 4, ''],
  // 形容词。
  ['高い', 'たかい', 'adj-i', 'adj-i', 100, ['tall; expensive'], 5, ''],
];

function buildDictionaryZip(): Uint8Array {
  const index = {
    title: 'Test Dictionary',
    format: 3,
    revision: '1',
    sequenced: true,
    author: 'aralebook tests',
  };
  // 频率数据：给「食べる」一个排名，用来验证带频率的词排前面。
  const meta: unknown[] = [
    ['食べる', 'freq', { value: 1200, display: '1200' }],
    ['私', 'freq', 30],
  ];
  return zipSync({
    'index.json': strToU8(JSON.stringify(index)),
    'term_bank_1.json': strToU8(JSON.stringify(TERMS)),
    'term_meta_bank_1.json': strToU8(JSON.stringify(meta)),
  });
}

function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-dict-'));
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('端到端：导入 Yomitan zip → 载入 → 查询', async () => {
  await withTempRoot(async (root) => {
    const zipPath = path.join(root, 'test-dict.zip');
    fs.writeFileSync(zipPath, buildDictionaryZip());

    const imported = await importYomitanZip(zipPath, path.join(root, 'dictionaries'), 'dc_test');
    assert.equal(imported.info.title, 'Test Dictionary');
    assert.equal(imported.termCount, TERMS.length, '5 条词应该全部导入');
    assert.ok(imported.freqCount >= 2, '两条频率数据应该被读到');

    const store = new DictionaryStore(path.join(root, 'dictionaries'));
    const status = await store.load();
    assert.equal(status.dictionaries.length, 1);
    assert.equal(status.termCount, TERMS.length);
    assert.ok(store.ready, 'load() 之后 ready 应为 true');

    // --- 直接命中 ---
    const direct = store.lookup('寿司', 0);
    assert.equal(direct.term, '寿司');
    assert.equal(direct.results[0]?.term.expression, '寿司');
    assert.deepEqual(direct.results[0]?.deinflection, [], '直接命中不应有去屈折轨迹');
    assert.equal(direct.dictionaryCount, 1);

    // --- 屈折命中（一段动词，-ます）---
    const inflected = store.lookup('食べました', 0);
    assert.ok(inflected.results.length > 0, '食べました 应该查到东西');
    const eaten = inflected.results.find((r) => r.term.expression === '食べる');
    assert.ok(eaten, '食べました 应该去屈折到 食べる');
    assert.ok(eaten!.deinflection.length > 0, '应带非空的去屈折轨迹供弹窗显示');
    // `LookupResult.term` 是**命中的表面形**（用户点到的那个词），不是辞书形：
    // 弹窗标题要显示用户点的东西，辞书形在 results[].term.expression 里。
    assert.equal(inflected.term, '食べました');
    assert.equal(eaten!.term.expression, '食べる');

    // --- 屈折命中（五段动词，-た）---
    const godan = store.lookup('書いた', 0);
    const wrote = godan.results.find((r) => r.term.expression === '書く');
    assert.ok(wrote, '書いた 应该去屈折到 書く');
  });
});

test('端到端：整句查询会同时返回分词与释义', async () => {
  await withTempRoot(async (root) => {
    const zipPath = path.join(root, 'd.zip');
    fs.writeFileSync(zipPath, buildDictionaryZip());
    await importYomitanZip(zipPath, path.join(root, 'dictionaries'), 'dc_test');

    const store = new DictionaryStore(path.join(root, 'dictionaries'));
    await store.load();

    const sentence = '私は寿司を食べました';
    // 「食」的 UTF-16 偏移：私(0)は(1)寿(2)司(3)を(4) → 5
    const result = store.lookup(sentence, 5);

    assert.equal(result.query, sentence);
    assert.ok(result.results.some((r) => r.term.expression === '食べる'));

    // 分词：整句应被切成 私 / は? / 寿司 / を? / 食べました
    const surfaces = result.tokens.map((t) => t.surface);
    assert.ok(surfaces.includes('私'), `分词应包含 私，实际 ${JSON.stringify(surfaces)}`);
    assert.ok(surfaces.includes('寿司'), `分词应包含 寿司，实际 ${JSON.stringify(surfaces)}`);
    const eatenToken = result.tokens.find((t) => t.baseForm === '食べる');
    assert.ok(eatenToken, `分词应有一个 baseForm=食べる 的 token，实际 ${JSON.stringify(result.tokens)}`);
    assert.equal(eatenToken!.surface, '食べました');
    assert.equal(eatenToken!.matched, true);

    // 偏移必须能对回原串（渲染进程要用它画下划线 / 定位 DOM Range）。
    for (const token of result.tokens) {
      assert.equal(
        sentence.slice(token.start, token.end),
        token.surface,
        `token 偏移 [${token.start},${token.end}] 应切出 ${token.surface}`,
      );
    }
  });
});

test('端到端：查询结果顺序稳定（同样的输入跑两次完全一致）', async () => {
  await withTempRoot(async (root) => {
    const zipPath = path.join(root, 'd.zip');
    fs.writeFileSync(zipPath, buildDictionaryZip());
    await importYomitanZip(zipPath, path.join(root, 'dictionaries'), 'dc_test');
    const store = new DictionaryStore(path.join(root, 'dictionaries'));
    await store.load();

    const a = store.lookup('私は寿司を食べました', 5);
    const b = store.lookup('私は寿司を食べました', 5);
    assert.deepEqual(
      a.results.map((r) => r.term.expression),
      b.results.map((r) => r.term.expression),
      '顺序不稳定会让弹窗在两次相同点击间重排',
    );
  });
});

test('端到端：没有词典时不抛，返回 dictionaryCount=0', async () => {
  await withTempRoot(async (root) => {
    const store = new DictionaryStore(path.join(root, 'dictionaries'));
    const result = store.lookup('寿司', 0);
    assert.equal(result.dictionaryCount, 0);
    assert.deepEqual(result.results, []);
    assert.equal(store.ready, false);
  });
});

test('端到端：禁用词典后不再返回它的词条', async () => {
  await withTempRoot(async (root) => {
    const zipPath = path.join(root, 'd.zip');
    fs.writeFileSync(zipPath, buildDictionaryZip());
    const dictRoot = path.join(root, 'dictionaries');
    await importYomitanZip(zipPath, dictRoot, 'dc_test');

    const store = new DictionaryStore(dictRoot);
    await store.load();
    assert.ok(store.lookup('寿司', 0).results.length > 0);

    await store.setEnabled('dc_test', false);
    const disabled = store.lookup('寿司', 0);
    assert.equal(disabled.results.length, 0, '禁用的词典不应参与查询');
    assert.equal(disabled.dictionaryCount, 0);
  });
});

test('端到端：词典包内自带 wrapper 目录时仍能导入', async () => {
  await withTempRoot(async (root) => {
    // 真实世界的词典 zip 常常多一层 `MyDict/`，成员名不是从根开始的。
    const index = { title: 'Wrapped', format: 3 };
    const zip = zipSync({
      'MyDict/index.json': strToU8(JSON.stringify(index)),
      'MyDict/term_bank_1.json': strToU8(JSON.stringify([['猫', 'ねこ', 'n', '', 100, ['cat'], 1, '']])),
    });
    const zipPath = path.join(root, 'wrapped.zip');
    fs.writeFileSync(zipPath, zip);

    const imported = await importYomitanZip(zipPath, path.join(root, 'dictionaries'), 'dc_wrapped');
    assert.equal(imported.info.title, 'Wrapped');
    assert.equal(imported.termCount, 1);

    const store = new DictionaryStore(path.join(root, 'dictionaries'));
    await store.load();
    const result = store.lookup('猫', 0);
    assert.equal(result.results[0]?.term.expression, '猫');
  });
});

test('端到端：缺 index.json 的 zip 报错而不是静默装一本空词典', async () => {
  await withTempRoot(async (root) => {
    const zipPath = path.join(root, 'broken.zip');
    fs.writeFileSync(zipPath, zipSync({ 'term_bank_1.json': strToU8('[]') }));
    await assert.rejects(
      () => importYomitanZip(zipPath, path.join(root, 'dictionaries'), 'dc_broken'),
      /index\.json/,
    );
  });
});
