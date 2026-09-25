/**
 * 异体字归一化的单测。
 *
 * 这张表是为了修一个**用户看得见但很难归因**的问题：扫描版/旧字体排版的书里点到
 * `神`、`髙` 这类兼容汉字查不到词，而词典里明明收了 `神`、`高`。NFKC 不会折它们，
 * 所以必须自己折。
 *
 * 数据是生成出来的（`scripts/make-kanji-variants.mjs`），所以这里同时守着
 * 「表在不在、全不全」——只测几个硬编码字符的话，表被换成空文件也测不出来。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  foldKanjiVariants,
  kanjiVariantCount,
  resetKanjiVariantsCache,
} from '../src/core/dict/kanji-variants';
import { normalizeQuery } from '../src/core/dict/normalize';

test('随包数据能读到，且规模与 Fushi 的表一致（2122 条）', () => {
  resetKanjiVariantsCache();
  assert.equal(kanjiVariantCount(), 2122, '表没读到或条数变了——先看 data/kanji-variants.json 在不在');
});

test('常见异体字被折成常用字形', () => {
  // 这几个是真实漫画/旧字体书里出现频率较高的。
  assert.equal(foldKanjiVariants('神'), '神');
  assert.equal(foldKanjiVariants('髙'), '高');
  assert.equal(foldKanjiVariants('㐂'), '喜');
  assert.equal(foldKanjiVariants('邊'), '辺');
});

test('常用字形原样返回（不做反向折叠）', () => {
  assert.equal(foldKanjiVariants('神'), '神');
  assert.equal(foldKanjiVariants('高い'), '高い');
});

test('折在一句话中间也生效', () => {
  assert.equal(foldKanjiVariants('神社で髙い'), '神社で高い');
});

test('纯假名/拉丁文本不受影响', () => {
  assert.equal(foldKanjiVariants('こんにちは ABC 123'), 'こんにちは ABC 123');
  assert.equal(foldKanjiVariants(''), '');
});

test('代理对（U+20000 以上）不被拆坏', () => {
  // 表里有 𠂣 这类辅助平面汉字；用 charCodeAt 逐位处理会把代理对拆成乱码。
  const result = foldKanjiVariants('㐆');
  assert.equal(result, '𠂣');
  assert.equal(result.length, 2, '辅助平面字符在 UTF-16 里占两个码元');
});

test('normalizeQuery 把异体字折到与常用字形相同的键', () => {
  // 这是这个特性存在的全部意义：两者必须查得到同一条词。
  assert.equal(normalizeQuery('神'), normalizeQuery('神'));
  assert.equal(normalizeQuery('髙'), normalizeQuery('高'));
  // 片假名折叠与它共存，不互相破坏。
  assert.equal(normalizeQuery('神社'), normalizeQuery('神社'));
  assert.equal(normalizeQuery('カタカナ'), normalizeQuery('かたかな'));
});
