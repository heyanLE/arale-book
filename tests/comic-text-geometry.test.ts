/**
 * 漫画文字层命中/选区几何的单测。
 *
 * 这块连续三轮出问题，而**每次 GUI 烟测都是绿的**：
 * 1. 高亮坐标口径错 → 被 `overflow:hidden` 裁掉（DOM 在、看不见）；
 * 2. 反向拖动区间未排序 → 一个字都不高亮；
 * 3. 用 `block.lines` 当行列结构 → 竖排多列退化成按 y 线性取字，
 *    往下划选出整句话、词尾多出内容。
 *
 * 三次的共同点：**只在特定数据形状下错**。所以这里不测「函数能跑」，而是把三种真实
 * 数据形状钉死：竖排单列、竖排多列、横排单行——以及高亮矩形必须落在方块内。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { boundaryAt, charIndexAt, charRangeRects } from '../src/core/comic/text-geometry';
import { parseMangaJson, serializeMangaJson } from '../src/core/comic/mokuro';
import { buildBlocks } from '../src/core/ocr/blocks';
import type { OcrBox } from '../src/core/ocr/types';
import type { TextBlock } from '../src/shared/types';

function block(over: Partial<TextBlock> & { box: [number, number, number, number]; text: string }): TextBlock {
  const { box, text, ...rest } = over;
  return {
    box,
    vertical: true,
    fontSize: 26,
    // 真实数据里 mokuro 的竖排是「一行一个字」；这里默认按整块一行给，
    // 具体形状由每个用例自己指定。
    lines: [text],
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// 竖排单列（实测的样例数据形状）
// ---------------------------------------------------------------------------

const SAMPLE = block({
  box: [700, 100, 752, 720],
  text: '吾輩は猫である。名前はまだ無い。', // 16 字
  lines: Array.from('吾輩は猫である。名前はまだ無い。'),
});

test('竖排单列：字符序号由 y 决定，x 不影响（旧版正好相反）', () => {
  const text = SAMPLE.lines.join('');
  const first = charIndexAt(SAMPLE, 726, 110);
  const last = charIndexAt(SAMPLE, 726, 710);
  assert.equal(first, 0, '顶部应是第一个字');
  assert.equal(last, text.length - 1, '底部应是最后一个字');

  // 同一高度、横向移动 → 序号不变（这是「往一个方向直着拖只选一条列」的前提）。
  assert.equal(charIndexAt(SAMPLE, 702, 110), first);
  assert.equal(charIndexAt(SAMPLE, 750, 110), first);
});

test('竖排单列：从中间往下拖，选中的是连续一段而不是整句', () => {
  const text = SAMPLE.lines.join('');
  const from = charIndexAt(SAMPLE, 726, 200);
  const to = charIndexAt(SAMPLE, 726, 320);
  assert.ok(to > from, `往下拖序号应增大：${from} → ${to}`);
  const picked = text.slice(from, to + 1);
  assert.ok(picked.length < text.length, `不该是整句：${JSON.stringify(picked)}`);
  assert.equal(picked, text.slice(from, to + 1));
});

test('竖排单列：高亮铺满列宽、高度只覆盖选中的那几个字', () => {
  const rects = charRangeRects(SAMPLE, 0, 4);
  assert.equal(rects.length, 1, '单列只该有一个矩形');
  const [x1, y1, x2, y2] = rects[0]!;
  assert.equal(x1, 0);
  assert.equal(x2, 52, '应铺满方块宽度（这一列就是整块宽）');
  assert.ok(y1 === 0 && y2 > 0 && y2 < 620, `高度应只覆盖一部分：${y1}..${y2}`);
});

// ---------------------------------------------------------------------------
// 竖排多列（用户报的「两排」形状）
// ---------------------------------------------------------------------------

// 2 列 × 10 字，字格 30px：紧贴的方块是 60 × 300。字号 30 → 字格近似正方形。
const TWO_COLUMN = block({
  box: [0, 0, 60, 300],
  text: 'あいうえおかきくけこさしすせそたちつてと', // 20 字
  fontSize: 30,
});

test('竖排两列：x 决定第几列（第 0 列在最右）', () => {
  const text = TWO_COLUMN.lines.join(''); // 20 字
  const right = charIndexAt(TWO_COLUMN, 45, 5); // 右列
  const left = charIndexAt(TWO_COLUMN, 15, 5); // 左列
  assert.equal(right, 0, '右列第一个字应是全句第一个');
  assert.equal(left, 10, '左列第一个字应是第 10 个字（0 基）');
  assert.equal(text.slice(left, left + 1), 'さ');
});

test('竖排两列：在右列里直着往下拖，绝不会选到左列的字', () => {
  const text = TWO_COLUMN.lines.join('');
  const from = charIndexAt(TWO_COLUMN, 45, 10);
  const to = charIndexAt(TWO_COLUMN, 45, 290);
  assert.ok(from >= 0 && to >= 0);
  assert.ok(from < 10 && to < 10, `两端都必须落在右列：${from}..${to}`);
  const picked = text.slice(from, to + 1);
  assert.ok(!picked.includes('さ'), `不该溢出到左列：${JSON.stringify(picked)}`);
});

test('竖排两列：高亮只覆盖被划的那一列，不是整块宽度', () => {
  const rects = charRangeRects(TWO_COLUMN, 0, 5); // 只在右列
  assert.equal(rects.length, 1);
  const rect = rects[0]!;
  const [x1, , x2] = rect;
  assert.ok(x2 - x1 <= 30.5, `宽度应约等于一列（30px），实际 ${x2 - x1}`);
  assert.ok(x1 >= 29 && x2 <= 60.5, '应落在右半部分');
});

test('竖排两列：跨列拖动时两列都高亮', () => {
  const rects = charRangeRects(TWO_COLUMN, 5, 15);
  assert.equal(rects.length, 2, '跨列应有两块');
  // 高的（更长的）那部分在右列，短的那部分在左列。
  assert.ok(rects.some((r) => r[0] >= 29), '应包含右列的一块');
  assert.ok(rects.some((r) => r[2] <= 31), '应包含左列的一块');
});

// ---------------------------------------------------------------------------
// 横排
// ---------------------------------------------------------------------------

const ONE_ROW = block({
  box: [0, 0, 400, 60],
  text: '今日はいい天気ですね。', // 11 字
  vertical: false,
  fontSize: 26,
});

test('横排单行：字符序号由 x 决定，y 不影响', () => {
  const text = ONE_ROW.lines.join('');
  assert.equal(charIndexAt(ONE_ROW, 5, 30), 0);
  assert.equal(charIndexAt(ONE_ROW, 395, 30), text.length - 1);
  assert.equal(charIndexAt(ONE_ROW, 5, 5), charIndexAt(ONE_ROW, 5, 55));
});

test('横排单行：高亮是一条横带', () => {
  const rects = charRangeRects(ONE_ROW, 2, 6);
  assert.equal(rects.length, 1);
  const [x1, y1, x2, y2] = rects[0]!;
  assert.ok(y2 - y1 >= 59, '应铺满行高');
  assert.ok(x1 > 0 && x2 < 400, '宽度只覆盖选中的几个字');
});

// 两行 × 5 字、字格 30px → 紧贴的方块是 150 × 60。
// （写成 300 宽就是「1 行、格子 30×60」，那才是 1 行——fixture 必须与真实排版一致。）
const TWO_ROW = block({
  box: [0, 0, 150, 60],
  text: 'あいうえおかきくけこ', // 10 字
  vertical: false,
  fontSize: 30,
});

test('横排两行：y 决定第几行', () => {
  assert.equal(charIndexAt(TWO_ROW, 5, 5), 0);
  assert.equal(charIndexAt(TWO_ROW, 5, 55), 5, '第二行第一个字应是第 5 个字（0 基）');
});

// ---------------------------------------------------------------------------
// 不变式
// ---------------------------------------------------------------------------

test('不变式：序号永远落在 [0, 字数)', () => {
  const cases = [SAMPLE, TWO_COLUMN, ONE_ROW, TWO_ROW];
  for (const b of cases) {
    const length = b.lines.join('').length;
    for (const [x, y] of [[-50, -50], [0, 0], [5000, 5000], [10, 5000], [5000, 10]] as const) {
      const index = charIndexAt(b, x, y);
      assert.ok(index >= 0 && index < length, `越界：${index} / ${length} @ ${x},${y}`);
    }
  }
});

test('不变式：高亮矩形一定落在方块内（否则会被 overflow:hidden 裁掉）', () => {
  const cases = [
    { b: SAMPLE, w: 52, h: 620 },
    { b: TWO_COLUMN, w: 60, h: 300 },
    { b: ONE_ROW, w: 400, h: 60 },
    { b: TWO_ROW, w: 150, h: 60 },
  ];
  for (const { b, w, h } of cases) {
    const length = b.lines.join('').length;
    for (const [from, to] of [[0, length], [0, 1], [3, 7], [length - 1, length]] as const) {
      for (const rect of charRangeRects(b, from, to)) {
        const x1 = rect[0]!;
        const y1 = rect[1]!;
        const x2 = rect[2]!;
        const y2 = rect[3]!;
        assert.ok(x1 >= -0.001 && y1 >= -0.001 && x2 <= w + 0.001 && y2 <= h + 0.001,
          `越界矩形 ${JSON.stringify(rect)} 在 ${w}x${h} 内`);
        assert.ok(x2 > x1 && y2 > y1, `退化矩形 ${JSON.stringify(rect)}`);
      }
    }
  }
});

test('不变式：反向拖动与正向拖动产生同样的高亮（只是方向不同）', () => {
  for (const b of [SAMPLE, TWO_COLUMN, ONE_ROW, TWO_ROW]) {
    const forward = charRangeRects(b, 2, 7);
    const backward = charRangeRects(b, 7, 2);
    assert.equal(backward.length, forward.length, '反向拖动不该少画块');
    for (let i = 0; i < forward.length; i += 1) {
      const a = forward[i]!;
      const c = backward[i]!;
      for (let k = 0; k < 4; k += 1) {
        assert.ok(Math.abs(a[k]! - c[k]!) < 0.001, `第 ${i} 块不一致：${JSON.stringify([a, c])}`);
      }
    }
  }
});

test('不变式：高亮范围与 charIndexAt 选出的文字是同一段', () => {
  // 从两个真实点位取序号，再用这两个序号画高亮 —— 这是划词的实际流程。
  const from = charIndexAt(TWO_COLUMN, 45, 40);
  const to = charIndexAt(TWO_COLUMN, 45, 250);
  const rects = charRangeRects(TWO_COLUMN, from, to);
  assert.ok(rects.length > 0, '必须有高亮');
  // 高亮的纵向范围应当覆盖这两个点（都在右列 y 的 40..250 之间）。
  const rect = rects[0]!;
  const x1 = rect[0]!;
  const y1 = rect[1]!;
  const x2 = rect[2]!;
  const y2 = rect[3]!;
  // 注意 `hi` 是**开区间**：拖到 y=250 时最后选中的是第 8 个字（其格子从 y=240 开始），
  // 所以高亮到 240 为止是对的 —— 这里断言的是「覆盖被选中的那些字」，不是「覆盖鼠标终点」。
  assert.ok(y1 <= 40 && y2 >= 240 - 1, `高亮应覆盖选中的字：${y1}..${y2}`);
  assert.ok(x1 >= 29 && x2 <= 60.5, '且只在右列');
});

test('边界：格内前半在本字之前、后半在本字之后（「多一个字」就是这条的缺失）', () => {
  // 横排 400 宽 11 字 → 格宽 36.36。
  const cell = 400 / 11;
  const at = (i: number, frac: number) => boundaryAt(ONE_ROW, i * cell + cell * frac, 30);
  assert.equal(at(2, 0.2), 2, '第 2 格前半 → 边界在「は」之前');
  assert.equal(at(2, 0.8), 3, '第 2 格后半 → 边界在「は」之后');
  // 这就是关键：指针刚越过第 3 格的左边缘时，**还不该**把第 3 个字算进来。
  assert.equal(at(3, 0.1), 3, '刚进第 3 格 → 边界仍在它之前（旧版会把它选进来）');
});

test('边界：指针刚进下一格时不再多选那个字（用户报的「后面总是多一个字」）', () => {
  const cell = 400 / 11;
  const text = ONE_ROW.lines.join(''); // 今日はいい天気ですね。
  // 从第 2 格前半拖到第 5 格的**左边缘刚进去一点**（frac 0.1）。
  const startX = 2 * cell + cell * 0.4;
  const endX = 5 * cell + cell * 0.1;

  const b0 = boundaryAt(ONE_ROW, startX, 30);
  const b1 = boundaryAt(ONE_ROW, endX, 30);
  const picked = text.slice(Math.min(b0, b1), Math.max(b0, b1));
  assert.equal(picked, 'はいい', `边界口径应停在「い」为止，实际 ${JSON.stringify(picked)}`);

  // 旧口径（charIndexAt 取「光标下那个字」再 +1）会把刚碰到边缘的「天」也算进来。
  const oldFrom = charIndexAt(ONE_ROW, startX, 30);
  const oldTo = charIndexAt(ONE_ROW, endX, 30) + 1;
  const oldPicked = text.slice(oldFrom, oldTo);
  assert.equal(oldPicked, 'はいい天', '旧口径确实多一个「天」');
  assert.equal(oldPicked.length, picked.length + 1, '这就是「总是多一个字」');
});

test('边界：拖到某字中点才算把它选进来（与输入框一致）', () => {
  const cell = 400 / 11;
  // 第 5 格：前半不含它，后半含它。
  assert.equal(boundaryAt(ONE_ROW, 5 * cell + cell * 0.4, 30), 5, '中点之前 → 边界在它之前');
  assert.equal(boundaryAt(ONE_ROW, 5 * cell + cell * 0.6, 30), 6, '中点之后 → 边界在它之后');
});

test('边界：竖排同样按格内上下半决定', () => {
  // 样例竖排块 620 高 16 字 → 格高 38.75。
  const [,, , bottom] = SAMPLE.box;
  const cell = (bottom - SAMPLE.box[1]) / 16;
  const at = (i: number, frac: number) => boundaryAt(SAMPLE, 726, SAMPLE.box[1] + i * cell + cell * frac);
  assert.equal(at(3, 0.2), 3);
  assert.equal(at(3, 0.8), 4);
  assert.equal(at(0, 0.0), 0, '最顶端 → 边界 0');
});

test('边界：范围是 0..length（含末尾之后），不会越界', () => {
  for (const b of [SAMPLE, TWO_COLUMN, ONE_ROW, TWO_ROW]) {
    const length = b.lines.join('').length;
    for (const [x, y] of [[-999, -999], [0, 0], [9999, 9999], [0, 9999], [9999, 0]] as const) {
      const v = boundaryAt(b, x, y);
      assert.ok(v >= 0 && v <= length, `边界越界：${v} / ${length}`);
    }
  }
});

test('空文本 / 退化方块不抛', () => {
  const empty = block({ box: [0, 0, 10, 10], text: '' , lines: [] });
  assert.equal(charIndexAt(empty, 5, 5), 0);
  assert.deepEqual(charRangeRects(empty, 0, 3), []);
  const zero = block({ box: [0, 0, 0, 0], text: 'あ' });
  assert.doesNotThrow(() => charIndexAt(zero, 0, 0));
});

// ---------------------------------------------------------------------------
// `singleLine`：生产者声明「这个框里只有一段文字」
//
// 本项目自己的 OCR 引擎就是一个文字行/列一个 block（`buildBlocks` 打标），
// 第三方 `.mokuro` 才是「一个 block = 一个区域」。有声明时必须**不做**面积推断。
// ---------------------------------------------------------------------------

test('singleLine：竖排一列 7 个字，映射精确到每一格', () => {
  // 实测形状：manga-anki 的 022.jpg 里一个竖排列 40×222、「この中だったら」7 个字。
  const b = block({
    box: [1000, 100, 1040, 322],
    vertical: true,
    text: 'この中だったら',
    singleLine: true,
  });
  const cell = 222 / 7;
  for (let i = 0; i < 7; i += 1) {
    assert.equal(charIndexAt(b, 1020, 100 + i * cell + cell / 2), i, `第 ${i} 个字`);
  }
  // 高亮：整列宽度，纵向只覆盖选中的那几个字。
  const rects = charRangeRects(b, 1, 4);
  assert.equal(rects.length, 1);
  const [x1, y1, x2, y2] = rects[0]!;
  assert.equal(x1, 0);
  assert.equal(x2, 40, '竖排高亮要铺满列宽');
  assert.ok(Math.abs(y1 - cell) < 1e-6 && Math.abs(y2 - 4 * cell) < 1e-6);
});

test('singleLine：倾斜的一行不会被面积法误判成两行（残留偏移的最后一处）', () => {
  // 真实形状：手写体倾斜约 20°，一行 8 个字的外接矩形约 179×89。面积法算出
  // sqrt(179·89/8)=44.6 → 89/44.6=2.0 → 「2 行」，于是字被摊到两行上。
  const text = 'かわいいいい!!'; // 8 个字
  const tilted = { box: [100, 100, 279, 189] as [number, number, number, number], vertical: false, text };
  const guessed = block(tilted); // 没有声明 → 面积推断
  const declared = block({ ...tilted, singleLine: true });

  // 面积法：同一个 x 上、y 差一半就换段（错）。
  assert.notEqual(
    charIndexAt(guessed, 250, 110),
    charIndexAt(guessed, 250, 170),
    '无声明时面积法会把这一行当两行——正因如此才需要 singleLine',
  );
  // 有声明：y 完全不影响序号，字符沿长边等分。
  const cellWidth = 179 / text.length;
  for (let i = 0; i < text.length; i += 1) {
    const x = 100 + i * cellWidth + cellWidth / 2;
    assert.equal(charIndexAt(declared, x, 110), i, `第 ${i} 个字（上缘）`);
    assert.equal(charIndexAt(declared, x, 180), i, `第 ${i} 个字（下缘）`);
  }
  // 高亮是一条横带，不是两块。
  const rects = charRangeRects(declared, 0, text.length);
  assert.equal(rects.length, 1);
  assert.equal(rects[0]![1], 0);
  assert.equal(rects[0]![3], 89);
});

test('singleLine：边界（划词端点）与字符序号走同一套线性映射', () => {
  const b = block({ box: [0, 0, 300, 40], vertical: false, text: '今日はいい天気ですね。', singleLine: true });
  const cell = 300 / 11;
  assert.equal(boundaryAt(b, 0, 20), 0);
  assert.equal(boundaryAt(b, cell * 3 + 1, 20), 3);
  assert.equal(boundaryAt(b, cell * 3 + cell * 0.9, 20), 4);
  assert.equal(boundaryAt(b, 9999, 20), 11, '末尾之后是 length，不是 length-1');
});

test('singleLine：老数据（没有这个键）行为完全不变', () => {
  // 两个数据形状完全相同的块：只差 singleLine。没有它就必须还是面积法。
  const shape = { box: [0, 0, 90, 60] as [number, number, number, number], vertical: true, text: 'あいうえおかきくけこ' };
  const legacy = block(shape);
  const declared = block({ ...shape, singleLine: true });
  // 面积法在这个形状上会把 10 个字当成好几列；声明之后就只有一段。
  assert.ok(charRangeRects(legacy, 0, 10).length > 1, '无声明 → 继续按面积分段（老行为）');
  assert.equal(charRangeRects(declared, 0, 10).length, 1, '有声明 → 一段');
  // 长边等分：竖排就是每一格高 6px、横向占满整块。
  assert.equal(charIndexAt(declared, 45, 3), 0);
  assert.equal(charIndexAt(declared, 45, 57), 9);
});

test('★ 整条链：OCR 成块 → 落盘 → 读回，几何仍然是「一个框一段文字」', () => {
  // 这条串起了三个必须同时成立的地方：`buildBlocks` 声明、`serializeMangaJson` 落盘、
  // `parseMangaJson` 读回。任何一处漏了，画面上就退回「按面积猜排版」——而那正是
  // 用户看到的划词偏移。单测覆盖「几何」和「序列化」的分别是另外两条，这里是接缝。
  const recognized: OcrBox[] = [
    { box: [100, 100, 500, 140], text: '今日はいい天気ですね。', confidence: 1, vertical: false },
    { box: [1000, 100, 1040, 322], text: 'この中だったら', confidence: 1, vertical: true },
  ];
  const blocks = buildBlocks(recognized);
  assert.equal(blocks.length, 2);
  for (const b of blocks) assert.equal(b.singleLine, true, '成块时必须声明');

  const json = serializeMangaJson([{ url: 'p1.jpg', blocks }]);
  assert.match(json, /"single_line":true/);
  const round = parseMangaJson(json);
  const back = round[0]?.blocks ?? [];
  assert.equal(back.length, 2);
  for (const b of back) {
    assert.equal(b.singleLine, true);
    // 一个框一段文字 → 高亮永远只有一个矩形；横排 400×40 / 11 字面积法本来会算成多段。
    assert.equal(charRangeRects(b, 0, b.lines.join('').length).length, 1);
  }
  // 端点也要落回正确的字：横排 400px / 11 字 → 每格 36.4px。
  const row = back[0]!;
  assert.equal(charIndexAt(row, 100 + 18, 120), 0);
  assert.equal(charIndexAt(row, 100 + 36.36 * 10 + 18, 120), 10);
});
