import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContextGroups } from '../src/core/comic/context-groups';
import type { TextBlock } from '../src/shared/types';

function line(text: string, box: [number, number, number, number], vertical: boolean): TextBlock {
  return {
    box,
    vertical,
    fontSize: vertical ? box[2] - box[0] : box[3] - box[1],
    lines: [text],
    singleLine: true,
  };
}

test('竖排相邻列聚成一个上下文框，并按从右到左拼接', () => {
  const groups = buildContextGroups([
    line('左列', [100, 100, 130, 240], true),
    line('右列', [136, 90, 166, 230], true),
    line('别框', [300, 400, 330, 500], true),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0]?.indices, [1, 0]);
  assert.equal(groups[0]?.text, '右列左列');
  assert.deepEqual(groups[0]?.box, [100, 90, 166, 240]);
  assert.equal(groups[0]?.starts[1], 0);
  assert.equal(groups[0]?.starts[0], 2);
});

test('横排相邻行聚成一个上下文框，并按从上到下拼接', () => {
  const groups = buildContextGroups([
    line('第二行', [100, 140, 280, 170], false),
    line('第一行', [90, 104, 300, 134], false),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]?.indices, [1, 0]);
  assert.equal(groups[0]?.text, '第一行第二行');
});

test('距离远的气泡不合并，第三方 mokuro 区域也保持独立', () => {
  const imported: TextBlock = {
    box: [0, 0, 100, 200],
    vertical: true,
    fontSize: 25,
    lines: ['整块', '原文'],
  };
  const groups = buildContextGroups([
    imported,
    line('近但独立', [105, 0, 135, 180], true),
    line('远处', [500, 500, 530, 650], true),
  ]);
  assert.equal(groups.length, 3);
  assert.equal(groups[0]?.text, '整块原文');
});

test('同列被 OCR 切成上下两段时仍归为一组', () => {
  const groups = buildContextGroups([
    line('上半', [100, 100, 132, 180], true),
    line('下半', [102, 190, 134, 280], true),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.text, '上半下半');
});
