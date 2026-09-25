/**
 * OCR 页面协议的解析单测。
 *
 * 这一层是**不可信输入**的边界：解析的是子进程写出来的字。一行坏数据不该让整本
 * 识别失败，但也不该被宽容到把「缺 box 的行」塞进文字层——那种行在阅读器里会渲染成
 * 0×0 的隐形块，用户点不到、查不出原因。所以这里逐条钉住「什么算合法、什么该丢」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseOcrStreamLine, splitOcrStreamChunk } from '../src/shared/ocr-protocol';

test('meta: 解析出实际语言与请求语言（两者不同就是降级了）', () => {
  const event = parseOcrStreamLine(
    '{"kind":"meta","engine":"vision","languages":["en-US"],"requested":["ja-JP","en-US"]}',
  );
  assert.equal(event.kind, 'meta');
  if (event.kind !== 'meta') return;
  assert.equal(event.meta.engine, 'vision');
  assert.deepEqual(event.meta.languages, ['en-US']);
  assert.deepEqual(event.meta.requested, ['ja-JP', 'en-US']);
});

test('page: 解析成功页，保留文本/置信度/竖排/框', () => {
  const event = parseOcrStreamLine(
    JSON.stringify({
      kind: 'page',
      file: '/x/001.jpg',
      ok: true,
      width: 1441,
      height: 2048,
      lines: [{ text: 'こんにちは', confidence: 0.93, box: [10, 20, 30, 200], vertical: true }],
    }),
  );
  assert.equal(event.kind, 'page');
  if (event.kind !== 'page') return;
  assert.equal(event.page.ok, true);
  assert.equal(event.page.width, 1441);
  assert.equal(event.page.file, '/x/001.jpg');
  assert.equal(event.page.lines.length, 1);
  assert.deepEqual(event.page.lines[0], {
    text: 'こんにちは',
    confidence: 0.93,
    box: [10, 20, 30, 200],
    vertical: true,
  });
});

test('page: 失败页保留原因（单页失败不该毁掉整本）', () => {
  const event = parseOcrStreamLine('{"kind":"page","file":"/x/003.jpg","ok":false,"error":"坏了"}');
  assert.equal(event.kind, 'page');
  if (event.kind !== 'page') return;
  assert.equal(event.page.ok, false);
  assert.equal(event.page.error, '坏了');
  assert.deepEqual(event.page.lines, []);
});

test('page: 框被归一到 x1<=x2、y1<=y2（引擎可能给反）', () => {
  const event = parseOcrStreamLine(
    '{"kind":"page","file":"a","ok":true,"width":1,"height":1,"lines":[{"text":"x","box":[30,40,10,20]}]}',
  );
  if (event.kind !== 'page') throw new Error('应解析成 page');
  assert.deepEqual(event.page.lines[0]?.box, [10, 20, 30, 40]);
});

test('page: 缺 box / 框不是 4 个数 / 空文本的行被丢掉', () => {
  const event = parseOcrStreamLine(
    JSON.stringify({
      kind: 'page',
      file: 'a',
      ok: true,
      width: 1,
      height: 1,
      lines: [
        { text: '保留', box: [0, 0, 1, 1] },
        { text: '缺框' },
        { text: '框只有三个', box: [0, 0, 1] },
        { text: '框里有非数字', box: [0, 0, 1, 'x'] },
        { text: '   ', box: [0, 0, 1, 1] },
        { text: '', box: [0, 0, 1, 1] },
        { box: [0, 0, 1, 1] },
      ],
    }),
  );
  if (event.kind !== 'page') throw new Error('应解析成 page');
  assert.equal(event.page.lines.length, 1, `只应留 1 行，实际 ${JSON.stringify(event.page.lines)}`);
  assert.equal(event.page.lines[0]?.text, '保留');
});

test('page: 缺置信度填 1（宁可乐观，也别因为缺字段把文字丢掉）', () => {
  const event = parseOcrStreamLine(
    '{"kind":"page","file":"a","ok":true,"width":1,"height":1,"lines":[{"text":"x","box":[0,0,1,1]}]}',
  );
  if (event.kind !== 'page') throw new Error('应解析成 page');
  assert.equal(event.page.lines[0]?.confidence, 1);
});

test('page: 置信度被夹到 0..1', () => {
  const event = parseOcrStreamLine(
    JSON.stringify({
      kind: 'page',
      file: 'a',
      ok: true,
      width: 1,
      height: 1,
      lines: [
        { text: 'a', box: [0, 0, 1, 1], confidence: 5 },
        { text: 'b', box: [0, 0, 1, 1], confidence: -3 },
      ],
    }),
  );
  if (event.kind !== 'page') throw new Error('应解析成 page');
  assert.equal(event.page.lines[0]?.confidence, 1);
  assert.equal(event.page.lines[1]?.confidence, 0);
});

test('probe: 自检结果（系统 OCR 资源缺失时靠它提前发现）', () => {
  const bad = parseOcrStreamLine('{"kind":"probe","ok":false,"error":"资源不可用"}');
  assert.equal(bad.kind, 'probe');
  if (bad.kind !== 'probe') return;
  assert.equal(bad.probe.ok, false);
  assert.equal(bad.probe.error, '资源不可用');

  const good = parseOcrStreamLine('{"kind":"probe","ok":true}');
  if (good.kind !== 'probe') throw new Error('应解析成 probe');
  assert.equal(good.probe.ok, true);
  assert.equal(good.probe.error, null);
});

test('fatal: 整本没法跑时带出原因', () => {
  const event = parseOcrStreamLine('{"kind":"fatal","error":"模型损坏"}');
  assert.equal(event.kind, 'fatal');
  if (event.kind !== 'fatal') return;
  assert.equal(event.error, '模型损坏');
});

test('坏输入不抛，一律归成 unknown', () => {
  for (const line of [
    '',
    '   ',
    '不是 JSON',
    '[]',
    'null',
    '"字符串"',
    '123',
    '{"kind":"page"}',
    '{"kind":"page","file":123}',
    '{"kind":"没见过的种类"}',
  ]) {
    const event = parseOcrStreamLine(line);
    assert.equal(event.kind, 'unknown', `应判成 unknown：${JSON.stringify(line)}`);
  }
});

test('unknown 分支保留**原始**行（不 trim），便于排查引擎写的到底是什么', () => {
  // 刻意留原样：排查「引擎到底写了什么」时，前后空白/\r 也是信息
  // （Windows 的 runner 会带 \r）。trim 过就看不出来了。
  const event = parseOcrStreamLine('  {"kind":"what"}  ');
  if (event.kind !== 'unknown') throw new Error('应解析成 unknown');
  assert.equal(event.raw, '  {"kind":"what"}  ');
});

test('splitOcrStreamChunk: 跨 chunk 的半个 JSON 不丢', () => {
  const first = splitOcrStreamChunk('{"a":1}\n{"b":');
  assert.deepEqual(first.lines, ['{"a":1}']);
  assert.equal(first.rest, '{"b":');
  // 下一片补全，拼上残留就能解析。
  const second = splitOcrStreamChunk(first.rest + '2}\n');
  assert.deepEqual(second.lines, ['{"b":2}']);
  assert.equal(second.rest, '');
});

test('splitOcrStreamChunk: 一次 chunk 多行 + 没有换行的尾巴', () => {
  const { lines, rest } = splitOcrStreamChunk('1\n2\n3\n4');
  assert.deepEqual(lines, ['1', '2', '3']);
  assert.equal(rest, '4');
});

test('splitOcrStreamChunk: 空 chunk 不产生假行', () => {
  const { lines, rest } = splitOcrStreamChunk('');
  assert.deepEqual(lines, []);
  assert.equal(rest, '');
});
