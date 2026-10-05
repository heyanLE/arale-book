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
export function SelectionLookupButton({ point, busy, onConfirm, onDismiss }: {
  point: SelectionPoint; busy: boolean; onConfirm: () => void; onDismiss: () => void;
}): JSX.Element {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!button.current?.contains(event.target as Node)) onDismiss(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
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
  return <button ref={button} type="button" className="btn selection-lookup-button" data-testid="selection-lookup-button"
    aria-label="查所选文字" title="查所选文字" disabled={busy}
    style={{ left: Math.max(6, Math.min(point.x + 10, window.innerWidth - 78)), top: Math.max(6, Math.min(point.y + 10, window.innerHeight - 34)) }}
    onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={onConfirm}>
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg>
    {busy ? '查询中' : '查词'}
  </button>;
}
