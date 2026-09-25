/**
 * **跨方块划词**的单测。
 *
 * 守的是用户报的那个现象：「跨行划词划不了」。文字层一个文字行/列一个方块，所以一句话
 * 换行就在两个方块里；而旧实现把整个拖动锁在「按下时那一块」上（`start.block !== block`
 * 直接 return），跨行时第二行根本进不了选区。
 *
 * 这块之所以要纯函数 + 单测：跨行到底选到哪几个字、上下文偏移对不对、换行有没有去掉，
 * 肉眼只能看到一条高亮，看不出「锚点那一段是从中间开始的」这种错。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SELECT_GAP_TOLERANCE_PX,
  buildSelection,
  pickBlockAt,
  selectionContext,
  selectionRanges,
  selectionText,
} from '../src/core/comic/selection';
import { boundaryAt } from '../src/core/comic/text-geometry';
import type { TextBlock } from '../src/shared/types';

function row(text: string, top: number, height = 30): TextBlock {
  return {
    box: [100, top, 100 + text.length * 30, top + height],
    vertical: false,
    fontSize: 30,
    lines: [text],
    singleLine: true,
  };
}

/** 三行旁白，横排，行距 40（行高 30，所以行间空白 10px）。 */
const LINES: TextBlock[] = [
  row('今日はいい天気ですね。', 100), // 11 字
  row('明日は雨が降るそうです。', 140), // 12 字
  row('だから傘を持って行きます。', 180), // 13 字
];

test('跨两行：首行从中间到行尾 + 次行从行首到中间', () => {
  // 「今日はいい天気ですね。」= 今0 日1 は2 い3 い4 天5 …。boundary 4 就落在第 2 个「い」前面。
  const ranges = selectionRanges(
    LINES,
    { block: 0, boundary: 4 },
    { block: 1, boundary: 5 },
  );
  assert.deepEqual(ranges, [
    { index: 0, from: 4, to: 11 },
    { index: 1, from: 0, to: 5 },
  ]);
  assert.equal(selectionText(LINES, ranges), 'い天気ですね。明日は雨が');
});

test('跨三行：中间整行都进来（这就是「跨矩形划词」）', () => {
  const ranges = selectionRanges(
    LINES,
    { block: 0, boundary: 2 },
    { block: 2, boundary: 3 },
  );
  assert.deepEqual(ranges, [
    { index: 0, from: 2, to: 11 },
    { index: 1, from: 0, to: 12 },
    { index: 2, from: 0, to: 3 },
  ]);
  assert.equal(selectionText(LINES, ranges), 'はいい天気ですね。明日は雨が降るそうです。だから');
});

test('反向拖动（从下往上划）与正向得到同一组区间', () => {
  const forward = selectionRanges(LINES, { block: 0, boundary: 2 }, { block: 2, boundary: 3 });
  const backward = selectionRanges(LINES, { block: 2, boundary: 3 }, { block: 0, boundary: 2 });
  assert.deepEqual(backward, forward);
});

test('同一个方块内仍然是两端之间（单块行为不变）', () => {
  const ranges = selectionRanges(LINES, { block: 1, boundary: 9 }, { block: 1, boundary: 3 });
  assert.deepEqual(ranges, [{ index: 1, from: 3, to: 9 }]);
  assert.equal(selectionText(LINES, ranges), '雨が降るそう');
});

test('★ 拼接处不插换行，而且原文里的换行符也被去掉', () => {
  // 跨行拼接绝不能自己插 `\n`：日文原文换行不多一个字符，插进去只会让查词断掉。
  const joined = selectionText(LINES, selectionRanges(LINES, { block: 0, boundary: 5 }, { block: 1, boundary: 5 }));
  assert.ok(!joined.includes('\n'), `不该有换行：${JSON.stringify(joined)}`);
  assert.equal(joined, '天気ですね。明日は雨が');

  // 生产者把换行写进 lines[i] 的脏数据（mokuro 系有过）：也要去掉，不能带进词卡/LLM。
  const dirty: TextBlock[] = [{ box: [0, 0, 100, 30], vertical: false, fontSize: 30, lines: ['あ\nい', 'う\r\nえ'], singleLine: true }];
  const dirtyText = dirty[0]!.lines.join(''); // 'あ\nい' + 'う\r\nえ' = 7 个字符（4 个是换行）
  assert.equal(dirtyText.length, 7);
  const ranges = selectionRanges(dirty, { block: 0, boundary: 0 }, { block: 0, boundary: 7 });
  assert.equal(ranges[0]?.to, 7, '边界按原串算（与几何层同口径），换行只影响输出文本');
  assert.equal(selectionText(dirty, ranges), 'あいうえ');
});

test('上下文偏移：查词用的是「被选中那几块拼起来」的串，start/end 与用户框住的一致', () => {
  const result = buildSelection(LINES, { block: 0, boundary: 4 }, { block: 1, boundary: 5 });
  // context 从第一块的开头开始（不是从选区开头），这样偏移里「前面还有什么」是完整的。
  assert.equal(result.context, '今日はいい天気ですね。明日は雨が降るそうです。');
  assert.equal(result.start, 4);
  assert.equal(result.end, 11 + 5);
  assert.equal(result.context.slice(result.start, result.end), 'い天気ですね。明日は雨が');
  assert.equal(result.text, 'い天気ですね。明日は雨が');

  // 首块被整块选中时 start 就是 0；末块到行尾时 end 就是 context.length。
  const whole = buildSelection(LINES, { block: 0, boundary: 0 }, { block: 1, boundary: 12 });
  assert.equal(whole.start, 0);
  assert.equal(whole.end, whole.context.length);
});

test('空文本的方块不产生空区间，也不占偏移', () => {
  const withEmpty: TextBlock[] = [LINES[0]!, row('', 140), LINES[2]!];
  const result = buildSelection(withEmpty, { block: 0, boundary: 0 }, { block: 2, boundary: 2 });
  assert.deepEqual(
    result.ranges.map((range) => range.index),
    [0, 2],
  );
  // 第三块只取了前两个字，但 context 是**整块**拼起来的（偏移才不用换算）。
  assert.equal(result.context, '今日はいい天気ですね。だから傘を持って行きます。');
  assert.equal(result.text, '今日はいい天気ですね。だか');
  assert.equal(result.context.slice(result.start, result.end), result.text);
});

test('越界的锚点/边界被夹住，不抛也不越界', () => {
  const ranges = selectionRanges(LINES, { block: -5, boundary: -3 }, { block: 99, boundary: 99 });
  assert.deepEqual(
    ranges.map((range) => range.index),
    [0, 1, 2],
  );
  assert.equal(selectionText(LINES, ranges), '今日はいい天気ですね。明日は雨が降るそうです。だから傘を持って行きます。');
});

// ---------------------------------------------------------------------------
// 矩形距离宽容度：指针落在方块之间的空白里也要能继续拖
// ---------------------------------------------------------------------------

/** 三行在**视口**里的矩形（与 LINES 同构，缩放 1:1）。 */
const RECTS: Array<[number, number, number, number]> = [
  [100, 100, 430, 130],
  [100, 140, 460, 170],
  [100, 180, 490, 210],
];

test('宽容度：指针在方块内 → 命中那一块', () => {
  assert.equal(pickBlockAt(RECTS, 200, 115), 0);
  assert.equal(pickBlockAt(RECTS, 200, 155), 1);
});

test('★ 宽容度：指针落在行间空白（方块外）→ 吸附最近的一块', () => {
  // 第 0 行下面 5px，离第 0、1 行都只有 5px，取最近的那个（顺序上先遇到的第 0 行）。
  const index = pickBlockAt(RECTS, 200, 135);
  assert.ok(index === 0 || index === 1, `应吸附到相邻行，实际 ${index}`);
  // 明显更靠近第 1 行时，必须给第 1 行。
  assert.equal(pickBlockAt(RECTS, 200, 138), 1);
});

test('★ 宽容度：超过阈值就返回 null（宁可保持上一次落点，也不跳到远处的块）', () => {
  const far = 100 + SELECT_GAP_TOLERANCE_PX + 10; // 第 2 行下方再远一点
  assert.equal(pickBlockAt(RECTS, 200, 210 + far - 100), null);
  // 阈值之内仍然命中。
  assert.notEqual(pickBlockAt(RECTS, 200, 210 + SELECT_GAP_TOLERANCE_PX - 2), null);
});

test('宽容度：重叠的方块取面积更小的那个（粗框里的小行才是用户指着的）', () => {
  const overlapping: Array<[number, number, number, number]> = [
    [0, 0, 200, 200], // 面积 40000：区域级粗框
    [40, 40, 120, 80], // 面积 3200：真正的那一行
  ];
  assert.equal(pickBlockAt(overlapping, 80, 60), 1);
});

test('宽容度：缺项的矩形（undefined）被跳过', () => {
  assert.equal(pickBlockAt([undefined, RECTS[1]], 200, 155), 1);
  assert.equal(pickBlockAt([], 0, 0), null);
});

test('宽容度与真实几何对得上：行间空白处仍能算出这一行内的字符边界', () => {
  // 指针在第 1 行下方 2px（行外，第 2 行还差 8px）→ 吸附到第 1 行，boundaryAt 夹到行内。
  const index = pickBlockAt(RECTS, 200, 172);
  assert.equal(index, 1);
  const block = LINES[index]!;
  const boundary = boundaryAt(block, 200, 172);
  assert.ok(boundary >= 0 && boundary <= block.lines.join('').length);
});
