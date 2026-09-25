/**
 * 分词的单元测试。
 *
 * 这一层的价值全在**可离线验证**上：真实分词质量取决于词典，但「偏移对不对、
 * 词表排序稳不稳、空文本会不会炸」这些跟词典无关，可以也应该被钉死。
 * 所以这里注入一个假切词器，完全不碰词典与磁盘。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { SegmentRecord } from '../src/shared/types';
import {
  buildVocabulary,
  normalizeTerm,
  refForChapter,
  refForComicBlock,
  segmentUnits,
} from '../src/core/segment';

/** 假切词器：按空白切，偏移算准。 */
function whitespaceSegmenter(text: string): SegmentRecord[] {
  const out: SegmentRecord[] = [];
  const re = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    out.push({
      surface: match[0],
      baseForm: match[0],
      start: match.index,
      end: match.index + match[0].length,
      matched: true,
    });
  }
  return out;
}

const deps = {
  segmentText: whitespaceSegmenter,
  dictionary: { count: 1, signature: 'test:1' },
  engine: 'test-segmenter',
};

test('segmentUnits: 偏移能切回原文（渲染侧要拿它画下划线）', () => {
  const units = [{ ref: 'page:a.png#0', text: '猫 が いる', label: '第 1 页' }];
  const result = segmentUnits(units, deps);
  for (const unit of result.units) {
    for (const token of unit.tokens) {
      assert.equal(unit.text.slice(token.start, token.end), token.surface);
    }
  }
  assert.equal(result.tokenCount, 3);
});

test('segmentUnits: 空白文本保留单元但 tokens 为空', () => {
  const result = segmentUnits([{ ref: 'page:b.png#0', text: '   ', label: '空白页' }], deps);
  assert.equal(result.units.length, 1, '单元要保留——UI 要显示「这一页没有文字」而不是消失');
  assert.deepEqual(result.units[0]?.tokens, []);
  assert.equal(result.tokenCount, 0);
});

test('segmentUnits: 越界的 token 不会抛（词典实现可能有 bug，这里要兜住）', () => {
  const bad = {
    ...deps,
    segmentText: (): SegmentRecord[] => [
      { surface: 'x', baseForm: null, start: -5, end: 9999, matched: false },
    ],
  };
  const result = segmentUnits([{ ref: 'r', text: '短短', label: 'l' }], bad);
  assert.equal(result.units.length, 1);
  for (const token of result.units[0]?.tokens ?? []) {
    assert.ok(token.start >= 0 && token.end <= 2, `偏移应被夹到范围内：${token.start}-${token.end}`);
  }
});

test('refForComicBlock / refForChapter: 引用形状稳定', () => {
  assert.equal(refForComicBlock('images/p001.png', 2), 'page:images/p001.png#2');
  assert.equal(refForChapter(3, 'OEBPS/text/ch3.xhtml'), 'chapter:3:OEBPS/text/ch3.xhtml');
});

// ---------------------------------------------------------------------------
// 词表
// ---------------------------------------------------------------------------

function unit(ref: string, text: string, tokens: SegmentRecord[]) {
  return { ref, text, label: ref, tokens };
}

test('buildVocabulary: 按 baseForm 去重并计次', () => {
  const units = [
    unit('a', '食べる', [{ surface: '食べる', baseForm: '食べる', start: 0, end: 3, matched: true }]),
    unit('b', '食べ', [{ surface: '食べ', baseForm: '食べる', start: 0, end: 2, matched: true }]),
  ];
  const vocab = buildVocabulary(units);
  assert.equal(vocab.length, 1);
  assert.equal(vocab[0]?.base, '食べる');
  assert.equal(vocab[0]?.count, 2);
  assert.equal(vocab[0]?.matched, true);
});

test('buildVocabulary: baseForm 为 null 时用表面形', () => {
  const vocab = buildVocabulary([
    unit('a', 'ASCII', [{ surface: 'ASCII', baseForm: null, start: 0, end: 5, matched: false }]),
  ]);
  assert.equal(vocab[0]?.base, 'ASCII');
  assert.equal(vocab[0]?.matched, false);
});

test('buildVocabulary: 排序是确定性的（两次结果逐字段相同）', () => {
  const mk = (): ReturnType<typeof buildVocabulary> =>
    buildVocabulary([
      unit('a', 'x', [
        { surface: 'b', baseForm: 'b', start: 0, end: 1, matched: true },
        { surface: 'a', baseForm: 'a', start: 1, end: 2, matched: true },
        { surface: 'c', baseForm: 'c', start: 2, end: 3, matched: true },
      ]),
    ]);
  // 次数相同时按 base 升序 —— 不稳定的话 UI 每次重新生成词表顺序都会变。
  assert.deepEqual(mk(), mk());
  assert.deepEqual(mk().map((entry) => entry.base), ['a', 'b', 'c']);
});

test('buildVocabulary: surfaces 最多留 8 个', () => {
  const tokens: SegmentRecord[] = [];
  for (let i = 0; i < 20; i += 1) {
    tokens.push({ surface: `s${i}`, baseForm: 'base', start: i, end: i + 1, matched: true });
  }
  const vocab = buildVocabulary([unit('a', 'x', tokens)]);
  assert.equal(vocab[0]?.count, 20);
  assert.ok((vocab[0]?.surfaces.length ?? 0) <= 8, `实际 ${vocab[0]?.surfaces.length}`);
});

test('normalizeTerm: 折叠 ASCII 大小写但不动日文', () => {
  assert.equal(normalizeTerm('ASCII'), normalizeTerm('ascii'));
  assert.notEqual(normalizeTerm('カタカナ'), normalizeTerm('かたかな'));
});
