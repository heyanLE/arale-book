/**
 * 漫画阅读器 OCR 控件决策的单测。
 *
 * 覆盖的是需求里那两条容易被写歪的规则：
 * - 「当前漫画如果在识别中，下面的引擎选择**淡化并固化为当前正在识别的引擎**」；
 * - 「识别文字**改为停止识别**，点击取消任务」。
 *
 * 这些分支如果只靠 GUI 冒烟验证，就必须先下 20 MB 模型、真跑一次识别才能看到——
 * 于是实际上永远不会被验证。抽成纯函数之后这里几毫秒就能覆盖全部分支。
 *
 * ⚠️ 这里 import 的是**渲染进程**里的模块，而 `tsconfig.test.json` 只编译 core/shared/main。
 * 它被拉进测试图的前提是保持「纯」：不碰 DOM、不 import React、**不 import 别名里的值**
 * （`import type` 会被擦除所以安全；值导入会变成 `require('@shared/...')`，在 Node 里解析不到）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ocrControlState, type OcrControlInput } from '../src/renderer/reader/ocr-controls';
import type { OcrProgress, OcrProviderId, OcrQueueEntry } from '../src/shared/types';

const LABELS: Record<OcrProviderId, string> = {
  system: '系统 OCR（macOS Vision）',
  'arale_onnx_v1': 'arale_onnx_v1 (ONNX)',
};

function providerLabel(id: OcrProviderId): string {
  return LABELS[id] ?? id;
}

function entry(provider: OcrProviderId, bookId = 'bk_a'): OcrQueueEntry {
  return { bookId, title: '某一卷', provider, enqueuedAt: 1_700_000_000_000, total: 171 };
}

function progress(done: number, total: number): OcrProgress {
  return { bookId: 'bk_a', provider: 'system', done, total, pageIndex: done, stage: 'recognizing' };
}

function input(patch: Partial<OcrControlInput> = {}): OcrControlInput {
  return {
    queueEntry: null,
    active: false,
    queuePosition: 0,
    providerOverride: null,
    defaultProvider: 'system',
    providerLabel,
    progress: null,
    hasResult: false,
    canStart: true,
    canCancel: true,
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// 空闲
// ---------------------------------------------------------------------------

test('空闲 + 没有文字层 → 「识别文字」，引擎可选，启动可用', () => {
  const state = ocrControlState(input());
  assert.equal(state.label, '识别文字');
  assert.equal(state.isCancel, false);
  assert.equal(state.disabled, false);
  assert.equal(state.frozen, false);
  assert.equal(state.provider, 'system');
  assert.match(state.title, /系统 OCR/);
});

test('空闲 + 已有文字层 → 「重新识别」', () => {
  const state = ocrControlState(input({ hasResult: true }));
  assert.equal(state.label, '重新识别');
  assert.equal(state.isCancel, false);
});

test('空闲时引擎选择器跟随用户选择，并显示对应名字', () => {
  const state = ocrControlState(input({ providerOverride: 'arale_onnx_v1' }));
  assert.equal(state.provider, 'arale_onnx_v1');
  assert.equal(state.frozen, false);
  assert.match(state.title, /arale_onnx_v1/);
});

test('空闲时没选过 → 用设置里的默认引擎', () => {
  const state = ocrControlState(input({ defaultProvider: 'arale_onnx_v1', providerOverride: null }));
  assert.equal(state.provider, 'arale_onnx_v1');
});

test('没有「开始识别」回调时按钮禁用（不会点了没反应）', () => {
  const state = ocrControlState(input({ canStart: false }));
  assert.equal(state.disabled, true);
  assert.equal(state.isCancel, false);
});

// ---------------------------------------------------------------------------
// 识别中
// ---------------------------------------------------------------------------

test('识别中 → 「停止识别」，危险语义，点击取消', () => {
  const state = ocrControlState(input({ queueEntry: entry('system'), active: true }));
  assert.equal(state.label, '停止识别');
  assert.equal(state.isCancel, true);
  assert.equal(state.disabled, false);
  assert.match(state.title, /已经识别出来的页会保留/);
});

test('识别中且有进度 → 文案带上 done/total（保留旧版的信息量）', () => {
  const state = ocrControlState(
    input({ queueEntry: entry('system'), active: true, progress: progress(12, 171) }),
  );
  assert.equal(state.label, '停止识别 12/171');
  assert.equal(state.isCancel, true);
});

test('识别中：引擎**固化**为那条任务的引擎，即使队列里的与用户当前选择不同', () => {
  const state = ocrControlState(
    input({ queueEntry: entry('arale_onnx_v1'), active: true, providerOverride: 'system' }),
  );
  assert.equal(state.provider, 'arale_onnx_v1', '必须显示正在跑的那个引擎');
  assert.equal(state.frozen, true);
  assert.match(state.providerTitle, /已锁定为「arale_onnx_v1/);
});

test('识别中但取消不可用 → 按钮禁用（而不是变成一个假的取消）', () => {
  const state = ocrControlState(
    input({ queueEntry: entry('system'), active: true, canCancel: false }),
  );
  assert.equal(state.isCancel, true);
  assert.equal(state.disabled, true);
});

// ---------------------------------------------------------------------------
// 排队中
// ---------------------------------------------------------------------------

test('排队中 → 「取消排队（第 N 位）」，引擎同样固化', () => {
  const state = ocrControlState(
    input({ queueEntry: entry('arale_onnx_v1'), active: false, queuePosition: 2 }),
  );
  assert.equal(state.label, '取消排队（第 2 位）');
  assert.equal(state.isCancel, true);
  assert.equal(state.frozen, true);
  assert.equal(state.provider, 'arale_onnx_v1');
  assert.match(state.title, /第 2 位/);
});

test('排队中即使已有文字层，也不显示「重新识别」', () => {
  const state = ocrControlState(
    input({ queueEntry: entry('system'), active: false, queuePosition: 1, hasResult: true }),
  );
  assert.equal(state.label, '取消排队（第 1 位）');
});

test('排队中取消不可用 → 禁用', () => {
  const state = ocrControlState(
    input({ queueEntry: entry('system'), active: false, queuePosition: 3, canCancel: false }),
  );
  assert.equal(state.disabled, true);
});

// ---------------------------------------------------------------------------
// 不变量
// ---------------------------------------------------------------------------

test('不变量：只要在队列里就一定 frozen，且 label 一定是取消语义', () => {
  for (const active of [true, false]) {
    for (const provider of ['system', 'arale_onnx_v1'] as const) {
      const state = ocrControlState(
        input({ queueEntry: entry(provider), active, queuePosition: 1 }),
      );
      assert.equal(state.frozen, true, `active=${active} provider=${provider}`);
      assert.equal(state.isCancel, true, `active=${active} provider=${provider}`);
      assert.equal(state.provider, provider);
      // 识别中的文案必须是「停止」，排队中的必须是「取消排队」——两者对用户的
      // 含义不同（一个会中断、一个根本还没开始），不该混用。
      assert.match(state.label, active ? /^停止识别/ : /^取消排队/);
    }
  }
});

test('不变量：不在队列里时永远不 frozen，按钮永远是启动语义', () => {
  for (const hasResult of [true, false]) {
    for (const canStart of [true, false]) {
      const state = ocrControlState(input({ hasResult, canStart }));
      assert.equal(state.frozen, false);
      assert.equal(state.isCancel, false);
      assert.equal(state.providerTitle, '选哪个 OCR 引擎');
      assert.ok(state.label === '识别文字' || state.label === '重新识别');
    }
  }
});
