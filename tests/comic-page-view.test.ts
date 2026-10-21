import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampComicPageView, comicPageViewKey, DEFAULT_PAGE_VIEW, parseComicPageViews } from '../src/core/comic/page-view';

const page = { url: '001.png', width: 800, height: 1200 };
const second = { ...page, url: '002.png' };
const geometry = { width: 800, height: 1200, baseScale: 0.5, viewportWidth: 600, viewportHeight: 600 };

test('page memories survive serialization without leaking to unadjusted pages or layouts', () => {
  const firstKey = comicPageViewKey('height', [page], false);
  const view = { zoom: 2, pan: { x: 80, y: -200 } };
  const memories = parseComicPageViews(JSON.stringify({ [firstKey]: view }));
  assert.deepEqual(memories[firstKey], view);
  for (const key of [
    comicPageViewKey('height', [second], false),
    comicPageViewKey('width', [page], false),
    comicPageViewKey('height', [page, second], false),
    comicPageViewKey('height', [{ ...page, width: 900 }], false),
  ]) assert.deepEqual(memories[key] ?? DEFAULT_PAGE_VIEW, DEFAULT_PAGE_VIEW);
  assert.equal(firstKey, comicPageViewKey('height', [page], true));
  assert.notEqual(comicPageViewKey('height', [page, second], false), comicPageViewKey('height', [page, second], true));
  assert.notEqual(comicPageViewKey('height', [page, second], true), comicPageViewKey('height', [second, page], true));
});

test('restoration clamps to the current viewport without destroying saved positions', () => {
  const saved = { zoom: 2, pan: { x: 80, y: -200 } };
  assert.deepEqual(clampComicPageView(saved, geometry), saved);
  assert.deepEqual(clampComicPageView(saved, { ...geometry, viewportWidth: 1000, viewportHeight: 1000 }),
    { zoom: 2, pan: { x: 0, y: -100 } });
  assert.deepEqual(clampComicPageView(saved, geometry), saved);
  // 初次挂载测量前为 0 的视口不会修改存储中的原始位置。
  clampComicPageView(saved, { ...geometry, baseScale: 1 / 1200, viewportWidth: 0, viewportHeight: 0 });
  assert.deepEqual(saved, { zoom: 2, pan: { x: 80, y: -200 } });
});

test('zooming out keeps the image reachable and zoom stays within supported bounds', () => {
  assert.deepEqual(clampComicPageView({ zoom: 1, pan: { x: 500, y: -500 } }, geometry), DEFAULT_PAGE_VIEW);
  assert.equal(clampComicPageView({ zoom: 100, pan: { x: 0, y: 0 } }, geometry).zoom, 8);
  assert.equal(clampComicPageView({ zoom: 0.01, pan: { x: 0, y: 0 } }, geometry).zoom, 0.2);
});

test('bad storage values are ignored while valid page memories remain usable', () => {
  const good = { zoom: 1.5, pan: { x: 10, y: -30 } };
  const raw = JSON.stringify({ good, missing: { zoom: 2 }, string: { zoom: '2', pan: good.pan },
    zero: { zoom: 0, pan: good.pan }, huge: { zoom: 9, pan: good.pan }, badPan: { zoom: 2, pan: { x: null, y: 0 } }, null: null });
  assert.deepEqual(parseComicPageViews(raw), { good });
  for (const raw of [null, '[]', 'null', 'true', '{invalid']) assert.deepEqual(parseComicPageViews(raw), {});
});
