import { useState } from 'react';
import type { ComicPage } from '@shared/types';
import type { AnnotationLayer, AnnotationText } from '@shared/annotations';
import { layerCount } from '@core/comic/annotations';
import type { AnnotationController } from './use-annotations';

import { Icon as ReaderToolIcon } from '../components/Icon';
export { ReaderToolIcon };

/** 普通底栏与沉浸浮动栏复用同一组工具及禁用条件。 */
export function ComicAnnotationQuickTools({ controller: c, page, immersive = false }: {
  controller: AnnotationController; page: ComicPage | undefined; immersive?: boolean;
}): JSX.Element {
  const pageAvailable = !page || !c.stalePages.includes(page.url);
  const canCreate = c.loaded && c.document.layers.length < 100 && pageAvailable;
  const eraserAvailable = c.loaded && !!c.eraserLayer && c.eraserLayer.visible && !c.eraserLayer.locked && pageAvailable && !!page && !!c.eraserLayer.objects[page.url]?.length;
  const drawing = c.editing && c.tool === 'pen';
  const erasing = c.editing && !c.textPlacement && c.tool === 'eraser';
  const writing = c.editing && c.tool === 'text';
  const prefix = immersive ? 'immersive-' : '';
  const buttonClass = `btn btn-sm${immersive ? ' immersive-icon-button' : ''}`;
  return <div className="annotation-quick-tools" role="group" aria-label="批注工具" data-editing={c.editing}>
    <button className={`${buttonClass}${!c.editing ? ' btn-primary' : ''}`} data-testid={`${prefix}annotation-read`} aria-label="返回阅读"
      aria-pressed={!c.editing} title="提交当前批注并返回阅读（保持沉浸）" onClick={event => { c.setEditing(false); event.currentTarget.blur(); }}><ReaderToolIcon kind="mouse" />{!immersive && '阅读'}</button>
    <button className={`${buttonClass}${c.editing && c.tool === 'select' ? ' btn-primary' : ''}`} disabled={!c.loaded || !pageAvailable} data-testid={`${prefix}annotation-select`}
      aria-pressed={c.editing && c.tool === 'select'} aria-label="选择和移动批注" title="点击批注选中，拖动移动；双击文字修改" onClick={c.useSelect}><ReaderToolIcon kind="select" />{!immersive && '选择'}</button>
    <button className={`${buttonClass}${drawing ? ' btn-primary' : ''}`} disabled={!canCreate && !(c.active?.type === 'pen' && c.active.visible && !c.active.locked && pageAvailable)} data-testid={`${prefix}annotation-pen`}
      aria-pressed={drawing} aria-label="画笔" title="在当前画笔层绘画；没有可用图层时，第一笔自动建层" onClick={c.usePen}><ReaderToolIcon kind="pen" />{!immersive && '画笔'}</button>
    <button className={`${buttonClass}${erasing ? ' btn-primary' : ''}`} disabled={!eraserAvailable} data-testid={`${prefix}annotation-eraser`}
      aria-pressed={erasing} aria-label="橡皮擦" onClick={c.useEraser}
      title={!c.eraserLayer ? '请先选中画笔图层' : `只擦除当前页「${c.eraserLayer.name}」中的完整笔划`}><ReaderToolIcon kind="eraser" />{!immersive && '橡皮擦'}</button>
    <button className={`${buttonClass}${writing ? ' btn-primary' : ''}`} disabled={!canCreate} data-testid={`${prefix}annotation-text`}
      aria-pressed={writing} aria-label="文字" title="点击空白处新建文字；点击已有文字修改；非空内容提交时建层" onClick={c.armText}><ReaderToolIcon kind="text" />{!immersive && '文字'}</button>
  </div>;
}

export function ComicAnnotationControls({ controller: c, page }: {
  controller: AnnotationController; page: ComicPage | undefined;
}): JSX.Element {
  const selected = c.active?.objects[page?.url ?? '']?.find(o => o.id === c.selectedId);
  const text = selected?.kind === 'text' ? selected : undefined;
  const textTool = c.textPlacement || c.active?.type === 'text';
  const drawing = c.editing && c.tool === 'pen';
  const style = { ...c.style, ...(text ? { color: text.color, opacity: text.opacity, fontSize: text.fontSize, background: text.background, vertical: text.vertical } : {}) };
  const patchStyle = (patch: Partial<typeof c.style>) => {
    c.setStyle({ ...c.style, ...patch });
    if (text && c.editing && page && c.activeId) c.putObject(c.activeId, page, { ...text, ...patch } as AnnotationText);
  };
  return <div className="annotation-controls" data-testid="annotation-controls">
    <div className="annotation-toolbar">
      <button className={`btn btn-sm${c.document.visible ? ' btn-primary' : ''}`} disabled={!c.loaded} data-testid="annotations-visible"
        aria-pressed={c.document.visible} onClick={() => { c.commit({ ...c.document, visible: !c.document.visible }); c.setEditing(false); }}>批注图层</button>
      <ComicAnnotationQuickTools controller={c} page={page} />
      {c.editing ? <>
        <span>{c.tool === 'text' ? '点击放置或修改文字 · Esc 取消草稿' : c.tool === 'select' ? '点击批注选中并移动' : c.active ? `${c.tool === 'eraser' ? '正在擦除' : '正在绘画'}：${c.active.name}` : '第一笔自动创建画笔图层'}</span>
        {drawing && <>
          <label>粗细 <input aria-label="画笔粗细" type="number" min="0.5" max="512" step="0.5" value={style.width} onChange={e => patchStyle({ width: Math.max(.5, Math.min(512, Number(e.target.value) || .5)) })} /></label>
        </>}
        {(drawing || textTool) && <>
        <label>颜色 <input type="color" aria-label="批注颜色" value={style.color} onChange={e => patchStyle({ color: e.target.value })} /></label>
        <label>不透明度 <input type="number" aria-label="批注不透明度" min="5" max="100" value={Math.round(style.opacity * 100)} onChange={e => patchStyle({ opacity: Math.max(.05, Math.min(1, Number(e.target.value) / 100)) })} />%</label>
        </>}
        {textTool && <>
          <label>字号 <input type="number" aria-label="批注字号" min="1" max="512" value={style.fontSize} onChange={e => patchStyle({ fontSize: Math.max(1, Math.min(512, Number(e.target.value) || 1)) })} /></label>
          <label><input type="checkbox" checked={style.vertical} onChange={e => patchStyle({ vertical: e.target.checked })} />竖排</label>
          <label><input type="checkbox" checked={!!style.background} onChange={e => patchStyle({ background: e.target.checked ? '#fff6b5' : null })} />背景</label>
          {style.background && <input type="color" aria-label="批注背景色" value={style.background} onChange={e => patchStyle({ background: e.target.value })} />}
          <span className="muted">双击改字 · 拖动移动 · 右下角调整文本框 · Ctrl+Enter 完成</span>
          {text && <button className="btn btn-sm" onClick={() => c.removeObject(c.activeId!, page!.url, text.id)}>删除选中文字</button>}
        </>}
        <button className="btn btn-sm btn-primary" data-testid="annotations-done" onClick={() => c.setEditing(false)}>返回阅读</button>
      </> : <span className="muted">画笔第一笔建层 · 文字点击放置</span>}
      <button className="btn btn-sm" disabled={!c.canUndo} onClick={c.undo} data-testid="annotations-undo" title="Ctrl+Z">撤销</button>
      <button className="btn btn-sm" disabled={!c.canRedo} onClick={c.redo} title="Ctrl+Shift+Z / Ctrl+Y">重做</button>
      <span className={`annotation-save${c.status === 'error' ? ' is-error' : ''}`} role="status" data-testid="annotations-save">
        {c.status === 'loading' ? '加载批注…' : c.status === 'saving' ? '正在保存…' : c.status === 'error' ? `${c.loaded ? '保存' : '读取'}失败：${c.error}` : '已保存'}
      </span>
      {c.status === 'error' && <><button className="btn btn-sm" onClick={c.retry}>重试保存</button>
        <button className="btn btn-sm" onClick={() => { if (window.confirm('重新读取将放弃本地未保存的修改，是否继续？')) c.reload(); }}>重新读取</button></>}
    </div>
    {page && c.stalePages.includes(page.url) && <div className="annotation-stale" role="alert">本页原图已变化，旧批注已隐藏。
      <button className="btn btn-sm" onClick={() => { if (window.confirm('清空本页所有图层的旧批注？其他页不受影响。')) c.clearPage(page.url); }}>清空本页旧批注</button>
    </div>}

  </div>;
}

export function ComicAnnotationManager({ controller: c, page, pageNumber, pages, onGoToPage }: {
  controller: AnnotationController; page: ComicPage | undefined; pageNumber: number; pages: ComicPage[]; onGoToPage: (index: number) => void;
}): JSX.Element {
  const [currentOnly, setCurrentOnly] = useState(true);
  const layers = [...c.document.layers].reverse().filter(layer => !currentOnly || !!page && Object.hasOwn(layer.objects, page.url));
  const canCreate = c.loaded && c.document.layers.length < 100 && (!page || !c.stalePages.includes(page.url));
  const reorder = (layer: AnnotationLayer, delta: number) => {
    const layers = [...c.document.layers], i = layers.findIndex(l => l.id === layer.id), j = i + delta;
    if (j < 0 || j >= layers.length) return;
    [layers[i], layers[j]] = [layers[j]!, layers[i]!]; c.commit({ ...c.document, layers });
  };
  return <div className="annotation-manager" data-testid="annotation-manager">
      <div className="annotation-toolbar">
        <strong>图层 · 第 {pageNumber} 页</strong>
        <label><input type="checkbox" checked={currentOnly} onChange={e => setCurrentOnly(e.target.checked)} />只看当前页</label>
        <button className="btn btn-sm" disabled={!canCreate} title="每本书最多 100 个图层" data-testid="annotations-new-pen" onClick={() => c.create('pen', page)}>＋画笔图层</button>
        <button className="btn btn-sm" disabled={!canCreate} title="每本书最多 100 个图层" data-testid="annotations-new-text" onClick={() => c.create('text', page)}>＋文字图层</button>
        <span className="muted">显示 {layers.length} / 全书 {c.document.layers.length} 层；点击页码查看内容。</span>
      </div>
      {!c.document.layers.length && <p className="muted">尚无图层，可以新建画笔或文字图层。</p>}
      {!layers.length && !!c.document.layers.length && <p className="muted">本页没有图层。取消“只看当前页”可查看全书图层。</p>}
      <div className="annotation-layer-list">{layers.map((layer) => <div key={layer.id}
        className={`annotation-layer-row${layer.id === c.activeId ? ' is-active' : ''}`} data-layer-id={layer.id}>
        <button className="btn btn-sm" aria-pressed={layer.visible} title="显示/隐藏图层" onClick={() => c.patchLayer(layer.id, { visible: !layer.visible })}>{layer.visible ? '显示' : '隐藏'}</button>
        <button className="btn btn-sm" aria-pressed={layer.locked} title="锁定/解锁图层" onClick={() => c.patchLayer(layer.id, { locked: !layer.locked })}>{layer.locked ? '已锁定' : '未锁定'}</button>
        <input aria-label="图层名称" maxLength={100} key={`${layer.id}:${layer.name}`} defaultValue={layer.name} onBlur={e => {
          const name = e.target.value.trim() || layer.name; if (name !== layer.name) c.patchLayer(layer.id, { name });
        }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
        <span>{layer.type === 'pen' ? '画笔' : '文字'} · 本页 {layer.objects[page?.url ?? '']?.length ?? 0} / 全书 {layerCount(layer)}</span>
        <div className="annotation-page-previews">{Object.entries(layer.objects).map(([url, objects]) => {
          const index = pages.findIndex(p => p.url === url), relatedPage = pages[index];
          return <button type="button" key={url} className={`annotation-page-preview${url === page?.url ? ' is-current' : ''}`} disabled={!relatedPage}
            title={objects.filter(o => o.kind === 'text').map(o => o.text).join(' / ') || `${objects.length} 笔画`} onClick={() => onGoToPage(index)}>
            <span>{index < 0 ? '原页已移除' : `第 ${index + 1} 页`}</span>
            {relatedPage && layer.type === 'pen' && <svg viewBox={`0 0 ${relatedPage.width} ${relatedPage.height}`} aria-label={`第 ${index + 1} 页画笔预览`}>
              {objects.map(o => o.kind === 'stroke' && (o.points.length === 1 ? <circle key={o.id} cx={o.points[0]!.x} cy={o.points[0]!.y} r={o.width / 2} fill={o.color} /> : <polyline key={o.id} points={o.points.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke={o.color} strokeWidth={o.width} strokeLinecap="round" />))}
            </svg>}
            {layer.type === 'text' && <span className="annotation-text-preview">{objects.filter(o => o.kind === 'text').map(o => o.text).join(' / ') || '尚无文字'}</span>}
            {layer.type === 'pen' && <small>{objects.length ? `${objects.length} 笔画` : '尚无笔迹'}</small>}
          </button>;
        })}{!Object.keys(layer.objects).length && <small>尚未关联页面</small>}</div>
        <button className="btn btn-sm" disabled={layer.locked || !layer.visible || !c.document.visible || !!page && c.stalePages.includes(page.url)}
          onClick={() => c.selectLayer(layer.id)}>选中</button>
        <details className="annotation-layer-more"><summary>更多操作</summary>
        <button className="btn btn-sm" title="上移图层" disabled={c.document.layers.at(-1)?.id === layer.id} onClick={() => reorder(layer, 1)}>上移</button>
        <button className="btn btn-sm" title="下移图层" disabled={c.document.layers[0]?.id === layer.id} onClick={() => reorder(layer, -1)}>下移</button>
        <button className="btn btn-sm" disabled={layer.locked || !page || !(layer.objects[page.url]?.length)} onClick={() => {
          if (page && window.confirm(`清空「${layer.name}」在当前页的内容？其他页不受影响。`)) c.clearPage(page.url, layer.id);
        }}>清空本页</button>
        <button className="btn btn-sm btn-danger" onClick={() => {
          if (window.confirm(`删除「${layer.name}」及其全书 ${layerCount(layer)} 个批注？`)) {
            c.removeLayer(layer.id);
          }
        }}>删除图层</button></details>
      </div>)}</div>
  </div>;
}
