import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { BookRecord } from '../src/shared/types';
import { CURRENT_SEGMENT_ENGINE } from '../src/shared/types';
import { morphologyToRecords } from '../src/core/segment/morph';
import { buildVocabulary, segmentUnits } from '../src/core/segment';
import { tokenizeJapanese } from '../src/main/study/tokenizer';
import { SegmentService } from '../src/main/segment/service';
import { setUserDataRootForTesting } from '../src/main/paths';

test('Kuromoji 分词保留原文偏移，未装词典也不退化成逐假名词表', async () => {
  const text = '今日は猫がいる。猫が好き。';
  const records = morphologyToRecords(text, await tokenizeJapanese(text), (word) => word === '猫');
  assert.ok(records.some((token) => token.surface === '猫' && token.matched));
  for (const token of records) assert.equal(text.slice(token.start, token.end), token.surface);

  const units = segmentUnits([{ ref: 'page:p001.png#0', text, label: '第 1 页' }], {
    segmentText: () => records,
    dictionary: { count: 1, signature: 'test' },
    engine: CURRENT_SEGMENT_ENGINE,
  }).units;
  const vocab = buildVocabulary(units);
  assert.equal(vocab.find((item) => item.base === '猫')?.count, 2);
  assert.ok(!vocab.some((item) => ['は', 'が'].includes(item.base)), '助词只用于定位，不进入学习词表');
  assert.ok(!vocab.some((item) => item.base === 'い'), '动词不应按假名单字退化');
});

test('旧的逐字产物在再次生成时自动换成当前形态分析引擎', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-morph-'));
  const bookId = 'bk_morph_test';
  const dir = path.join(root, 'library', bookId);
  fs.mkdirSync(dir, { recursive: true });
  setUserDataRootForTesting(root);
  try {
    fs.writeFileSync(path.join(dir, 'segments.json'), JSON.stringify({
      bookId, generatedAt: 1, engine: 'dictionary-longest-match',
      dictionarySignature: '', dictionaryCount: 0, units: [],
      vocabulary: [{ base: 'が', count: 1, surfaces: ['が'], matched: false }],
    }));
    const book = { id: bookId, format: 'comic' } as BookRecord;
    const service = new SegmentService({
      getBook: () => book,
      dictionary: { count: 0, signature: '', ensureLoaded: async () => undefined },
      tokenizeText: async (text) => morphologyToRecords(text, await tokenizeJapanese(text), () => false),
      readComicText: () => [{ pageUrl: 'p001.png', blocks: [{ lines: ['猫が好き'] }] }],
      readChapters: () => [],
    });
    assert.equal(service.read(bookId)?.engine, 'dictionary-longest-match');
    service.start(bookId);
    const done = await service.wait(bookId);
    assert.equal(done?.ok, true);
    const current = service.read(bookId);
    assert.equal(current?.engine, CURRENT_SEGMENT_ENGINE);
    assert.ok(current?.vocabulary.some((item) => item.base === '猫'));
    assert.ok(!current?.vocabulary.some((item) => item.base === 'が'));
  } finally {
    setUserDataRootForTesting(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
