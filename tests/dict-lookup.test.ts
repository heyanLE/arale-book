/**
 * lookup.ts 单测：贪心最长匹配分词、点击偏移回退、结果去重/排序、空索引、
 * 释义 HTML 清洗（XSS），外加一条 yomitan 导入 + DictionaryStore 生命周期的端到端用例。
 *
 * 索引在测试里手搓（`emptyTermIndex()` + 自己填 byKey/freqByTerm），
 * 除了那条端到端用例故意走真实的 zip 导入 —— 免得单测依赖任何真实词典包。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { strToU8, zipSync } from 'fflate';

import type { DictFrequency, DictTerm, GlossaryContent } from '../src/shared/types';
import {
  DictionaryStore,
  emptyTermIndex,
  frequencyKey,
  isYomitanDictionary,
  lookup,
  renderGlossaryHtml,
  sanitizeGlossaryHtml,
  segment,
  type TermIndex,
} from '../src/core/dict';
import { normalizeQuery } from '../src/core/dict/normalize';

const TEST_DICT: { id: string; title: string } = { id: 'dc_test', title: 'Test' };

interface TermSpec {
  expression: string;
  reading?: string;
  score?: number;
  rules?: string[];
  glossary?: GlossaryContent;
  dictionaryId?: string;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function makeIndex(specs: TermSpec[], frequencies: Array<{ expression: string; reading?: string; value: number | string; display?: string | null }> = []): TermIndex {
  const index = emptyTermIndex();
  index.dictionaries.push({
    id: TEST_DICT.id,
    title: TEST_DICT.title,
    format: 'yomitan',
    termCount: specs.length,
    freqCount: frequencies.length,
    importedAt: 0,
    enabled: true,
  });
  for (const spec of specs) {
    const dictionaryId = spec.dictionaryId ?? TEST_DICT.id;
    const term: DictTerm = {
      expression: spec.expression,
      reading: spec.reading ?? '',
      definitionTags: [],
      termTags: [],
      rules: spec.rules ?? [],
      score: spec.score ?? 0,
      sequence: 0,
      glossary: spec.glossary ?? `${spec.expression} の意味`,
      dictionaryId,
      dictionaryTitle: dictionaryId === TEST_DICT.id ? TEST_DICT.title : dictionaryId,
    };
    index.terms.push(term);
    const expressionKey = normalizeQuery(term.expression);
    if (expressionKey.length > 0) push(index.byKey, expressionKey, term);
    if (term.reading.length > 0) {
      const readingKey = normalizeQuery(term.reading);
      if (readingKey.length > 0 && readingKey !== expressionKey) push(index.byKey, readingKey, term);
    }
  }
  for (const frequency of frequencies) {
    const value: DictFrequency = {
      value: frequency.value,
      display: frequency.display ?? null,
      dictionary: TEST_DICT.title,
    };
    push(index.freqByTerm, frequencyKey(frequency.expression, frequency.reading ?? ''), value);
  }
  return index;
}

// ---------------------------------------------------------------------------
// segment
// ---------------------------------------------------------------------------

test('segment: 私は寿司を食べました 贪心切分，偏移是 UTF-16 偏移', () => {
  const index = makeIndex([{ expression: '私' }, { expression: '寿司' }, { expression: '食べる' }]);
  const tokens = segment('私は寿司を食べました', index);
  assert.deepEqual(tokens, [
    { surface: '私', start: 0, end: 1, matched: true, baseForm: '私' },
    // は / を 是假名但不是词典里的词：产出未命中占位 token（不是标点，不能被跳过）。
    { surface: 'は', start: 1, end: 2, matched: false, baseForm: null },
    { surface: '寿司', start: 2, end: 4, matched: true, baseForm: '寿司' },
    { surface: 'を', start: 4, end: 5, matched: false, baseForm: null },
    { surface: '食べました', start: 5, end: 10, matched: true, baseForm: '食べる' },
  ]);
});

test('segment: 空白与标点不产出 token，但偏移照旧前进', () => {
  const index = makeIndex([{ expression: '寿司' }, { expression: '私' }]);
  const tokens = segment('私、寿司。', index);
  assert.deepEqual(tokens, [
    { surface: '私', start: 0, end: 1, matched: true, baseForm: '私' },
    { surface: '寿司', start: 2, end: 4, matched: true, baseForm: '寿司' },
  ]);
});

test('segment: 词典里没有的词退化成单码点占位', () => {
  const index = makeIndex([{ expression: '寿司' }]);
  const tokens = segment('𠮷寿司', index);
  assert.deepEqual(tokens, [
    { surface: '𠮷', start: 0, end: 2, matched: false, baseForm: null },
    { surface: '寿司', start: 2, end: 4, matched: true, baseForm: '寿司' },
  ]);
});

// ---------------------------------------------------------------------------
// lookup
// ---------------------------------------------------------------------------

test('lookup: 点击位置命中整词，并从变形还原拿回辞书形', () => {
  const index = makeIndex([{ expression: '私' }, { expression: '寿司', reading: 'すし' }, { expression: '食べる' }]);
  const text = '私は寿司を食べました';

  const first = lookup(text, 0, index);
  assert.equal(first.query, text);
  assert.equal(first.term, '私');
  assert.equal(first.dictionaryCount, 1);
  assert.equal(first.results[0]?.term.expression, '私');
  assert.deepEqual(first.results[0]?.deinflection, []);

  const sushi = lookup(text, 2, index);
  assert.equal(sushi.term, '寿司');
  assert.equal(sushi.results[0]?.term.expression, '寿司');

  // 点在词中间（司）→ 回退到词首。
  assert.equal(lookup(text, 3, index).term, '寿司');

  const inflected = lookup(text, 5, index);
  assert.equal(inflected.term, '食べました');
  assert.equal(inflected.results[0]?.term.expression, '食べる');
  assert.ok((inflected.results[0]?.deinflection.length ?? 0) > 0, '变形轨迹必须非空');
  assert.deepEqual(
    inflected.results[0]?.deinflection.map((step) => step.name),
    ['-た', '-ます'],
  );

  // 点在词中间（べ）→ 回退到 食べました。
  assert.equal(lookup(text, 6, index).term, '食べました');
  // 边界外偏移被 clamp，不抛。
  assert.equal(lookup('zzz', 999, index).term, '');
  assert.equal(lookup('', 0, index).term, '');
});

test('lookup: 频率数据先于 score 排序', () => {
  const index = makeIndex(
    [
      { expression: 'テスト', reading: 'てすと', score: 1, dictionaryId: 'dc_a' },
      { expression: 'テスト', reading: '', score: 99, dictionaryId: 'dc_b' },
    ],
    [{ expression: 'テスト', reading: 'てすと', value: 3, display: '3' }],
  );
  const result = lookup('テスト', 0, index);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0]?.term.dictionaryId, 'dc_a');
  assert.equal(result.results[0]?.frequencies.length, 1);
  assert.equal(result.results[1]?.term.dictionaryId, 'dc_b');
  assert.equal(result.results[1]?.frequencies.length, 0);
});

test('lookup: 没有频率数据时按 score 降序', () => {
  const index = makeIndex([
    { expression: 'テスト', reading: '', score: 1, dictionaryId: 'dc_a' },
    { expression: 'テスト', reading: '', score: 50, dictionaryId: 'dc_b' },
  ]);
  const result = lookup('テスト', 0, index);
  assert.deepEqual(
    result.results.map((entry) => entry.term.dictionaryId),
    ['dc_b', 'dc_a'],
  );
});

test('lookup: 排序确定（同一输入两次 deepEqual）', () => {
  const index = makeIndex([
    { expression: 'テスト', reading: 'てすと', score: 1, dictionaryId: 'dc_a' },
    { expression: 'テスト', reading: '', score: 1, dictionaryId: 'dc_c' },
    { expression: 'テスト', reading: '', score: 1, dictionaryId: 'dc_b' },
  ]);
  const once = lookup('テスト', 0, index);
  const twice = lookup('テスト', 0, index);
  assert.deepEqual(once, twice);
  // 其余键全等时，读音 '' 排在 'てすと' 前，再按 dictionaryId 兜底。
  assert.deepEqual(
    once.results.map((entry) => entry.term.dictionaryId),
    ['dc_b', 'dc_c', 'dc_a'],
  );
});

test('lookup: maxResults 生效', () => {
  const index = makeIndex([
    { expression: 'テスト', reading: '', dictionaryId: 'dc_a' },
    { expression: 'テスト', reading: '', dictionaryId: 'dc_b' },
    { expression: 'テスト', reading: '', dictionaryId: 'dc_c' },
  ]);
  assert.equal(lookup('テスト', 0, index, { maxResults: 2 }).results.length, 2);
});

test('lookup: 空索引返回 dictionaryCount 0 且不抛', () => {
  const index = emptyTermIndex();
  const result = lookup('寿司', 0, index);
  assert.equal(result.dictionaryCount, 0);
  assert.equal(result.term, '');
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.tokens, []);
  assert.deepEqual(segment('寿司', index), [
    { surface: '寿', start: 0, end: 1, matched: false, baseForm: null },
    { surface: '司', start: 1, end: 2, matched: false, baseForm: null },
  ]);
});

// ---------------------------------------------------------------------------
// 释义 HTML / XSS
// ---------------------------------------------------------------------------

test('sanitizeGlossaryHtml: 白名单标签保留，危险标签与属性被剥掉', () => {
  assert.equal(sanitizeGlossaryHtml('<script>alert(1)</script>'), '');
  assert.equal(sanitizeGlossaryHtml('<div>a<script>x</script>b</div>'), '<div>ab</div>');
  assert.ok(!sanitizeGlossaryHtml('<img src=x onerror=alert(1)>').includes('<img'));
  assert.equal(sanitizeGlossaryHtml('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(sanitizeGlossaryHtml('<a href="java&#115;cript:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(sanitizeGlossaryHtml('<a href="&#x6A;avascript:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(sanitizeGlossaryHtml('<a href="data:text/html,<script>1</script>">x</a>'), '<a>x</a>');
  assert.equal(sanitizeGlossaryHtml('<a href="  JAVASCRIPT:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(sanitizeGlossaryHtml('<a href="vbscript:msgbox(1)">x</a>'), '<a>x</a>');
  assert.equal(sanitizeGlossaryHtml('<a href="https://example.com">x</a>'), '<a href="https://example.com">x</a>');
  assert.equal(
    sanitizeGlossaryHtml('<span class="x" onclick="evil()" style="color:red">t</span>'),
    '<span class="x">t</span>',
  );
  assert.equal(sanitizeGlossaryHtml('<ruby>漢<rt>かん</rt></ruby>'), '<ruby>漢<rt>かん</rt></ruby>');
  assert.equal(sanitizeGlossaryHtml('<b>a</b> & <i>b</i>'), '<b>a</b> &amp; <i>b</i>');
  // 实体不能被二次转义，否则 &nbsp; 会原样显示。
  assert.equal(sanitizeGlossaryHtml('a&nbsp;b'), 'a&nbsp;b');
  assert.equal(sanitizeGlossaryHtml('<!-- 注释 -->ok'), 'ok');
});

test('renderGlossaryHtml: 字符串 / 数组 / 结构化内容', () => {
  assert.equal(renderGlossaryHtml('plain & <b>bold</b>'), 'plain &amp; <b>bold</b>');
  assert.equal(renderGlossaryHtml(['a', 'b']), 'ab');
  assert.equal(
    renderGlossaryHtml({ tag: 'div', style: { fontSize: '1.2em', fontWeight: 'bold' }, content: 'x' }),
    '<div style="font-size: 1.2em; font-weight: bold">x</div>',
  );
  // tag 不在白名单里 → 只渲染子内容，不套壳。
  assert.equal(renderGlossaryHtml({ tag: 'script', content: 'alert(1)' }), 'alert(1)');
  // style 里的 url()/expression() 被丢。
  assert.equal(renderGlossaryHtml({ tag: 'div', style: { background: 'url(javascript:1)' }, content: 'x' }), '<div>x</div>');
  // Yomitan 的 {type:'text'} / {type:'image'} 包装形态。
  assert.equal(renderGlossaryHtml({ tag: 'span', content: 'x' }), '<span>x</span>');
});

// ---------------------------------------------------------------------------
// 端到端：zip 导入 → 索引 → 查询 → 启停/删除
// ---------------------------------------------------------------------------

const WORKSPACE = path.join(__dirname, '..', '..');
const FIXTURE_ZIP = path.join(WORKSPACE, '.tmp-dict-fixture.zip');
const WRAPPED_ZIP = path.join(WORKSPACE, '.tmp-dict-wrapped.zip');
const DICT_ROOT = path.join(WORKSPACE, '.tmp-dict-root');

function writeFixtureZip(target: string, prefix: string): void {
  const zip = zipSync({
    [`${prefix}index.json`]: strToU8(JSON.stringify({ title: 'テスト辞書', format: 3, revision: '1' })),
    [`${prefix}term_bank_1.json`]: strToU8(
      JSON.stringify([
        ['寿司', 'すし', 'n', 'n', 10, [{ tag: 'div', content: 'sushi' }], 1, ''],
        ['食べる', 'たべる', 'v1', 'v1', 20, ['to eat'], 2, ''],
        '这一行不是数组', // 形状不对：必须跳过而不是废掉整本词典
        [], // 空行同样跳过
      ]),
    ),
    [`${prefix}term_meta_bank_1.json`]: strToU8(JSON.stringify([['寿司', 'freq', { value: 123, display: '123' }]])),
    [`${prefix}media/audio.mp3`]: strToU8('not a real mp3'),
  });
  fs.writeFileSync(target, Buffer.from(zip));
}

test('isYomitanDictionary: 认 index.json + term_bank_*.json，容忍 wrapper 目录', () => {
  assert.equal(isYomitanDictionary([{ name: 'index.json' }, { name: 'term_bank_1.json' }]), true);
  assert.equal(isYomitanDictionary([{ name: 'MyDict/index.json' }, { name: 'MyDict/term_bank_9.json' }]), true);
  assert.equal(isYomitanDictionary([{ name: 'index.json' }]), false);
  assert.equal(isYomitanDictionary([{ name: 'term_bank_1.json' }]), false);
});

test('DictionaryStore: 导入 / 查询 / 启停 / 删除 全链路', async () => {
  fs.rmSync(DICT_ROOT, { recursive: true, force: true });
  writeFixtureZip(FIXTURE_ZIP, '');
  const store = new DictionaryStore(DICT_ROOT);
  try {
    // load 之前：ready=false，查询不抛，返回空结果。
    assert.equal(store.ready, false);
    assert.equal(store.lookup('寿司', 0).dictionaryCount, 0);
    assert.equal(store.segment('寿司').length, 2);
    assert.equal(store.segment('寿司')[0]?.matched, false);
    assert.deepEqual(await store.load(), { dir: DICT_ROOT, dictionaries: [], termCount: 0, loaded: true });
    assert.equal(store.ready, false);

    const info = await store.importZip(FIXTURE_ZIP);
    assert.equal(info.title, 'テスト辞書');
    assert.equal(info.termCount, 2); // 坏行被跳过
    assert.equal(info.freqCount, 1);
    assert.equal(info.enabled, true);
    assert.equal(store.ready, true);
    assert.equal(store.status().termCount, 2);

    const hit = store.lookup('寿司', 0);
    assert.equal(hit.term, '寿司');
    assert.equal(hit.results[0]?.term.expression, '寿司');
    assert.equal(hit.results[0]?.frequencies[0]?.value, 123);
    assert.equal(renderGlossaryHtml(hit.results[0]!.term.glossary), '<div>sushi</div>');

    // 变形还原走通真实索引。
    assert.equal(store.lookup('食べた', 0).results[0]?.term.expression, '食べる');
    // 分词走通真实索引。
    assert.deepEqual(store.segment('寿司'), [{ surface: '寿司', start: 0, end: 2, matched: true, baseForm: '寿司' }]);

    // 禁用后索引里没有词条，但仍然不抛。
    const disabled = await store.setEnabled(info.id, false);
    assert.equal(disabled.dictionaries[0]?.enabled, false);
    assert.equal(disabled.termCount, 0);
    assert.equal(store.lookup('寿司', 0).dictionaryCount, 0);
    assert.equal(store.ready, false);

    // 重新启用（模拟重启：新建 store 也要能读回状态）。
    await store.setEnabled(info.id, true);
    const reopened = new DictionaryStore(DICT_ROOT);
    await reopened.load();
    assert.equal(reopened.lookup('寿司', 0).dictionaryCount, 1);

    const afterRemove = await store.remove(info.id);
    assert.deepEqual(afterRemove.dictionaries, []);
    assert.equal(store.ready, false);
    // 删不存在的 id 不能抛。
    await store.remove('dc_doesnotexist');
  } finally {
    fs.rmSync(DICT_ROOT, { recursive: true, force: true });
    fs.rmSync(FIXTURE_ZIP, { force: true });
  }
});

test('importYomitanZip: wrapper 目录（MyDict/term_bank_1.json）也能导入', async () => {
  fs.rmSync(DICT_ROOT, { recursive: true, force: true });
  writeFixtureZip(WRAPPED_ZIP, 'MyDict/');
  const store = new DictionaryStore(DICT_ROOT);
  try {
    const info = await store.importZip(WRAPPED_ZIP);
    assert.equal(info.termCount, 2);
    assert.equal(store.lookup('寿司', 0).dictionaryCount, 1);
  } finally {
    fs.rmSync(DICT_ROOT, { recursive: true, force: true });
    fs.rmSync(WRAPPED_ZIP, { force: true });
  }
});
