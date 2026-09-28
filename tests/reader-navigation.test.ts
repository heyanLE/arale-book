import assert from 'node:assert/strict';
import test from 'node:test';
import { turnForReaderEdge } from '../src/shared/reader-navigation';

test('阅读器边缘点击遵循当前 LTR 顺序', () => {
  assert.equal(turnForReaderEdge('ltr', 'left'), 'back');
  assert.equal(turnForReaderEdge('ltr', 'right'), 'forward');
});

test('阅读器边缘点击遵循当前 RTL 顺序', () => {
  assert.equal(turnForReaderEdge('rtl', 'left'), 'forward');
  assert.equal(turnForReaderEdge('rtl', 'right'), 'back');
});
