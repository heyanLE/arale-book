/**
 * iframe 桥接脚本里**高亮**那部分的契约测试。
 *
 * 为什么要有这份测试：高亮画在**跨源 iframe** 里（宿主是 `file://`，正文是
 * `arale://<bookId>`），应用侧的冒烟测试看不到它内部的 DOM（`contentDocument` 拿不到，
 * CDP 的 `DOM.getDocument({pierce:true})` 也穿不进去，实测只返回宿主那棵树）。
 * 于是一个纯 JS 的注入脚本如果坏了，只有用户会先发现。
 *
 * 这里把 `READER_BRIDGE_JS` 放进 `node:vm` 里跑，配一份最小 DOM 桩，盯住三件事：
 *
 * 1. **划词那份（persistent）不会自己消失**——卡片还开着时它必须一直在；
 * 2. `clearHighlight` 只清 persistent 那份，**不能**顺手把点击查词的临时下划线也抹掉；
 * 3. 点击那份（不带 persistent）仍然是 2.4 s 后自动消失。
 *
 * 定时器是假的：脚本调 `setTimeout` 时我们只记录，由测试决定"过了多久"，
 * 所以不用真的等 2.4 秒。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { FUSHI_BRIDGE_TAG, READER_BRIDGE_JS } from '../src/shared/reader-bridge';

const CHAPTER_TEXT = '吾輩は猫である。名前はまだ無い。';
/** 一段跨两行的选区：`getClientRects` 给两个矩形，脚本应该画两块。 */
const TWO_LINE_RECTS = [
  { left: 10, top: 20, width: 120, height: 18 },
  { left: 10, top: 40, width: 60, height: 18 },
];

interface Harness {
  /** 当前挂在 body 上的 `.arale-highlight` 元素（按 DOM 顺序）。 */
  highlights: { className: string; style: Record<string, string> }[];
  /** 父窗口 → iframe 的消息。 */
  send: (message: Record<string, unknown>) => void;
  /** 推进假定时器：把 `ms` 内到期的回调都执行掉。 */
  advance: (ms: number) => void;
  /** iframe → 父窗口的消息。 */
  posted: { type?: string }[];
}

function createHarness(): Harness {
  const highlights: Harness['highlights'] = [];
  const posted: Harness['posted'] = [];
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimerId = 1;
  let clock = 0;

  const body = {
    nodeName: 'BODY',
    appendChild(element: { parentNode?: unknown }) {
      element.parentNode = body;
      highlights.push(element as never);
    },
    removeChild(element: { parentNode?: unknown }) {
      const index = highlights.indexOf(element as never);
      if (index >= 0) highlights.splice(index, 1);
      element.parentNode = undefined;
    },
  };

  const textNode = {
    nodeType: 3,
    nodeName: '#text',
    nodeValue: CHAPTER_TEXT,
    parentNode: { nodeName: 'P' },
  };

  const documentStub = {
    readyState: 'complete',
    body,
    documentElement: {
      style: { setProperty() {} },
      classList: { toggle() {} },
      scrollHeight: 800,
    },
    addEventListener(type: string, handler: (event: unknown) => void) {
      listeners.set(`document:${type}`, [...(listeners.get(`document:${type}`) ?? []), handler]);
    },
    createTreeWalker() {
      let step = 0;
      return { nextNode: () => (step++ === 0 ? textNode : null) };
    },
    createElement() {
      return { className: '', style: {} as Record<string, string>, parentNode: undefined };
    },
    createRange() {
      return {
        setStart() {},
        setEnd() {},
        getBoundingClientRect: () => TWO_LINE_RECTS[0],
        getClientRects: () => TWO_LINE_RECTS,
      };
    },
    caretRangeFromPoint: () => null,
  };

  const windowStub = {
    innerWidth: 800,
    innerHeight: 600,
    scrollX: 0,
    scrollY: 0,
    getSelection: () => null,
    addEventListener(type: string, handler: (event: unknown) => void) {
      listeners.set(`window:${type}`, [...(listeners.get(`window:${type}`) ?? []), handler]);
    },
    scrollTo() {},
  };

  const sandbox: Record<string, unknown> = {
    document: documentStub,
    window: windowStub,
    parent: { postMessage: (message: { type?: string }) => posted.push(message) },
    NodeFilter: { SHOW_TEXT: 4 },
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextTimerId++;
      timers.set(id, { at: clock + Number(ms ?? 0), fn });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(Number(id));
    },
    console,
  };
  sandbox['globalThis'] = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(READER_BRIDGE_JS, sandbox);

  return {
    highlights,
    posted,
    send(message) {
      const handlers = listeners.get('window:message') ?? [];
      assert.ok(handlers.length > 0, '桥接脚本没有监听 message');
      for (const handler of handlers) handler({ data: { tag: FUSHI_BRIDGE_TAG, ...message } });
    },
    advance(ms) {
      clock += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > clock) continue;
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

test('桥接脚本：划词高亮一直画着，clearHighlight 才清', () => {
  const harness = createHarness();
  harness.send({ type: 'highlight', start: 0, end: 5, persistent: true });
  assert.equal(harness.highlights.length, TWO_LINE_RECTS.length, '一段跨行选区应该一行一块');
  assert.equal(harness.highlights[0]!.className, 'arale-highlight');

  // 关键：点击那份是 2.4 s 自己消失的，划词这份**过了多久都还在**。
  harness.advance(10_000);
  assert.equal(harness.highlights.length, TWO_LINE_RECTS.length, '划词高亮不该自己消失');

  harness.send({ type: 'clearHighlight' });
  assert.equal(harness.highlights.length, 0, 'clearHighlight 之后应该清干净');
});

test('桥接脚本：点击查词的临时高亮仍然 2.4 s 后自己消失', () => {
  const harness = createHarness();
  harness.send({ type: 'highlight', start: 0, end: 5 });
  assert.equal(harness.highlights.length, TWO_LINE_RECTS.length);

  harness.advance(2400);
  assert.equal(harness.highlights.length, 0, '临时高亮应该在 2.4 s 后消失');
});

test('桥接脚本：clearHighlight 不会误删点击查词的临时下划线', () => {
  const harness = createHarness();
  // 点词查卡（临时）——紧接着用户划了词（持久）——卡片关掉 → clearHighlight。
  harness.send({ type: 'highlight', start: 0, end: 5 });
  harness.send({ type: 'highlight', start: 0, end: 5, persistent: true });
  // 持久那份出现时临时那份让位，页面上只该剩持久那一份。
  assert.equal(harness.highlights.length, TWO_LINE_RECTS.length);

  // 反过来：持久那份在时又来一次点击高亮，两者互不影响。
  harness.send({ type: 'highlight', start: 0, end: 5 });
  assert.equal(harness.highlights.length, TWO_LINE_RECTS.length * 2);

  harness.send({ type: 'clearHighlight' });
  assert.equal(
    harness.highlights.length,
    TWO_LINE_RECTS.length,
    'clearHighlight 只清持久那份，临时下划线要留给它自己的定时器',
  );
  harness.advance(2400);
  assert.equal(harness.highlights.length, 0);
});
