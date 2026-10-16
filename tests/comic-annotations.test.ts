import assert from 'node:assert/strict';
import { test } from 'node:test';
import { erasePageInk, strokeHitSweep, strokePath, validateAnnotations, emptyAnnotations } from '../src/core/comic/annotations';
import { AnnotationStore } from '../src/core/comic/annotation-store';
import type { AnnotationStroke } from '../src/shared/annotations';
const stroke: AnnotationStroke = { id: 'ink', kind: 'stroke', color: '#222222', opacity: 1, width: 2, points: [{ x: 50, y: 0 }, { x: 50, y: 100 }] };

test('eraser sweeps across a thin stroke between sparse pointer events', () => {
  assert.equal(strokeHitSweep({ x: 0, y: 50 }, { x: 100, y: 50 }, stroke, 3), true);
  assert.equal(strokeHitSweep({ x: 0, y: 110 }, { x: 100, y: 110 }, stroke, 3), false);
  assert.equal(strokeHitSweep({ x: 46, y: 10 }, { x: 46, y: 90 }, stroke, 3), true);
});

test('page eraser spans writable layers, protects locked/hidden ink and other pages, and undoes in one step', async () => {
  const layers = ['first', 'second', 'locked', 'hidden'].map(id => ({ id, name: id, type: 'pen' as const, visible: id !== 'hidden', locked: id === 'locked',
    objects: { page: [{ ...stroke, id }], other: [{ ...stroke, id: id + '-other' }] } }));
  const binding = { width: 100, height: 100, signature: '' };
  const doc = { ...emptyAnnotations(), pages: { page: binding, other: binding }, layers };
  const erased = erasePageInk(doc, 'page', new Set(layers.map(l => l.id)));
  assert.deepEqual(erased.layers.map(l => l.objects.page!.length), [0, 0, 1, 1]);
  assert.deepEqual(erased.layers.map(l => l.objects.other!.length), [1, 1, 1, 1]);
  assert.deepEqual(validateAnnotations(erased), erased);
  assert.equal(doc.layers[0]!.objects.page.length, 1);
  const store = new AnnotationStore('book', { read: async () => ({ document: doc, stalePages: [] }), write: async (_id, document) => ({ document, stalePages: [] }) });
  await new Promise(resolve => setImmediate(resolve));
  store.commit(erased); store.undo();
  assert.deepEqual(store.state.document.layers, doc.layers);
  store.redo();
  assert.deepEqual(store.state.document.layers, erased.layers);
});
test('eraser handles single point ink, stationary gestures and disjoint collinear segments', () => {
  const dot = { ...stroke, points: [{ x: 50, y: 50 }] };
  assert.equal(strokeHitSweep({ x: 0, y: 50 }, { x: 100, y: 50 }, dot, 1), true);
  assert.equal(strokeHitSweep({ x: 50, y: 50 }, { x: 50, y: 50 }, dot, 1), true);
  assert.equal(strokeHitSweep({ x: 50, y: 120 }, { x: 50, y: 140 }, stroke, 1), false);
  assert.equal(strokeHitSweep({ x: 0, y: 30 }, { x: 10, y: 40 }, dot, 1), false);
});
test('smoothed display keeps endpoints and raw v1 annotation data compatible', () => {
  const points = [{ x: 0, y: 0 }, { x: 20, y: 40 }, { x: 40, y: 0 }];
  assert.equal(strokePath([]), '');
  assert.equal(strokePath(points), 'M 0 0 Q 20 40 30 20 L 40 0');
  const doc = { ...emptyAnnotations(), pages: { page: { width: 100, height: 100, signature: '' } }, layers: [{ id: 'layer', name: 'ink', type: 'pen', visible: true, locked: false, objects: { page: [{ ...stroke, points }] } }] };
  assert.deepEqual(validateAnnotations(doc), doc);
  assert.deepEqual(points, [{ x: 0, y: 0 }, { x: 20, y: 40 }, { x: 40, y: 0 }]);
});
