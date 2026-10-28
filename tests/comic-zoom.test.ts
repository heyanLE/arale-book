import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wheelZoomFactor } from '../src/core/comic/zoom';

test('tiny pinch events accumulate by distance, not event count', () => {
  const small = wheelZoomFactor(-0.5, 0);
  assert.ok(small > 1 && small < 1.001);
  const manyEvents = Array.from({ length: 100 }).reduce<number>(zoom => zoom * small, 1);
  assert.ok(Math.abs(manyEvents - wheelZoomFactor(-50, 0)) < 1e-12);
  assert.ok(manyEvents < 1.1);
});

test('zoom in and out are symmetric and wheel units agree', () => {
  assert.ok(Math.abs(wheelZoomFactor(-40, 0) * wheelZoomFactor(40, 0) - 1) < 1e-12);
  assert.equal(wheelZoomFactor(3, 1), wheelZoomFactor(48, 0));
  assert.equal(wheelZoomFactor(0.1, 2), wheelZoomFactor(80, 0));
});

test('zero and invalid deltas do nothing, isolated spikes stay bounded', () => {
  for (const delta of [0, NaN, Infinity, -Infinity]) assert.equal(wheelZoomFactor(delta, 0), 1);
  assert.ok(wheelZoomFactor(-100000, 0) < 1.2);
  assert.ok(wheelZoomFactor(100000, 0) > 0.8);
});
