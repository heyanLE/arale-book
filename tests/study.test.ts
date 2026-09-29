import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { BookRecord, BookSegments } from '../src/shared/types';
import { ankiTsv, buildStudyCandidates } from '../src/core/study/candidates';
import { createJlptIndex, lookupJlpt } from '../src/core/study/jlpt';
import { StudyService, chooseMeaning } from '../src/main/study/service';
import { tokenizeJapanese } from '../src/main/study/tokenizer';
import { setUserDataRootForTesting } from '../src/main/paths';

test('JLPT 按表记和读音匹配；动词变形可回退到唯一辞书形读音', () => {
  const index = createJlptIndex([['食べる', 'たべる', 5], ['食べる', 'たべる', 4], ['生', 'せい', 2], ['生', 'なま', 3]]);
  assert.deepEqual(lookupJlpt(index, '食べる', 'タベ'), { level: 5, conflict: true, reading: 'たべる' });
  assert.equal(lookupJlpt(index, '生', 'なま').level, 3);
  assert.equal(lookupJlpt(index, '生', 'いき').level, null, '多读音词不可仅凭表记猜等级');
});

test('候选保留原文偏移、合并相同词并区分异读', () => {
  const units = [
    { ref: 'page:a#0', label: '第 1 页', text: '食べた、食べた', tokens: [] },
  ];
  const token = { surface: '食べ', lemma: '食べる', reading: 'タベ', pos: '動詞', known: true };
  const candidates = buildStudyCandidates(units, [[token, { surface: 'た', lemma: 'た', reading: 'タ', pos: '助動詞', known: true },
    { surface: '、', lemma: '、', reading: '、', pos: '記号', known: true }, token]], createJlptIndex([['食べる', 'たべる', 5]]));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.count, 2);
  assert.equal(candidates[0]?.reading, 'たべる');
  assert.deepEqual(candidates[0]?.occurrences.map((one) => [one.start, one.end]), [[0, 2], [4, 6]]);
});

test('Kuromoji 细分词性与跨页次数进入候选，专名和数词可分辨', async () => {
  const parsed = await tokenizeJapanese('太郎は2025年にいる。');
  assert.equal(parsed.find((token) => token.surface === '太郎')?.posDetail, '固有名詞');
  assert.equal(parsed.find((token) => token.surface === '2025')?.posDetail, '数');
  const first = parsed.find((token) => token.surface === '太郎')!;
  const candidates = buildStudyCandidates([
    { ref: 'page:a#0', label: '第 1 页', text: '太郎', tokens: [] },
    { ref: 'page:b#0', label: '第 2 页', text: '太郎', tokens: [] },
  ], [[first], [first]], createJlptIndex([]));
  assert.equal(candidates[0]?.pageCount, 2);
  assert.equal(candidates[0]?.properName, true);
  assert.equal(candidates[0]?.tokenizerKnown, true);
});

test('Anki TSV 转义 OCR 文本并按选择导出', () => {
  const candidates = buildStudyCandidates(
    [{ ref: 'page:a#0', label: '第 1 页', text: '猫<が\tいる', tokens: [] }],
    [[{ surface: '猫', lemma: '猫', reading: 'ネコ', pos: '名詞', known: true }]],
    createJlptIndex([['猫', 'ねこ', 5]]),
  );
  candidates[0]!.selected = true;
  candidates[0]!.meaning = 'cat & friend';
  const result = ankiTsv([candidates[0]!, { ...candidates[0]!, id: 'duplicate' }], 'テスト漫画');
  assert.equal(result.count, 1);
  assert.match(result.text, /#tags column:3/);
  assert.match(result.text, /猫（ねこ）\tcat &amp; friend<br>猫&lt;が いる/);
  assert.match(result.text, /jlpt_n5/);
  assert.equal(result.text.split('\n').length, 5);
});

test('词义只接受同表记、同读音的词典条目', () => {
  const entries = [
    { term: { expression: '別', reading: 'ねこ', glossary: 'wrong' } },
    { term: { expression: '猫', reading: 'ねこ', glossary: 'cat' } },
  ];
  assert.equal(chooseMeaning(entries, '猫', 'ネコ'), 'cat');
  assert.equal(chooseMeaning(entries, '猫', 'びょう'), '');
});

test('学习清单生成、人工修改、短语和导出结果能落盘', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-study-'));
  const bookId = 'bk_test';
  fs.mkdirSync(path.join(root, 'library', bookId), { recursive: true });
  setUserDataRootForTesting(root);
  try {
    const book = { id: bookId, title: 'テスト漫画', format: 'comic' } as BookRecord;
    const segments: BookSegments = {
      bookId, generatedAt: 123, engine: 'test', dictionarySignature: 'test', dictionaryCount: 1,
      units: [{ ref: 'page:a#0', label: '第 1 页', text: '今日は彼女がいない', tokens: [] }], vocabulary: [],
    };
    const service = new StudyService({
      getBook: () => book, getSegments: () => segments, ensureDictionary: async () => undefined,
      lookupMeaning: (expression) => `${expression} 的释义`,
    });
    const list = await service.generate(bookId);
    assert.ok(list.candidates.some((item) => item.expression === '彼女'));
    const her = list.candidates.find((item) => item.expression === '彼女')!;
    service.patch(bookId, her.id, { selected: true, meaning: '她' });
    const updated = service.addPhrase(bookId, her.occurrences[0]!.id, '彼女がいない', 'かのじょがいない');
    assert.equal(updated.candidates[0]?.partOfSpeech, '短语');
    const output = path.join(root, 'anki.txt');
    assert.equal(service.exportText(bookId, output), 2);
    assert.match(fs.readFileSync(output, 'utf8'), /彼女がいない/);
    assert.ok(service.read(bookId)?.candidates.find((item) => item.id === her.id)?.exportedAt);
    const regenerated = await service.generate(bookId);
    assert.equal(regenerated.candidates.find((item) => item.id === her.id)?.meaning, '她');
    assert.ok(regenerated.candidates.some((item) => item.partOfSpeech === '短语'));
  } finally {
    setUserDataRootForTesting(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
