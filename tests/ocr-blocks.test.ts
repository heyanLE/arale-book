/**
 * 「行 → 文字块」这一步的单测（`core/ocr/blocks.ts` 的 `blocksFromLines`）。
 *
 * 这一步以前在**每个引擎里各写了一份**（系统 OCR 一份、扩展一份，注释还写着「必须是公用的」），
 * 现在引擎只吐「文字 + 框 + 朝向」，排序成块在应用侧做一次。所以这里钉的是这条新边界：
 * 引擎说什么就是什么，它说不准的（朝向）由框兜底，阅读顺序由方向决定。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blocksFromLines } from '../src/core/ocr/blocks';
import type { OcrLine } from '../src/core/ocr/types';

function line(text: string, box: [number, number, number, number], vertical = false): OcrLine {
  return { text, box, vertical, confidence: 1 };
}

test('空输入 → 空结果（引擎可能整页都没识别到）', () => {
  assert.deepEqual(blocksFromLines([], 'rtl'), []);
  assert.deepEqual(blocksFromLines([], 'ltr'), []);
});

test('★ 日漫右起：direction=rtl 时右边的行排在前面', () => {
  const left = line('左', [0, 100, 90, 130]);
  const right = line('右', [100, 100, 190, 130]);
  const rtl = blocksFromLines([left, right], 'rtl');
  const ltr = blocksFromLines([left, right], 'ltr');
  assert.equal(rtl[0]?.lines[0], '右', 'RTL：右边先');
  assert.equal(ltr[0]?.lines[0], '左', 'LTR：左边先');
  assert.equal(rtl.length, 2);
});

test('★ 引擎不给朝向时按框的宽高比兜底（窄高 = 竖排）', () => {
  // 窄高（100/20 = 5）但引擎说横排 → 按竖排处理；否则一点一列的命中框会算错。
  const tall = line('竖', [0, 0, 20, 100], false);
  const wide = line('横', [0, 200, 200, 230], false);
  const blocks = blocksFromLines([tall, wide], 'rtl');
  const byText = new Map(blocks.map((block) => [block.lines[0], block]));
  assert.equal(byText.get('竖')?.vertical, true, '窄高框兜底成竖排');
  assert.equal(byText.get('横')?.vertical, false, '宽扁框仍是横排');
});

test('引擎说竖排就竖排（哪怕框是宽的：倾斜的手写体常见）', () => {
  const blocks = blocksFromLines([line('竖', [0, 0, 120, 130], true)], 'rtl');
  assert.equal(blocks[0]?.vertical, true);
});

test('每个块都带 singleLine 承诺（一个文字行/列一个块）', () => {
  const blocks = blocksFromLines([line('あ', [0, 0, 30, 30]), line('い', [0, 40, 30, 70])], 'rtl');
  assert.equal(blocks.length, 2);
  for (const block of blocks) assert.equal(block.singleLine, true);
});

test('空文本的行被丢掉（留一个没有文字的可点区域只会让人点到空气）', () => {
  const blocks = blocksFromLines([line('  ', [0, 0, 30, 30]), line('あ', [0, 40, 30, 70])], 'rtl');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.lines[0], 'あ');
});

test('退化框（零宽/零高）不抛', () => {
  assert.doesNotThrow(() => blocksFromLines([line('あ', [5, 5, 5, 5])], 'rtl'));
});
