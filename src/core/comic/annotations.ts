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

/** 检查橡皮移动整段轨迹，快速划过细笔迹时也能命中。 */
export function strokeHitSweep(start: AnnotationPoint, end: AnnotationPoint, stroke: AnnotationStroke, tolerance: number): boolean {
  if (strokeHit(start, stroke, tolerance) || strokeHit(end, stroke, tolerance)) return true;
  const sweep: AnnotationStroke = { ...stroke, width: .5, points: [start, end] };
  if (stroke.points.some(p => strokeHit(p, sweep, Math.max(0, stroke.width / 2 + tolerance - .25)))) return true;
  const cross = (a: AnnotationPoint, b: AnnotationPoint, p: AnnotationPoint) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  return stroke.points.slice(1).some((b, i) => {
    const a = stroke.points[i]!;
    return Math.max(a.x, b.x) >= Math.min(start.x, end.x) && Math.min(a.x, b.x) <= Math.max(start.x, end.x)
      && Math.max(a.y, b.y) >= Math.min(start.y, end.y) && Math.min(a.y, b.y) <= Math.max(start.y, end.y)
      && cross(start, end, a) * cross(start, end, b) <= 0 && cross(a, b, start) * cross(a, b, end) <= 0;
  });
}

/** 保留原始点用于存储/命中，以中点二次曲线显示连续笔迹。 */
export function strokePath(points: AnnotationPoint[]): string {
  if (!points.length) return '';
  const first = points[0]!;
  let path = `M ${first.x} ${first.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!, next = points[i + 1]!;
    path += ` Q ${p.x} ${p.y} ${(p.x + next.x) / 2} ${(p.y + next.y) / 2}`;
  }
  const last = points.at(-1)!;
  return `${path} L ${last.x} ${last.y}`;
}

/** 一次橡皮手势作为一个文档事务提交，保留隐藏/锁定内容及其他页面。 */
export function erasePageInk(document: ComicAnnotations, url: string, ids: Set<string>): ComicAnnotations {
  return { ...document, layers: document.layers.map(layer => {
    const objects = layer.objects[url];
    if (layer.type !== 'pen' || !layer.visible || layer.locked || !objects?.some(o => ids.has(o.id))) return layer;
    return { ...layer, objects: { ...layer.objects, [url]: objects.filter(o => !ids.has(o.id)) } };
  }) };
}
