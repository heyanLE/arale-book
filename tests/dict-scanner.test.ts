/**
 * scanner.ts 单测：`scan_candidates` 的移植正确性（顺序、词边界、空白、码点）。
 */

import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_SCAN_LENGTH, codePoints, scanCandidates } from '../src/core/dict/scanner';

test('默认扫描长度是 16（Fushi 的 defaultScanLength）', () => {
  assert.equal(DEFAULT_SCAN_LENGTH, 16);
});

test('日语逐码点：食べました 产出全部前缀，由长到短', () => {
  assert.deepEqual(scanCandidates('食べました'), ['食べました', '食べまし', '食べま', '食べ', '食']);
});

test('拉丁词不在单词中间切：hello 只产出自己', () => {
  assert.deepEqual(scanCandidates('hello'), ['hello']);
  assert.deepEqual(scanCandidates('привет'), ['привет']); // 西里尔同理
});

test('拉丁词 + 空格：整体与首个单词，空白结尾的前缀被丢弃', () => {
  assert.deepEqual(scanCandidates('hello world'), ['hello world', 'hello']);
  // 'ab ' 以空白结尾 → 丢；'ab 食' / 'ab 食' 保留，'ab' 保留；'a' 被拉丁词边界挡住。
  assert.deepEqual(scanCandidates('ab 食べ'), ['ab 食べ', 'ab 食', 'ab']);
});

test('scanLength 截断窗口（由长到短）', () => {
  assert.deepEqual(scanCandidates('食べました', 3), ['食べま', '食べ', '食']);
  assert.deepEqual(scanCandidates('hello', 0), []);
  assert.deepEqual(scanCandidates('', 16), []);
});

test('默认 16 码点上限：20 个假名只产出 16 个候选，最长的是前 16 个', () => {
  const text = 'あ'.repeat(20);
  const candidates = scanCandidates(text);
  assert.equal(candidates.length, 16);
  assert.equal(candidates[0], 'あ'.repeat(16));
  assert.equal(candidates[15], 'あ');
});

test('标点切点合法（不是空格分词类字母）', () => {
  // 逗号两侧不算「两个字母」，所以 'hello,' 与 'hello' 都能被切出来。
  assert.deepEqual(scanCandidates('hello,world'), ['hello,world', 'hello,', 'hello']);
});

test('codePoints 处理代理对', () => {
  assert.equal(codePoints('𠮷a').length, 2);
  assert.deepEqual(scanCandidates('𠮷a'), ['𠮷a', '𠮷']);
});
