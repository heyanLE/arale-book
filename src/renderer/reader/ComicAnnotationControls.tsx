import { useEffect, useRef } from 'react';
import type { ComicPage } from '@shared/types';
import type { AnnotationController } from './use-annotations';
import { Icon as ReaderToolIcon } from '../components/Icon';
export { ReaderToolIcon };

/** 普通底栏与沉浸浮动栏共用工具；参数紧邻画笔，页面上直接操作批注。 */
export function ComicAnnotationQuickTools({ controller: c, page, immersive = false }: {
  controller: AnnotationController; page: ComicPage | undefined; immersive?: boolean;
}): JSX.Element {
  const options = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (options.current && !options.current.contains(event.target as Node)) options.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing && options.current?.open) {
        event.preventDefault(); event.stopPropagation(); options.current.open = false;
        options.current.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', close);
    window.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape, true); };
  }, []);
  const available = c.loaded && !!page && !c.stalePages.includes(page.url);
  const canCreate = available && c.document.layers.length < 100;
  const canDraw = available && (canCreate || c.document.layers.some(l => l.type === 'pen' && l.visible && !l.locked));
  const canErase = available && c.document.layers.some(l => l.type === 'pen' && l.visible && !l.locked && !!l.objects[page!.url]?.length);
  const prefix = immersive ? 'immersive-' : '';
  const buttonClass = `btn btn-sm${immersive ? ' immersive-icon-button' : ''}`;
  const toolButton = (tool: typeof c.tool, label: string, icon: 'mouse' | 'select' | 'pen' | 'eraser' | 'text', disabled: boolean, title: string) =>
    <button className={`${buttonClass}${c.tool === tool ? ' btn-primary' : ''}`} disabled={disabled}
      data-testid={`${prefix}annotation-${tool}`} aria-label={label} aria-pressed={c.tool === tool} title={title}
      onClick={event => { c.setTool(c.tool === tool && tool !== 'read' ? 'read' : tool); event.currentTarget.blur(); }}>
      <ReaderToolIcon kind={icon} />{!immersive && (tool === 'read' ? '阅读' : tool === 'select' ? '选择' : label)}
    </button>;
  return <div className="annotation-quick-tools" role="group" aria-label="批注工具" data-editing={c.editing}>
    {toolButton('read', '返回阅读', 'mouse', false, '提交批注并恢复阅读、查词；保持沉浸')}
    {toolButton('select', '选择和移动批注', 'select', !available, '点击批注选中，拖动移动；双击文字修改')}
    <div className="annotation-pen-tools">
      {toolButton('pen', '画笔', 'pen', !canDraw, '直接绘画；再次点击画笔返回阅读')}
      <details className="annotation-pen-options" ref={options}>
        <summary className={buttonClass} aria-label="画笔设置" title="画笔颜色和粗细">▾</summary>
        <div className="annotation-pen-popover" role="group" aria-label="画笔设置">
          <strong>画笔</strong>
          <div className="annotation-color-presets">{['#d33828', '#1976d2', '#238636', '#e5a100', '#222222', '#ffffff'].map(color =>
            <button key={color} type="button" aria-label={`画笔颜色 ${color}`} aria-pressed={c.style.color === color}
              style={{ background: color }} onClick={() => c.setStyle({ ...c.style, color })} />)}</div>
          <label>自选颜色 <input type="color" aria-label="画笔颜色" value={c.style.color} onChange={e => c.setStyle({ ...c.style, color: e.target.value })} /></label>
          <label>粗细 <input type="range" aria-label="画笔粗细" min="1" max="48" value={c.style.width} onChange={e => c.setStyle({ ...c.style, width: Number(e.target.value) })} /><output>{c.style.width} px</output></label>
          <label>不透明度 <input type="range" aria-label="画笔不透明度" min="5" max="100" value={Math.round(c.style.opacity * 100)} onChange={e => c.setStyle({ ...c.style, opacity: Number(e.target.value) / 100 })} /><output>{Math.round(c.style.opacity * 100)}%</output></label>
        </div>
      </details>
    </div>
    {toolButton('eraser', '橡皮擦', 'eraser', !canErase && c.tool !== 'eraser', '划过笔迹擦除整笔；作用于本页所有可见、未锁定的笔迹')}
    {toolButton('text', '文字', 'text', !available || !canCreate && !c.document.layers.some(l => l.type === 'text' && l.visible && !l.locked), '点击空白处添加文字，点击已有文字修改')}
  </div>;
}

export function ComicAnnotationControls({ controller: c, page }: {
  controller: AnnotationController; page: ComicPage | undefined;
}): JSX.Element {
  return <div className="annotation-controls" data-testid="annotation-controls">
    <div className="annotation-toolbar">
      <ComicAnnotationQuickTools controller={c} page={page} />
      <button className="btn btn-sm" disabled={!c.canUndo} onClick={c.undo} data-testid="annotations-undo" title="Ctrl/Cmd+Z">撤销</button>
      <button className="btn btn-sm" disabled={!c.canRedo} onClick={c.redo} data-testid="annotations-redo" title="Ctrl/Cmd+Shift+Z / Ctrl+Y">重做</button>
      <button className="btn btn-sm" disabled={!c.loaded} data-testid="annotations-visible" aria-pressed={c.document.visible}
        onClick={c.toggleVisible}>{c.document.visible ? '隐藏批注' : '显示批注'}</button>
      <span className={`annotation-save${c.status === 'error' ? ' is-error' : ''}`} role="status" data-testid="annotations-save">
        {c.status === 'loading' ? '加载批注…' : c.status === 'saving' ? '正在保存…' : c.status === 'error' ? `${c.loaded ? '保存' : '读取'}失败：${c.error}` : '已保存'}
      </span>
      {c.status === 'error' && <><button className="btn btn-sm" onClick={c.retry}>重试</button>
        <button className="btn btn-sm" onClick={() => { if (window.confirm('重新读取将放弃本地未保存的修改，是否继续？')) c.reload(); }}>重新读取</button></>}
    </div>
    {page && c.stalePages.includes(page.url) && <div className="annotation-stale" role="alert">本页原图已变化，旧批注已隐藏。
      <button className="btn btn-sm" onClick={() => { if (window.confirm('清空本页所有图层的旧批注？其他页不受影响。')) c.clearPage(page.url); }}>清空本页旧批注</button>
    </div>}
  </div>;
}
