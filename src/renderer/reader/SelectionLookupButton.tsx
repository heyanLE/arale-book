import { useCallback, useEffect, useRef, useState } from 'react';

export interface SelectionPoint { x: number; y: number }

export function useSelectionAction<T>(resetKey: unknown) {
  const [pending, setPending] = useState<{ payload: T; point: SelectionPoint } | null>(null);
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  const dismiss = useCallback(() => { version.current++; setPending(null); setBusy(false); }, []);
  const show = useCallback((payload: T, point: SelectionPoint) => {
    version.current++; setPending({ payload, point }); setBusy(false);
  }, []);
  useEffect(() => { dismiss(); }, [resetKey, dismiss]);
  useEffect(() => () => { version.current++; }, []);
  async function confirm(action: (payload: T, isCurrent: () => boolean) => Promise<void>): Promise<void> {
    if (!pending || busy) return;
    const current = version.current;
    setBusy(true);
    const isCurrent = () => version.current === current;
    try { await action(pending.payload, isCurrent); }
    finally { if (isCurrent()) dismiss(); }
  }
  return { pending, busy, dismiss, show, confirm };
}

/** Selection stays highlighted; lookup starts only after this explicit action. */
export function SelectionLookupButton({ point, busy, onConfirm, onDismiss, onExcerpt }: {
  point: SelectionPoint; busy: boolean; onConfirm: () => void; onDismiss: () => void; onExcerpt?: () => void;
}): JSX.Element {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) onDismiss(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault(); event.stopPropagation(); onDismiss();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('scroll', onDismiss, true);
    window.addEventListener('resize', onDismiss);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('scroll', onDismiss, true);
      window.removeEventListener('resize', onDismiss);
    };
  }, [onDismiss]);
  return <div ref={menu} className="selection-action-menu" role="group" aria-label="所选文字操作"
    style={{ left: Math.max(6, Math.min(point.x + 10, window.innerWidth - (onExcerpt ? 154 : 78))), top: Math.max(6, Math.min(point.y + 10, window.innerHeight - 34)) }}
    onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }}>
    <button type="button" className="btn" data-testid="selection-lookup-button" aria-label="查所选文字" disabled={busy} onClick={onConfirm}>{busy ? '查询中' : '查词'}</button>
    {onExcerpt && <button type="button" className="btn" disabled={busy} onClick={onExcerpt}>摘录 / 笔记</button>}
  </div>;
}
