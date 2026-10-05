import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ComicPage } from '@shared/types';
import type { AnnotationLayer, AnnotationObject, ComicAnnotations } from '@shared/annotations';
import { AnnotationStore } from '@core/comic/annotation-store';
import { api } from '../lib/api';

const stores = new Map<string, AnnotationStore>();
const finalizers = new Set<() => void>();
function finalizeAnnotations(): void { for (const finalize of finalizers) finalize(); }
export function registerAnnotationFinalizer(finalize: () => void): () => void {
  finalizers.add(finalize); return () => { finalizers.delete(finalize); };
}
window.addEventListener('beforeunload', event => {
  // window 自身的监听顺序不能依赖捕获/冒泡；先显式提交页面草稿再检查保存队列。
  finalizeAnnotations();
  if ([...stores.values()].some(store => store.pending())) {
    for (const store of stores.values()) void store.save();
    event.preventDefault(); event.returnValue = '批注尚未保存，请稍候或重试保存。';
  }
});

export function useAnnotations(bookId: string) {
  let store = stores.get(bookId);
  if (!store) { store = new AnnotationStore(bookId, api.annotations); stores.set(bookId, store); }
  const current = store;
  const state = useSyncExternalStore(current.subscribe, current.snapshot);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [tool, setToolState] = useState<'read' | 'select' | 'pen' | 'eraser' | 'text'>('read');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [style, setStyle] = useState({ color: '#d33828', width: 8, opacity: 1, fontSize: 30, background: null as string | null, vertical: false });
  const active = state.document.layers.find(l => l.id === activeId);
  const eraserLayer = active?.type === 'pen' ? active : undefined;
  const isEditing = tool !== 'read' && state.document.visible && state.loaded;
  const setActiveId = setActiveIdState;
  const setTool = (next: typeof tool) => {
    if (next === tool) return;
    finalizeAnnotations();
    if (next !== 'read' && !current.state.document.visible) current.commit({ ...current.state.document, visible: true });
    setToolState(next); setSelectedId(null);
  };
  const setEditing = (value: boolean) => setTool(value ? 'select' : 'read');
  useEffect(() => {
    setActiveIdState(null); setToolState('read'); setSelectedId(null);
    if (current.state.loaded && !current.pending()) void current.reload();
  }, [bookId]);
  const patchLayer = (id: string, patch: Partial<AnnotationLayer>) => {
    if (patch.locked === true || patch.visible === false) {
      finalizeAnnotations();
      if (id === activeId) { setToolState('read'); setSelectedId(null); }
    }
    current.commit({ ...current.state.document, layers: current.state.document.layers.map(l => l.id === id ? { ...l, ...patch } : l) });
  };
  const makeLayer = (type: AnnotationLayer['type'], page?: ComicPage): AnnotationLayer | null => {
    const id = crypto.randomUUID(), doc = current.state.document;
    if (!current.state.loaded || doc.layers.length >= 100) return null;
    return { id, type, name: `${type === 'pen' ? '画笔' : '文字注释'} ${doc.layers.filter(l => l.type === type).length + 1}`, visible: true, locked: false, objects: page ? { [page.url]: [] } : {} };
  };
  const create = (type: AnnotationLayer['type'], page?: ComicPage): string | null => {
    finalizeAnnotations();
    const layer = makeLayer(type, page); if (!layer) return null;
    const doc = current.state.document, id = layer.id;
    current.commit({ ...doc, visible: true, layers: [...doc.layers, layer] });
    setActiveId(id); setToolState(type); setSelectedId(null);
    return id;
  };
  // 工具不建层；第一笔/非空文字与自动创建的图层一起提交，只占一次撤销。
  const prepareLayer = (type: AnnotationLayer['type'], page: ComicPage) => {
    const layer = current.state.document.layers.find(l => l.id === activeId);
    if (layer?.type === type && layer.visible && !layer.locked &&
      (type === 'pen' || !Object.values(layer.objects).some(objects => objects.length))) return { layer, isNew: false };
    const created = makeLayer(type, page); if (!created) return null;
    setActiveId(created.id); return { layer: created, isNew: true };
  };
  const armText = () => setTool('text');
  const usePen = () => setTool('pen');
  const useSelect = () => setTool('select');
  const selectLayer = (id: string) => { finalizeAnnotations(); setActiveId(id); setToolState('select'); setSelectedId(null); };
  const useEraser = () => {
    const doc = current.state.document, layer = doc.layers.find(l => l.id === eraserLayer?.id);
    if (!current.state.loaded || !layer || layer.locked || !layer.visible) return;
    setTool('eraser');
  };
  const putObject = (layerId: string, page: ComicPage, object: AnnotationObject, newLayer?: AnnotationLayer) => {
    const doc = current.state.document;
    const layers = doc.layers.some(l => l.id === layerId) ? doc.layers : newLayer && doc.layers.length < 100 ? [...doc.layers, newLayer] : doc.layers;
    if (!layers.some(l => l.id === layerId && l.visible && !l.locked)) return;
    current.commit({ ...doc, pages: { ...doc.pages, [page.url]: doc.pages[page.url] ?? { width: page.width, height: page.height, signature: '' } },
      layers: layers.map(l => l.id === layerId ? { ...l, objects: { ...l.objects, [page.url]: [...(l.objects[page.url] ?? []).filter(o => o.id !== object.id), object] } } : l) });
  };
  const removeObject = (layerId: string, url: string, objectId: string) => {
    const layer = current.state.document.layers.find(l => l.id === layerId); if (!layer) return;
    patchLayer(layerId, { objects: { ...layer.objects, [url]: (layer.objects[url] ?? []).filter(o => o.id !== objectId) } });
    setSelectedId(null);
  };
  const clearPage = (url: string, layerId?: string) => {
    finalizeAnnotations();
    const doc = current.state.document;
    current.commit({ ...doc, layers: doc.layers.map(l => !layerId || l.id === layerId ? { ...l, objects: { ...l.objects, [url]: [] } } : l) });
    setSelectedId(null);
  };
  const removeLayer = (id: string) => {
    finalizeAnnotations();
    const doc = current.state.document;
    current.commit({ ...doc, layers: doc.layers.filter(layer => layer.id !== id) });
    if (id === activeId) { setActiveId(null); setToolState('read'); setSelectedId(null); }
  };
  return { ...state, active, activeId, setActiveId, editing: isEditing, setEditing, textPlacement: tool === 'text', armText, usePen, useSelect, selectLayer, eraserLayer, useEraser, tool, setTool, selectedId, setSelectedId, style, setStyle,
    create, prepareLayer, patchLayer, putObject, removeObject, removeLayer, clearPage, commit: (doc: ComicAnnotations) => current.commit(doc),
    canUndo: state.undo, canRedo: state.redo, undo: () => { finalizeAnnotations(); current.undo(); setSelectedId(null); }, redo: () => { finalizeAnnotations(); current.redo(); setSelectedId(null); }, retry: () => current.state.loaded ? void current.save() : void current.reload(), reload: () => void current.reload(),
  };
}
export type AnnotationController = ReturnType<typeof useAnnotations>;
