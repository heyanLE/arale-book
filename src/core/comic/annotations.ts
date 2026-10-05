import type { AnnotationLayer, AnnotationObject, AnnotationPoint, AnnotationStroke, ComicAnnotations } from '../../shared/annotations';

export const emptyAnnotations = (): ComicAnnotations => ({ version: 1, revision: 0, visible: true, layers: [], pages: {} });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function fail(): never { throw new Error('批注数据格式或数量无效'); }
function number(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail();
  return value;
}
function string(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail();
  return value;
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') fail(); return value; }
function color(value: unknown): string { const result = string(value, 7); if (!/^#[0-9a-f]{6}$/i.test(result)) fail(); return result; }
export function validateAnnotations(value: unknown): ComicAnnotations {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.layers) || value.layers.length > 100 || !object(value.pages)) fail();
  const revision = number(value.revision, 0, Number.MAX_SAFE_INTEGER); if (!Number.isInteger(revision)) fail();
  const pages = Object.fromEntries(Object.entries(value.pages).map(([url, page]) => {
    string(url, 1000); if (!object(page)) fail();
    return [url, { width: number(page.width, 1, 100000), height: number(page.height, 1, 100000), signature: string(page.signature, 64, true) }];
  }));
  const seenLayers = new Set<string>(), seenObjects = new Set<string>(); let points = 0, objects = 0, textLength = 0;
  const layers: AnnotationLayer[] = value.layers.map(layer => {
    if (!object(layer) || !['pen', 'text'].includes(String(layer.type)) || !object(layer.objects)) fail();
    const id = string(layer.id, 100); if (seenLayers.has(id)) fail(); seenLayers.add(id);
    const contents = Object.fromEntries(Object.entries(layer.objects).map(([url, rows]) => {
      string(url, 1000);
      const page = pages[url]; if (!Array.isArray(rows) || (rows.length && !page)) fail();
      return [url, rows.map((row): AnnotationObject => {
        if (!page) fail();
        if (!object(row)) fail();
        const id = string(row.id, 100); if (seenObjects.has(id) || ++objects > 100000) fail(); seenObjects.add(id);
        const opacity = number(row.opacity, 0.05, 1), ink = color(row.color);
        if (row.kind === 'stroke' && layer.type === 'pen') {
          if (!Array.isArray(row.points) || !row.points.length || row.points.length > 20000 || (points += row.points.length) > 500000) fail();
          return { id, kind: 'stroke', opacity, color: ink, width: number(row.width, 0.5, 512), points: row.points.map(p => {
            if (!object(p)) fail(); return { x: number(p.x, 0, page.width), y: number(p.y, 0, page.height) };
          }) };
        }
        if (row.kind !== 'text' || layer.type !== 'text') fail();
        const text = string(row.text, 10000, true); if ((textLength += text.length) > 2000000) fail();
        return { id, kind: 'text', opacity, color: ink, text, x: number(row.x, 0, page.width), y: number(row.y, 0, page.height),
          width: number(row.width, 1, page.width), height: number(row.height, 1, page.height), fontSize: number(row.fontSize, 1, 512),
          background: row.background === null ? null : color(row.background), vertical: bool(row.vertical) };
      })];
    }));
    return { id, type: layer.type as AnnotationLayer['type'], name: string(layer.name, 100), visible: bool(layer.visible), locked: bool(layer.locked), objects: contents };
  });
  return { version: 1, revision, visible: bool(value.visible), pages, layers };
}
export function imagePoint(x: number, y: number, rect: { left: number; top: number; width: number; height: number }, width: number, height: number): AnnotationPoint {
  return { x: Math.max(0, Math.min(width, (x - rect.left) * width / Math.max(1, rect.width))),
    y: Math.max(0, Math.min(height, (y - rect.top) * height / Math.max(1, rect.height))) };
}
export function strokeHit(point: AnnotationPoint, stroke: AnnotationStroke, tolerance: number): boolean {
  const distance = (p: AnnotationPoint): number => Math.hypot(point.x - p.x, point.y - p.y);
  const radius = stroke.width / 2 + tolerance;
  if (stroke.points.length === 1) return distance(stroke.points[0]!) <= radius;
  return stroke.points.slice(1).some((end, index) => {
    const start = stroke.points[index]!, dx = end.x - start.x, dy = end.y - start.y;
    const length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / length)) : 0;
    return distance({ x: start.x + t * dx, y: start.y + t * dy }) <= radius;
  });
}
export function layerCount(layer: AnnotationLayer): number { return Object.values(layer.objects).reduce((n, rows) => n + rows.length, 0); }
