/**
 * normalize.ts 单测：NFKC、变体选择符、片假名→平假名、查询键、日文判定。
 */

import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isJapaneseText,
  normalizeQuery,
  normalizeText,
  toHiragana,
} from '../src/core/dict/normalize';

test('normalizeText: NFKC 把全角拉丁折成半角', () => {
  assert.equal(normalizeText('ＡＢＣ１２３'), 'ABC123');
});

test('normalizeText: NFKC 把半角片假名折成全角片假名（含浊音合成）', () => {
  assert.equal(normalizeText('ｶﾀｶﾅ'), 'カタカナ');
  assert.equal(normalizeText('ｶﾞ'), 'ガ');
});

test('normalizeText: 剥掉变体选择符（BMP 与补充平面）', () => {
  assert.equal(normalizeText('葛\uFE00'), '葛');
  assert.equal(normalizeText('葛\uFE0F飾り'), '葛飾り');
  // U+E0100 是补充平面，占一个代理对；不能被 charCodeAt 式实现切坏。
  assert.equal(normalizeText('𠮷\u{E0100}'), '𠮷');
});

test('normalizeText: 折叠空白并 trim', () => {
  assert.equal(normalizeText('  a \t\n  b  '), 'a b');
  assert.equal(normalizeText('a\u3000\u3000b'), 'a b');
});

test('toHiragana: 只搬 0x30A1..0x30F6', () => {
  assert.equal(toHiragana('カタカナ'), 'かたかな');
  assert.equal(toHiragana('ヴァイオリン'), 'ゔぁいおりん');
  assert.equal(toHiragana('コーヒー'), 'こーひー'); // ー 不动，否则会变成 こおひい
  assert.equal(toHiragana('ABC寿司'), 'ABC寿司');
});

test('normalizeQuery: 索引键 = NFKC + 片假名折叠 + 小写', () => {
  assert.equal(normalizeQuery('スシ'), 'すし');
  assert.equal(normalizeQuery('ＡＢＣ'), 'abc');
  assert.equal(normalizeQuery(' Ｈｅｌｌｏ\u3000'), 'hello');
  // 同一键的两种写法必须相等，否则索引与查询会对不上。
  assert.equal(normalizeQuery('スシ'), normalizeQuery('すし'));
});

test('isJapaneseText: >=30% 非空白字符是假名/汉字', () => {
  assert.equal(isJapaneseText('私は寿司を食べました'), true);
  assert.equal(isJapaneseText('こんにちは'), true);
  assert.equal(isJapaneseText('hello world'), false);
  assert.equal(isJapaneseText(''), false);
  assert.equal(isJapaneseText('   '), false);
  // 6 个非空白字符里 1 个汉字 = 16.7% → 不算日文。
  assert.equal(isJapaneseText('hello 私'), false);
  // 13 个里 10 个汉字 ≈ 77% → 算日文。
  assert.equal(isJapaneseText('abc私私私私私私私私私私'), true);
});
