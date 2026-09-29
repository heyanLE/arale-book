import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HARNESS_TOOL_NAME, harnessSubmissionTool } from '../src/core/study/harness-tool';
import { normalizeHarnessConcurrency, runConcurrentBatches } from '../src/main/study/concurrency';

test('三个 Harness 阶段共用一个提交工具名，参数字段按阶段分开且要求严格结构', () => {
  const filter = harnessSubmissionTool('filter');
  const card = harnessSubmissionTool('card');
  const verify = harnessSubmissionTool('verify');
  assert.equal(filter.name, HARNESS_TOOL_NAME);
  assert.equal(card.name, HARNESS_TOOL_NAME);
  assert.equal(verify.name, HARNESS_TOOL_NAME);
  for (const tool of [filter, card, verify]) {
    assert.deepEqual(tool.parameters.required, ['items']);
    assert.equal(tool.parameters.additionalProperties, false);
  }
  const properties = (tool: typeof filter): Record<string, unknown> =>
    ((tool.parameters.properties as { items: { items: { properties: Record<string, unknown> } } }).items.items.properties);
  assert.ok('decision' in properties(filter));
  assert.ok('meaning' in properties(card));
  assert.ok('approved' in properties(verify));
});

test('任务并发默认 2、最多 3；失败后等待在途批次且不启动后续批次', async () => {
  assert.equal(normalizeHarnessConcurrency(undefined), 2);
  assert.equal(normalizeHarnessConcurrency(9), 2);
  assert.equal(normalizeHarnessConcurrency(3), 3);
  let active = 0;
  let peak = 0;
  const started: number[] = [];
  let notified = 0;
  await assert.rejects(runConcurrentBatches([0, 1, 2, 3], 2, async (value) => {
    started.push(value);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value === 0 ? 5 : 25));
    active -= 1;
    if (value === 0) throw new Error('第一批失败');
  }, () => { notified += 1; }), /第一批失败/);
  assert.equal(peak, 2);
  assert.deepEqual(started, [0, 1]);
  assert.equal(active, 0);
  assert.equal(notified, 1);
});
