import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { ComicPage } from '@shared/types';
import type { AnnotationLayer, AnnotationPoint, AnnotationStroke, AnnotationText } from '@shared/annotations';
import { erasePageInk, imagePoint, strokeHitSweep, strokePath } from '@core/comic/annotations';
import { capturePointer } from '../lib/pointer';
import { registerAnnotationFinalizer, type AnnotationController } from './use-annotations';

export interface NewAnnotationText { id: string; pageUrl: string; point: AnnotationPoint; }
type Gesture = { kind: 'pen'; layerId: string; stroke: AnnotationStroke; newLayer?: AnnotationLayer }
  | { kind: 'eraser'; previous: AnnotationPoint; ids: Set<string> }
  | { kind: 'moveStroke'; layerId: string; start: AnnotationPoint; original: AnnotationStroke; stroke: AnnotationStroke }
  | { kind: 'move' | 'resize'; layerId: string; start: AnnotationPoint; original: AnnotationText; text: AnnotationText };
type TextDraft = { layerId: string; object: AnnotationText; isNew: boolean; newLayer?: AnnotationLayer; previousLayerId?: string | null };

/** SVG 坐标与原图一致；每个页面独立捕获手势，笔迹不会越过双页接缝。 */
export function ComicAnnotationCanvas({ page, controller: c, spaceHeld, newText, onActivate }: {
  page: ComicPage; controller: AnnotationController; spaceHeld: boolean; newText: NewAnnotationText | null; onActivate: () => void;
}): JSX.Element {
  const svg = useRef<SVGSVGElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const objectToolbar = useRef<HTMLDivElement>(null);
  const [toolbarPosition, setToolbarPosition] = useState({ left: 8, top: 8 });
  const latest = useRef(c); latest.current = c;
  const gesture = useRef<Gesture | null>(null);
  const draft = useRef<TextDraft | null>(null);
  const [preview, setPreview] = useState<Gesture | null>(null);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const stale = c.stalePages.includes(page.url);
  const editable = c.editing && !stale;
  const updateDraft = (value: TextDraft | null) => { draft.current = value; setTextDraft(value); };
  const finishText = (cancel = false) => {
    const value = draft.current; draft.current = null; setTextDraft(null);
    if (!value) return;
    if (cancel || !value.object.text.trim() && value.isNew) {
      if (value.newLayer) latest.current.setActiveId(value.previousLayerId ?? null);
      latest.current.setSelectedId(null); return;
    }
    if (!value.object.text.trim()) {
      if (!value.isNew) latest.current.removeObject(value.layerId, page.url, value.object.id);
    } else latest.current.putObject(value.layerId, page, value.object, value.newLayer);
  };
  const finishGesture = () => {
    const value = gesture.current; gesture.current = null; setPreview(null);
    if (!value) return;
    const current = latest.current;
    if (value.kind === 'pen') current.putObject(value.layerId, page, value.stroke, value.newLayer);
    else if (value.kind === 'moveStroke') {
      if (JSON.stringify(value.original) !== JSON.stringify(value.stroke)) current.putObject(value.layerId, page, value.stroke);
    }
    else if (value.kind === 'eraser') {
      if (!value.ids.size) return;
      current.commit(erasePageInk(current.document, page.url, value.ids));
    } else if (JSON.stringify(value.original) !== JSON.stringify(value.text)) current.putObject(value.layerId, page, value.text);
  };
  const point = (e: { clientX: number; clientY: number }) => imagePoint(e.clientX, e.clientY,
    svg.current!.getBoundingClientRect(), page.width, page.height);
  const beginText = (at: AnnotationPoint) => {
    finishText(); onActivate();
    const previousLayerId = latest.current.activeId;
    const prepared = latest.current.prepareLayer('text', page); if (!prepared) return;
    const layerId = prepared.layer.id;
    const style = latest.current.style;
    const width = Math.min(page.width, Math.max(1, style.fontSize * 8));
    const height = Math.min(page.height, Math.max(1, style.fontSize * 2));
    const object: AnnotationText = { id: crypto.randomUUID(), kind: 'text', x: Math.min(at.x, page.width - width),
      y: Math.min(at.y, page.height - height), width, height, text: '', fontSize: style.fontSize,
      color: style.color, opacity: style.opacity, vertical: style.vertical, background: style.background };
    latest.current.setSelectedId(object.id); updateDraft({ layerId, object, isNew: true, newLayer: prepared.isNew ? prepared.layer : undefined, previousLayerId });
  };
  const lastRequest = useRef<string | null>(null);
  useEffect(() => {
    if (!newText || newText.pageUrl !== page.url || newText.id === lastRequest.current || !editable) return;
    lastRequest.current = newText.id; beginText(newText.point);
  }, [newText, c.activeId, editable]);
  useEffect(() => { if (textDraft) { textarea.current?.focus(); } }, [textDraft?.object.id]);
  // 原生 textarea 处理选区、撤销及输入法；内容增多时扩展文本框，不缩放字号。
  useLayoutEffect(() => {
    const editor = textarea.current, value = draft.current;
    if (!editor || !value) return;
    const o = value.object;
    if (o.vertical) {
      editor.style.width = '1px';
      const width = Math.min(page.width - o.x, Math.max(o.width, editor.scrollWidth + 4));
      editor.style.width = '100%';
      if (width > o.width) updateDraft({ ...value, object: { ...o, width } });
    } else {
      editor.style.height = '1px';
      const height = Math.min(page.height - o.y, Math.max(o.height, editor.scrollHeight + 4));
      editor.style.height = '100%';
      if (height > o.height) updateDraft({ ...value, object: { ...o, height } });
    }
  }, [textDraft?.object.text, textDraft?.object.fontSize, textDraft?.object.vertical]);
  // 草稿跨失焦保留；返回系统输入法面板后由用户点击继续，不在 window.focus 抢焦点。
  useEffect(() => {
    if (!editable || (draft.current && draft.current.layerId !== c.activeId)) { finishText(); finishGesture(); }
  }, [editable, c.activeId]);
  // 页面切换、阅读器退出及 OCR 重建都提交已输入的内容。
  const finalizer = useRef(() => {}); finalizer.current = () => { finishText(); finishGesture(); };
  useEffect(() => {
    const finalize = () => finalizer.current();
    const unregister = registerAnnotationFinalizer(finalize);
    return () => { unregister(); finalize(); };
  }, []);
  const erase = (value: Extract<Gesture, { kind: 'eraser' }>, at: AnnotationPoint) => {
    const objects = latest.current.document.layers.filter(l => l.type === 'pen' && l.visible && !l.locked).flatMap(l => l.objects[page.url] ?? []);
    const rect = svg.current!.getBoundingClientRect();
    const tolerance = Math.max(3, 8 * page.width / Math.max(1, rect.width));
    for (const object of objects) if (object.kind === 'stroke' && strokeHitSweep(value.previous, at, object, tolerance)) value.ids.add(object.id);
    value.previous = at;
    setPreview({ ...value, ids: new Set(value.ids) });
  };
  const down = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!editable || spaceHeld || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation(); onActivate(); finishText();
    const at = point(e); c.setSelectedId(null);
    if (c.tool === 'text') { beginText(at); return; }
    if (c.tool === 'select') return;
    if (c.tool === 'eraser') {
      capturePointer(e.currentTarget, e.pointerId);
      const value: Gesture = { kind: 'eraser', previous: at, ids: new Set() };
      gesture.current = value; erase(value, at);
    } else {
      const prepared = c.prepareLayer('pen', page); if (!prepared) return;
      capturePointer(e.currentTarget, e.pointerId);
      const value: Gesture = { kind: 'pen', layerId: prepared.layer.id, newLayer: prepared.isNew ? prepared.layer : undefined, stroke: { id: crypto.randomUUID(), kind: 'stroke',
        color: c.style.color, width: c.style.width, opacity: c.style.opacity, points: [at] } };
      gesture.current = value; setPreview(value);
    }
  };
  const move = (e: ReactPointerEvent<SVGSVGElement>) => {
    const value = gesture.current; if (!value) return;
    e.preventDefault(); e.stopPropagation(); const at = point(e);
    if (value.kind === 'pen') {
      const samples = e.nativeEvent.getCoalescedEvents?.() ?? [];
      const points = [...value.stroke.points];
      for (const sample of [...samples, e]) {
        const next = point(sample), last = points.at(-1)!;
        if (Math.hypot(last.x - next.x, last.y - next.y) >= .5 && points.length < 20000) points.push(next);
      }
      value.stroke = { ...value.stroke, points }; setPreview({ ...value });
    } else if (value.kind === 'eraser') erase(value, at);
    else if (value.kind === 'moveStroke') {
      const points = value.original.points;
      const dx = Math.max(-Math.min(...points.map(p => p.x)), Math.min(page.width - Math.max(...points.map(p => p.x)), at.x - value.start.x));
      const dy = Math.max(-Math.min(...points.map(p => p.y)), Math.min(page.height - Math.max(...points.map(p => p.y)), at.y - value.start.y));
      capturePointer(svg.current!, e.pointerId);
      value.stroke = { ...value.original, points: points.map(p => ({ x: p.x + dx, y: p.y + dy })) }; setPreview({ ...value });
    }
    else {
      const dx = at.x - value.start.x, dy = at.y - value.start.y, old = value.original;
      if (Math.hypot(dx, dy) < 3 * page.width / Math.max(1, svg.current!.getBoundingClientRect().width)) return;
      // 单击不捕获到 SVG，否则浏览器会把 dblclick 的目标改成 SVG 而非文字。
      capturePointer(svg.current!, e.pointerId);
      value.text = value.kind === 'move' ? { ...old, x: Math.max(0, Math.min(page.width - old.width, old.x + dx)),
        y: Math.max(0, Math.min(page.height - old.height, old.y + dy)) }
        : { ...old, width: Math.max(1, Math.min(page.width - old.x, old.width + dx)),
          height: Math.max(1, Math.min(page.height - old.y, old.height + dy)) };
      setPreview({ ...value });
    }
  };
  const textDown = (e: ReactPointerEvent, layerId: string, object: AnnotationText, resize = false) => {
    if (stale || !c.loaded || !c.document.visible || !['read', 'select', 'text'].includes(c.tool) || spaceHeld || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation(); finishText(); onActivate(); c.setActiveId(layerId); c.setSelectedId(object.id);
    if (c.tool === 'read') { c.useSelect(); c.setSelectedId(object.id); return; }
    if (c.tool === 'text' && !resize) { updateDraft({ layerId, object, isNew: false }); return; }
    const value: Gesture = { kind: resize ? 'resize' : 'move', layerId, start: point(e), original: object, text: object };
    gesture.current = value; setPreview(value);
  };
  const drawStroke = (object: AnnotationStroke) => object.points.length === 1
    ? <circle key={object.id} cx={object.points[0]!.x} cy={object.points[0]!.y} r={object.width / 2} fill={object.color} opacity={object.opacity} />
    : <path key={object.id} d={strokePath(object.points)} fill="none" stroke={object.color}
      strokeWidth={object.width} strokeLinecap="round" strokeLinejoin="round" opacity={object.opacity} />;
  const selected = c.active?.objects[page.url]?.find(o => o.id === c.selectedId);
  const selectedText = textDraft?.object ?? (selected?.kind === 'text' ? selected : undefined);
  const canManage = editable && (textDraft || c.active?.visible && !c.active.locked && selected);
  useLayoutEffect(() => {
    if (!canManage || !svg.current || !objectToolbar.current) return;
    const reposition = () => {
      const rect = svg.current?.getBoundingClientRect(), toolbar = objectToolbar.current;
      if (!rect || !toolbar) return;
      const x = selectedText?.x ?? (selected?.kind === 'stroke' ? selected.points[0]!.x : 0);
      const y = selectedText?.y ?? (selected?.kind === 'stroke' ? selected.points[0]!.y : 0);
      const height = selectedText?.height ?? 24;
      let top = rect.top + (y + height) / page.height * rect.height + 8;
      if (top + toolbar.offsetHeight > window.innerHeight - 8) top = rect.top + y / page.height * rect.height - toolbar.offsetHeight - 8;
      const position = { left: Math.max(8, Math.min(window.innerWidth - toolbar.offsetWidth - 8, rect.left + x / page.width * rect.width)),
        top: Math.max(8, Math.min(window.innerHeight - toolbar.offsetHeight - 8, top)) };
      setToolbarPosition(old => old.left === position.left && old.top === position.top ? old : position);
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    observer.observe(svg.current); observer.observe(objectToolbar.current);
    window.addEventListener('resize', reposition); window.addEventListener('scroll', reposition, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true); };
  });
  const patchText = (patch: Partial<AnnotationText>) => {
    if (!selectedText) return;
    c.setStyle({ ...c.style, ...patch });
    if (draft.current) updateDraft({ ...draft.current, object: { ...draft.current.object, ...patch } });
    else if (c.activeId) c.putObject(c.activeId, page, { ...selectedText, ...patch });
  };
  const editSelected = () => {
    if (selected?.kind === 'text' && c.activeId) updateDraft({ layerId: c.activeId, object: selected, isNew: false });
  };
  const patchStroke = (patch: Partial<Pick<AnnotationStroke, 'color' | 'width' | 'opacity'>>) => {
    if (selected?.kind === 'stroke' && c.activeId) { c.setStyle({ ...c.style, ...patch }); c.putObject(c.activeId, page, { ...selected, ...patch }); }
  };
  return <><svg ref={svg} className={`comic-annotations${editable ? ' is-editing' : ''}${c.textPlacement ? ' is-placing-text' : ''}${spaceHeld ? ' is-panning' : ''}`}
    data-testid="comic-annotations" data-page-url={page.url} viewBox={`0 0 ${page.width} ${page.height}`}
    onPointerDown={down} onPointerMove={move} onPointerUp={e => { if (gesture.current) { e.stopPropagation(); finishGesture(); } }}
    onPointerCancel={() => { gesture.current = null; setPreview(null); }} onLostPointerCapture={finishGesture}>
    {c.document.visible && !stale && c.document.layers.filter(l => l.visible).map(layer => <g key={layer.id} data-layer-id={layer.id}>
      {(layer.objects[page.url] ?? []).map(stored => {
        if (preview?.kind === 'eraser' && preview.ids.has(stored.id)) return null;
        const canSelect = c.loaded && !stale && ['read', 'select'].includes(c.tool) && !layer.locked;
        if (stored.kind === 'stroke') {
          const object = preview?.kind === 'moveStroke' && preview.stroke.id === stored.id ? preview.stroke : stored;
          const xs = object.points.map(p => p.x), ys = object.points.map(p => p.y);
          return <g key={object.id} className={canSelect ? 'annotation-stroke-hit' : ''} data-object-id={object.id}
            role={canSelect ? 'button' : undefined} tabIndex={canSelect ? 0 : undefined} aria-label={canSelect ? '选择笔迹' : undefined}
            onKeyDown={e => { if (canSelect && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); c.useSelect(); c.setActiveId(layer.id); c.setSelectedId(object.id); onActivate(); } }} onPointerDown={e => {
            if (!canSelect || spaceHeld || e.button !== 0) return;
            e.preventDefault(); e.stopPropagation(); finishText(); onActivate(); c.setActiveId(layer.id); c.setSelectedId(object.id);
            if (c.tool === 'read') { c.useSelect(); c.setSelectedId(object.id); return; }
            const value: Gesture = { kind: 'moveStroke', layerId: layer.id, start: point(e), original: object, stroke: object };
            gesture.current = value; setPreview(value);
          }}>{canSelect && <path d={strokePath(object.points)} fill="none" stroke="transparent" strokeWidth={12} strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
          {drawStroke(object)}{canSelect && layer.id === c.activeId && object.id === c.selectedId && <rect className="annotation-selection"
            x={Math.min(...xs) - object.width / 2} y={Math.min(...ys) - object.width / 2}
            width={Math.max(...xs) - Math.min(...xs) + object.width} height={Math.max(...ys) - Math.min(...ys) + object.width} />}</g>;
        }
        if (textDraft?.object.id === stored.id) return null;
        const object = (preview?.kind === 'move' || preview?.kind === 'resize') && preview.text.id === stored.id ? preview.text : stored;
        const canEditText = c.loaded && !stale && ['read', 'select', 'text'].includes(c.tool) && !layer.locked;
        const selected = canSelect && layer.id === c.activeId && object.id === c.selectedId;
        return <g key={object.id} className={canEditText ? 'annotation-text-hit' : ''} data-object-id={object.id}
          role={canEditText ? 'button' : undefined} tabIndex={canEditText ? 0 : undefined} aria-label={canEditText ? `选择文字：${object.text.slice(0, 60)}` : undefined}
          onKeyDown={e => { if (canEditText && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); c.useSelect(); c.setActiveId(layer.id); c.setSelectedId(object.id); onActivate(); } }}
          onPointerDown={e => textDown(e, layer.id, object)} onDoubleClick={e => {
            if (!canEditText || spaceHeld) return;
            e.preventDefault(); e.stopPropagation(); finishGesture(); c.setActiveId(layer.id); c.setSelectedId(object.id); updateDraft({ layerId: layer.id, object, isNew: false });
          }}>
          <foreignObject x={object.x} y={object.y} width={object.width} height={object.height}>
            <div className="annotation-text" style={{ fontSize: object.fontSize, color: object.color, background: object.background ?? 'transparent',
              opacity: object.opacity, writingMode: object.vertical ? 'vertical-rl' : 'horizontal-tb' }}>{object.text}</div>
          </foreignObject>
          {selected && <><rect className="annotation-selection" x={object.x} y={object.y} width={object.width} height={object.height} />
            <rect className="annotation-resize" x={object.x + object.width - 12} y={object.y + object.height - 12} width={12} height={12}
              onPointerDown={e => textDown(e, layer.id, object, true)} /></>}
        </g>;
      })}
      {preview?.kind === 'pen' && preview.layerId === layer.id && drawStroke(preview.stroke)}
    </g>)}
    {preview?.kind === 'pen' && !c.document.layers.some(layer => layer.id === preview.layerId) && drawStroke(preview.stroke)}
    {textDraft && <foreignObject x={textDraft.object.x} y={textDraft.object.y} width={textDraft.object.width} height={textDraft.object.height}>
      <textarea ref={textarea} className="annotation-text-editor" aria-label="编辑文字批注" data-testid="annotation-text-editor"
        value={textDraft.object.text} maxLength={10000} style={{ fontSize: textDraft.object.fontSize, color: textDraft.object.color,
          background: textDraft.object.background ?? 'var(--bg-panel)', opacity: textDraft.object.opacity, writingMode: textDraft.object.vertical ? 'vertical-rl' : 'horizontal-tb' }}
        placeholder="输入批注…" onChange={e => updateDraft({ ...textDraft, object: { ...textDraft.object, text: e.target.value } })}
        onPointerDown={e => e.stopPropagation()} onContextMenu={e => e.stopPropagation()}
        onKeyDown={e => {
          e.stopPropagation(); if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Escape') { e.preventDefault(); finishText(true); }
          else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finishText(); }
        }} />
    </foreignObject>}
  </svg>
    {canManage && createPortal(<div ref={objectToolbar} className="annotation-object-toolbar" role="group" aria-label="当前批注" data-testid="annotation-object-toolbar"
      style={toolbarPosition} onContextMenu={e => e.stopPropagation()}
      onPointerDown={e => { e.stopPropagation(); if (!(e.target as HTMLElement).closest('input, select')) e.preventDefault(); }}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); if (textDraft) finishText(true); else c.setSelectedId(null); } }}>
      {selectedText && <>
        <label>颜色 <input aria-label="文字颜色" type="color" value={selectedText.color} onChange={e => patchText({ color: e.target.value })} /></label>
        <label>字号 <input aria-label="文字字号" type="number" min="1" max="512" value={selectedText.fontSize} onChange={e => patchText({ fontSize: Math.max(1, Math.min(512, Number(e.target.value) || 1)) })} /></label>
        <label>排版 <select aria-label="文字排版" value={selectedText.vertical ? 'vertical' : 'horizontal'} onChange={e => patchText({ vertical: e.target.value === 'vertical' })}><option value="horizontal">横排</option><option value="vertical">竖排</option></select></label>
        <label>不透明度 <input aria-label="文字不透明度" type="number" min="5" max="100" value={Math.round(selectedText.opacity * 100)} onChange={e => patchText({ opacity: Math.max(.05, Math.min(1, Number(e.target.value) / 100)) })} />%</label>
        <label>背景 <input aria-label="文字背景" type="checkbox" checked={!!selectedText.background} onChange={e => patchText({ background: e.target.checked ? '#fff6b5' : null })} /></label>
        {selectedText.background && <input aria-label="文字背景色" type="color" value={selectedText.background} onChange={e => patchText({ background: e.target.value })} />}
      </>}
      {!selectedText && selected?.kind === 'stroke' && <>
        <label>颜色 <input aria-label="笔迹颜色" type="color" value={selected.color} onChange={e => patchStroke({ color: e.target.value })} /></label>
        <label>粗细 <input aria-label="笔迹粗细" type="number" min=".5" max="512" step=".5" value={selected.width} onChange={e => patchStroke({ width: Math.max(.5, Math.min(512, Number(e.target.value) || .5)) })} /></label>
        <label>不透明度 <input aria-label="笔迹不透明度" type="number" min="5" max="100" value={Math.round(selected.opacity * 100)} onChange={e => patchStroke({ opacity: Math.max(.05, Math.min(1, Number(e.target.value) / 100)) })} />%</label>
      </>}
      {textDraft ? <>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => finishText()} title="Ctrl/Cmd+Enter">完成</button>
        <button type="button" className="btn btn-sm" onClick={() => finishText(true)} title="Esc">取消</button>
      </> : <>
        {selectedText && <button type="button" className="btn btn-sm" onClick={editSelected}>编辑文字</button>}
        <button type="button" className="btn btn-sm btn-danger" onClick={() => { if (c.activeId && selected) c.removeObject(c.activeId, page.url, selected.id); }}>删除批注</button>
        <button type="button" className="btn btn-sm" aria-label="取消选择" onClick={() => c.setSelectedId(null)}>×</button>
      </>}
    </div>, document.body)}
  </>;
}
