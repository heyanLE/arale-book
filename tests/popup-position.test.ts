import { test } from 'node:test';
import assert from 'node:assert/strict';

import { overlapArea, placePopup } from '../src/core/cards/popup-position';

const anchor = { x: 300, y: 200, width: 120, height: 30 };

test('词卡：下方空间足够时放在选区下方且不重叠', () => {
  const position = placePopup({ anchor, popupWidth: 392, popupHeight: 260, viewportWidth: 1200, viewportHeight: 800 });
  assert.deepEqual(position, { left: 300, top: 236 });
  assert.equal(overlapArea({ x: position.left, y: position.top, width: 392, height: 260 }, anchor), 0);
});

test('词卡：选区靠近底边时翻到上方', () => {
  const bottom = { ...anchor, y: 710 };
  const position = placePopup({ anchor: bottom, popupWidth: 392, popupHeight: 260, viewportWidth: 1200, viewportHeight: 800 });
  assert.equal(position.top, 444);
  assert.equal(overlapArea({ x: position.left, y: position.top, width: 392, height: 260 }, bottom), 0);
});

test('词卡：上下都放不下时改放右侧，避免盖住选区', () => {
  const middle = { x: 260, y: 280, width: 80, height: 40 };
  const position = placePopup({ anchor: middle, popupWidth: 360, popupHeight: 570, viewportWidth: 1100, viewportHeight: 620 });
  const popup = { x: position.left, y: position.top, width: 360, height: 570 };
  assert.ok(position.left >= middle.x + middle.width);
  assert.equal(overlapArea(popup, middle), 0);
});

test('词卡：任何候选都会被夹在窗口安全边距内', () => {
  const position = placePopup({
    anchor: { x: 5, y: 5, width: 20, height: 20 },
    popupWidth: 392,
    popupHeight: 580,
    viewportWidth: 420,
    viewportHeight: 600,
  });
  assert.ok(position.left >= 8);
  assert.ok(position.top >= 8);
  assert.ok(position.left + 392 <= 412);
  assert.ok(position.top + 580 <= 592);
});
