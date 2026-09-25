/**
 * 双页配对（`core/comic/spread.ts`）的单测。
 *
 * 这块逻辑只有十几行，但它是「封面单独成页」这个功能的全部依据，而且**只有真书**
 * 才会暴露错误：总页数是奇数、偏移量比书还厚、用户改偏移量时正停在半页上。
 * 所以这里逐条钉住边界，而不是只测一个中间值。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SPREAD_OFFSETS,
  SPREAD_OFFSET_MAX,
  clampSpreadOffset,
  spreadOffsetLabel,
  spreadPages,
  spreadPlan,
  stepSpread,
} from '../src/core/comic/spread';

test('clampSpreadOffset: 夹到 0..4，非法值当 0', () => {
  assert.equal(clampSpreadOffset(0), 0);
  assert.equal(clampSpreadOffset(4), 4);
  assert.equal(clampSpreadOffset(9), SPREAD_OFFSET_MAX);
  assert.equal(clampSpreadOffset(-3), 0);
  assert.equal(clampSpreadOffset(2.7), 2);
  // localStorage 里可能是任何东西（旧版本、手改、别的应用写的）。
  assert.equal(clampSpreadOffset('2'), 0);
  assert.equal(clampSpreadOffset(Number.NaN), 0);
  assert.equal(clampSpreadOffset(undefined), 0);
  assert.equal(clampSpreadOffset(null), 0);
});

test('SPREAD_OFFSETS: 恰好 5 个选项（0..4）', () => {
  assert.deepEqual([...SPREAD_OFFSETS], [0, 1, 2, 3, 4]);
});

test('spreadPlan: 偏移 0 —— 一开始就双页', () => {
  // (1,2) (3,4) (5,6) …
  assert.deepEqual(spreadPlan(0, 10, 0, true), { start: 0, size: 2 });
  assert.deepEqual(spreadPlan(1, 10, 0, true), { start: 0, size: 2 });
  assert.deepEqual(spreadPlan(2, 10, 0, true), { start: 2, size: 2 });
  assert.deepEqual(spreadPlan(9, 10, 0, true), { start: 8, size: 2 });
});

test('spreadPlan: 偏移 1 —— 第 1 页单独，2-3 / 4-5 配对', () => {
  // 这是最常见的情形（第 1 页是表紙）。
  assert.deepEqual(spreadPlan(0, 10, 1, true), { start: 0, size: 1 });
  assert.deepEqual(spreadPlan(1, 10, 1, true), { start: 1, size: 2 });
  assert.deepEqual(spreadPlan(2, 10, 1, true), { start: 1, size: 2 });
  assert.deepEqual(spreadPlan(3, 10, 1, true), { start: 3, size: 2 });
  assert.deepEqual(spreadPlan(4, 10, 1, true), { start: 3, size: 2 });
});

test('spreadPlan: 偏移 2 —— 前两页单独，3-4 / 5-6 配对', () => {
  assert.deepEqual(spreadPlan(0, 10, 2, true), { start: 0, size: 1 });
  assert.deepEqual(spreadPlan(1, 10, 2, true), { start: 1, size: 1 });
  assert.deepEqual(spreadPlan(2, 10, 2, true), { start: 2, size: 2 });
  assert.deepEqual(spreadPlan(3, 10, 2, true), { start: 2, size: 2 });
  assert.deepEqual(spreadPlan(4, 10, 2, true), { start: 4, size: 2 });
});

test('spreadPlan: 书尾落单的最后一页只显示一页', () => {
  // 总数 5、偏移 0 → (1,2) (3,4) | 5
  assert.deepEqual(spreadPlan(4, 5, 0, true), { start: 4, size: 1 });
  // 总数 6、偏移 1 → 1 | (2,3) (4,5) | 6
  assert.deepEqual(spreadPlan(5, 6, 1, true), { start: 5, size: 1 });
});

test('spreadPlan: 单页模式下偏移量不生效（一页就是一个跨页）', () => {
  assert.deepEqual(spreadPlan(0, 10, 3, false), { start: 0, size: 1 });
  assert.deepEqual(spreadPlan(7, 10, 3, false), { start: 7, size: 1 });
});

test('spreadPlan: 空书 / 越界下标不抛，且给出安全值', () => {
  assert.deepEqual(spreadPlan(0, 0, 0, true), { start: 0, size: 0 });
  assert.deepEqual(spreadPlan(5, 0, 2, false), { start: 0, size: 0 });
  // 越界往上夹到最后一页，往下夹到第一页。
  assert.deepEqual(spreadPlan(99, 4, 0, true), { start: 2, size: 2 });
  assert.deepEqual(spreadPlan(-5, 4, 0, true), { start: 0, size: 2 });
});

test('spreadPlan: 偏移量比整本书还大时，每一页都单独显示', () => {
  assert.deepEqual(spreadPlan(0, 3, 4, true), { start: 0, size: 1 });
  assert.deepEqual(spreadPlan(2, 3, 4, true), { start: 2, size: 1 });
});

test('stepSpread: 偏移 1 时往前是 +1 再 +2（偏移不是步长）', () => {
  // 0(单) → 1(跨) → 3(跨) → 5(跨) …
  assert.equal(stepSpread(0, 10, 1, true, true), 1);
  assert.equal(stepSpread(1, 10, 1, true, true), 3);
  assert.equal(stepSpread(3, 10, 1, true, true), 5);
  // 往回：从 3 的跨页回退落在 1（而不是 2 —— 2 是那一跨页的第二页）。
  assert.equal(stepSpread(3, 10, 1, true, false), 1);
  // 下标 2 是 (1,2) 这一跨页的**第二页**，不是它自己的跨页起点。
  // 往回翻要退到「上一跨页」= 第 1 页(index 0)，而不是 1（那样会卡在同一跨页里）。
  assert.equal(stepSpread(2, 10, 1, true, false), 0, '半页下标要先归位再回退');
  assert.equal(stepSpread(1, 10, 1, true, false), 0);
});

test('stepSpread: 到头/到尾返回当前页（幂等，不会卡在非对齐下标）', () => {
  assert.equal(stepSpread(0, 10, 1, true, false), 0);
  assert.equal(stepSpread(8, 10, 0, true, true), 8, '最后一跨页再往后还是它自己');
  assert.equal(stepSpread(9, 10, 1, true, true), 9, '书尾单页再往后还是它自己');
  assert.equal(stepSpread(0, 0, 0, true, true), 0);
});

test('stepSpread: 单页模式下就是 ±1', () => {
  assert.equal(stepSpread(3, 10, 2, false, true), 4);
  assert.equal(stepSpread(3, 10, 2, false, false), 2);
  assert.equal(stepSpread(0, 10, 2, false, false), 0);
  assert.equal(stepSpread(9, 10, 2, false, true), 9);
});

test('spreadPages: 与 spreadPlan 一致，且永远不越界', () => {
  assert.deepEqual(spreadPages(0, 6, 1, true), [0]);
  assert.deepEqual(spreadPages(1, 6, 1, true), [1, 2]);
  assert.deepEqual(spreadPages(5, 6, 1, true), [5]);
  assert.deepEqual(spreadPages(0, 0, 0, true), []);
  // 每一页都必须落在 [0, total) 内 —— 凑页数时最容易在这里越界拿 undefined。
  for (const total of [1, 2, 3, 7, 8]) {
    for (const offset of SPREAD_OFFSETS) {
      for (let index = 0; index < total; index += 1) {
        for (const page of spreadPages(index, total, offset, true)) {
          assert.ok(page >= 0 && page < total, `越界：index=${index} total=${total} offset=${offset} → ${page}`);
        }
      }
    }
  }
});

test('stepSpread: 从头走到尾能覆盖每一个跨页，且每一步都前进', () => {
  for (const total of [1, 2, 3, 6, 7, 10]) {
    for (const offset of SPREAD_OFFSETS) {
      const seen: number[] = [];
      let cursor = 0;
      for (let guard = 0; guard < total + 2; guard += 1) {
        seen.push(cursor);
        const nextCursor = stepSpread(cursor, total, offset, true, true);
        if (nextCursor === cursor) break;
        // 单调前进：这是「翻页不会来回跳」的形式化表述。
        assert.ok(nextCursor > cursor, `不前进：total=${total} offset=${offset} ${cursor} → ${nextCursor}`);
        cursor = nextCursor;
      }
      // 最后一个跨页必须恰好包含最后一页。
      const last = seen[seen.length - 1]!;
      const plan = spreadPlan(last, total, offset, true);
      assert.equal(plan.start + plan.size, total, `没走到书尾：total=${total} offset=${offset}`);
      // 反向走一遍必须原路返回。
      let back = cursor;
      for (let i = seen.length - 1; i >= 0; i -= 1) {
        assert.equal(back, seen[i], `反向不回原路：total=${total} offset=${offset}`);
        back = stepSpread(back, total, offset, true, false);
      }
    }
  }
});

test('spreadOffsetLabel: 偏移 0 与 1 的文案要点明「第 1 页单独」', () => {
  assert.match(spreadOffsetLabel(0), /第 1 页起就并排/);
  assert.match(spreadOffsetLabel(1), /前 1 页单独/);
  assert.match(spreadOffsetLabel(1), /2-3/);
  assert.match(spreadOffsetLabel(2), /3-4/);
  // 非法值也要给出能看的文案，而不是 "前 NaN 页单独"。
  assert.match(spreadOffsetLabel(Number.NaN), /第 1 页起就并排/);
});
